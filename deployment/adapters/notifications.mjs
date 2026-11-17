import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PROTOCOL_REVISION } from '@haip/protocol';
import { digest, parseJson, verifyRecord } from '@haip/protocol/crypto';
import { verifyWebhook } from '@haip/sdk';
import { callApi, expect, label, operatorControl, uuid } from './authority-probes.mjs';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';

const checkId = 'notifications';
const tokenName = 'HAIP_ACCEPTANCE_NOTIFICATION_PRODUCER_TOKEN';
const hash = /^sha256:[a-f0-9]{64}$/;

function https(value) {
  const target = new URL(value);
  expect(
    target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      !target.hash &&
      !target.search,
  );
  return target;
}

function validate(plan, planDigest, settings, fixture) {
  const origin = https(plan.deployment.trusted_origin);
  const replay = https(settings.replay_endpoint);
  const redirect = https(settings.redirect_target);
  expect(
    plan.deployment.trusted_origin === origin.origin &&
      plan.deployment.protocol_revision === PROTOCOL_REVISION &&
      settings.plan_digest === planDigest &&
      replay.origin !== origin.origin &&
      redirect.origin !== origin.origin &&
      redirect.href !== replay.href &&
      [settings.review_id, settings.expired_request_id, settings.probe_id].every(
        (value) => typeof value === 'string' && uuid.test(value),
      ) &&
      settings.review_id !== settings.expired_request_id &&
      [settings.tenant, settings.producer, settings.requester, settings.reviewer].every(
        (value) => typeof value === 'string' && label.test(value),
      ) &&
      settings.requester !== settings.reviewer &&
      typeof settings.recipient === 'string' &&
      /^[^\s<>@]+@[^\s<>@]+$/.test(settings.recipient) &&
      settings.recipient.length <= 254 &&
      settings.trust_manifest?.issuer === origin.origin &&
      settings.trust_manifest.protocol_revision === PROTOCOL_REVISION &&
      Array.isArray(settings.trust_manifest.keys) &&
      settings.trust_manifest.keys.length > 0 &&
      settings.trust_manifest.keys.length <= 128,
  );
  if (fixture)
    expect(
      Buffer.isBuffer(fixture.ca) &&
        [origin, replay, redirect].every((url) => url.hostname.endsWith('.test')) &&
        fixture.pins?.length > 0 &&
        typeof fixture.signIn === 'function' &&
        typeof fixture.confirm === 'function',
    );
  return { origin, replay, redirect };
}

async function waitFor(read, window = 45_000) {
  const deadline = performance.now() + window;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(500);
  }
  throw new Error('No matching notification observation before the deadline');
}

function markedReview(status, settings) {
  const { request } = status;
  expect(
    request?.id === settings.review_id &&
      request.protocol_revision === PROTOCOL_REVISION &&
      request.tenant === settings.tenant &&
      request.producer === settings.producer &&
      request.purpose === 'review' &&
      request.execution === undefined &&
      request.requester?.source === 'operator_directory' &&
      request.requester.subject === settings.requester &&
      typeof request.route === 'string' &&
      label.test(request.route) &&
      request.metadata?.haip_acceptance_fixture === checkId &&
      request.metadata.haip_acceptance_probe === settings.probe_id &&
      digest(request) === status.request_digest,
  );
  return request;
}

async function browserJson(page, path, csrf) {
  return page.evaluate(
    async ({ path, csrf }) => {
      const response = await fetch(path, {
        redirect: 'error',
        ...(csrf
          ? {
              method: 'POST',
              headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
              body: '{}',
            }
          : {}),
      });
      return {
        status: response.status,
        body: response.status === 200 ? await response.json() : null,
      };
    },
    { path, csrf },
  );
}

async function openReview(browser, review, subject, fixture) {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  context.setDefaultTimeout(8000);
  if (fixture)
    await context.route('**/*', (route) => {
      const origin = new URL(route.request().url()).origin;
      return [review.origin, fixture.issuer].includes(origin) ? route.continue() : route.abort();
    });
  const page = await context.newPage();
  const blocked = page.waitForResponse(
    (result) => result.url() === review.href && result.request().isNavigationRequest(),
    { timeout: 10_000 },
  );
  const [gate] = await Promise.all([
    blocked,
    page.goto(review.href, { waitUntil: 'domcontentloaded', timeout: 10_000 }),
  ]);
  const login = new URL('/auth/login', review);
  login.searchParams.set('return_to', review.pathname);
  expect(
    gate.status() === 302 &&
      new URL(await gate.headerValue('location'), review).href === login.href &&
      !(await gate.headerValues('set-cookie')).length,
  );
  if (fixture) await fixture.signIn(page, subject);
  else {
    await page.bringToFront();
    console.error('Sign in as the test account ' + subject + '.');
  }
  await page.waitForURL(review.href, {
    waitUntil: 'domcontentloaded',
    timeout: fixture ? 10_000 : 100_000,
  });
  const { status, body: session } = await browserJson(page, '/auth/session');
  expect(
    status === 200 &&
      session.subject === subject &&
      typeof session.csrf === 'string' &&
      session.csrf.length > 20,
  );
  return { context, page, session };
}

function requireReceipt(status, settings, origin) {
  const request = markedReview(status, settings);
  const { receipt } = status;
  expect(
    status.decision_state === 'confirmed' &&
      status.grant_state === 'not_applicable' &&
      receipt?.payload?.request_id === request.id &&
      receipt.payload.request_digest === status.request_digest &&
      receipt.payload.requester === settings.requester &&
      receipt.payload.reviewer === settings.reviewer &&
      receipt.payload.purpose === 'review',
  );
  verifyRecord(
    receipt,
    settings.trust_manifest,
    {
      issuer: origin.origin,
      tenant: settings.tenant,
      audience: settings.producer,
      purpose: 'review',
      type: 'DecisionReceipt',
    },
    new Date(),
  );
  expect(digest(receipt.protected.profiles) === digest(request.profiles));
  return receipt;
}

function acceptedDelivery(observed, trust, identity, requestId) {
  const committed = Date.parse(observed?.committed_at);
  const acknowledged = Date.parse(observed?.acknowledged_at);
  expect(
    Number.isFinite(committed) &&
      Number.isFinite(acknowledged) &&
      committed <= acknowledged &&
      acknowledged <= Date.now() + 30_000 &&
      committed >= Date.parse(observed.envelope?.payload?.timestamp) - 30_000,
  );
  const verified = verifyWebhook(observed.envelope, trust, identity, acknowledged);
  expect(
    verified.event.protected.purpose === 'review' &&
      verified.event.payload.request_id === requestId,
  );
  return { envelope: observed.envelope, event: verified.event };
}

function verifyInbox(state, events) {
  expect(
    Array.isArray(state?.rows) &&
      state.rows.length === events.length &&
      state.pending_revision === Math.max(...events.map(({ payload }) => payload.revision)),
  );
  for (const event of events)
    expect(
      state.rows.some(
        (row) =>
          row.event_id === event.payload.event_id &&
          row.revision === event.payload.revision &&
          row.event_digest === digest(event),
      ),
    );
}

function redirectInput(route, probe) {
  const payload = { message: 'Notification redirect test' };
  return {
    protocol_revision: PROTOCOL_REVISION,
    purpose: 'review',
    profiles: {},
    route,
    summary: payload.message,
    artefact: {
      digest: digest(payload),
      representation: 'application/json',
      digest_rules: 'rfc8785-sha256',
    },
    payload,
    review_document: payload.message,
    response_schema: { type: 'object' },
    metadata: {
      haip_acceptance_fixture: checkId,
      haip_acceptance_probe: probe,
      haip_acceptance_role: 'redirect',
    },
  };
}

export async function collectNotifications(
  planPath,
  evidencePath,
  settingsPath,
  { environment = process.env, fixture } = {},
) {
  const { plan, digest: planDigest } = await readAcceptancePlan(planPath);
  const { bytes, document: settings } = await readJsonDocument(settingsPath);
  const directory = await privateDirectory(evidencePath);
  const assertions = [];
  const facts = { scope: fixture ? 'local_fixture' : 'isolated_deployment' };
  const pass = (name, detail) => assertions.push({ name, passed: true, detail });
  let browser;
  let stage = 'settings';
  let status = 'failed';
  try {
    expect((environment.HAIP_ACCEPTANCE_CHECK_ID ?? checkId) === checkId);
    const { origin, replay, redirect } = validate(plan, planDigest, settings, fixture);
    const token = environment[tokenName];
    expect(typeof token === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(token));
    const control = operatorControl(settings, environment, [tokenName]);
    const operate = (action, ...args) => control(action, settings.probe_id, planDigest, ...args);
    const observe = async (action, ...args) => parseJson((await operate(action, ...args)).stdout);
    const api = callApi(origin, token, fixture?.ca);
    const receiver = callApi(replay.origin, undefined, fixture?.ca);
    const identity = {
      issuer: origin.origin,
      tenant: settings.tenant,
      producer: settings.producer,
    };
    const trust = settings.trust_manifest;
    const review = new URL('/review/' + settings.review_id, origin);
    const path = '/v2/requests/' + settings.review_id;

    stage = 'pending_review';
    const initial = await api(path);
    expect(
      initial.status === 200 &&
        initial.body.decision_state === 'pending' &&
        initial.body.receipt === null &&
        initial.body.review_link === review.href,
    );
    const request = markedReview(initial.body, settings);
    pass(stage, 'The producer could read the marked and pending review before the exercise.');

    stage = 'requester_logout';
    browser = await chromium.launch({
      channel: 'chromium',
      headless: !!fixture,
      timeout: 10_000,
      ...(fixture
        ? {
            args: [
              '--host-resolver-rules=MAP *.test 127.0.0.1',
              '--ignore-certificate-errors-spki-list=' + fixture.pins.join(','),
            ],
          }
        : {}),
    });
    const owner = await openReview(browser, review, settings.requester, fixture);
    const cookie = (await owner.context.cookies([review.href])).find(
      ({ name }) => name === '__Host-haip',
    );
    expect(
      cookie?.secure &&
        cookie.httpOnly &&
        (await browserJson(owner.page, '/auth/logout', owner.session.csrf)).status === 204,
    );
    await owner.context.addCookies([cookie]);
    expect((await browserJson(owner.page, '/auth/session')).status === 401);
    await owner.context.close();
    pass(stage, 'The requester signed out and the previous authenticated session was refused.');

    stage = 'reviewer_confirmation';
    const reviewer = await openReview(browser, review, settings.reviewer, fixture);
    if (fixture) await fixture.confirm(reviewer.page);
    else console.error('Confirm the disposable review in the reviewer tab.');
    const confirmed = await waitFor(
      async () => {
        const result = await api(path);
        expect(result.status === 200);
        return result.body.decision_state === 'confirmed' ? result.body : null;
      },
      fixture ? 10_000 : 100_000,
    );
    const receipt = requireReceipt(confirmed, settings, origin);
    facts.receipt_digest = digest(receipt);
    await reviewer.context.close();
    pass(stage, 'The reviewer confirmed the review through the authenticated host.');

    stage = 'mail_reopen';
    const mail = await waitFor(() => observe('mail', settings.review_id));
    expect(
      mail.recipient === settings.recipient &&
        mail.review_link === review.href &&
        hash.test(mail.message_digest ?? '') &&
        Date.parse(mail.received_at) >= Date.parse(receipt.payload.confirmed_at) &&
        Date.parse(mail.received_at) <= Date.now() + 30_000,
    );
    await waitFor(async () => {
      const result = await api(path);
      expect(result.status === 200);
      return result.body.delivery.some(
        ({ kind, state }) => kind === 'smtp' && state === 'accepted',
      );
    });
    const returned = await openReview(
      browser,
      new URL(mail.review_link),
      settings.requester,
      fixture,
    );
    const resumed = await browserJson(returned.page, path);
    expect(
      resumed.status === 200 &&
        digest(requireReceipt(resumed.body, settings, origin)) === facts.receipt_digest,
    );
    facts.mail_digest = mail.message_digest;
    await returned.context.close();
    pass(
      stage,
      'The test mailbox received the ordinary link, which required sign-in and reopened the same signed receipt.',
    );

    stage = 'webhook_delivery';
    const delivered = await waitFor(() => observe('deliveries', settings.review_id));
    const older = acceptedDelivery(delivered.created, trust, identity, settings.review_id);
    const newer = acceptedDelivery(delivered.decision, trust, identity, settings.review_id);
    const stream = await api('/v2/events');
    expect(
      stream.status === 200 &&
        Array.isArray(stream.body.items) &&
        older.event.payload.reason === 'created' &&
        newer.event.payload.reason === 'decision' &&
        newer.event.payload.revision > older.event.payload.revision &&
        [older, newer].every(({ event }) =>
          stream.body.items.some((item) => digest(item) === digest(event)),
        ),
    );
    pass(
      stage,
      'The receiver committed both signed events before acknowledging them, and both matched the producer event stream.',
    );

    stage = 'webhook_replay';
    const before = await observe('replay_state', settings.review_id);
    expect(
      Array.isArray(before?.rows) && before.rows.length === 0 && before.pending_revision === 0,
    );
    const events = [newer.event, older.event];
    for (const { envelope } of [newer, newer, older]) {
      verifyWebhook(envelope, trust, identity);
      const reply = await receiver(replay.pathname, envelope);
      expect(reply.status >= 200 && reply.status < 300);
    }
    const committed = await observe('replay_state', settings.review_id);
    verifyInbox(committed, events);
    const current = await api(path);
    expect(
      current.status === 200 &&
        digest(requireReceipt(current.body, settings, origin)) === facts.receipt_digest &&
        Number.isSafeInteger(current.body.revision) &&
        current.body.revision >= committed.pending_revision,
    );
    facts.receiver_revision = committed.pending_revision;
    facts.status_revision = current.body.revision;
    pass(
      stage,
      'Reverse delivery order and a duplicate left two durable events and the highest revision. The producer fetched current status.',
    );

    stage = 'expired_webhook';
    const expired = await observe('expired', settings.expired_request_id);
    const issuedAt = Date.parse(expired?.payload?.timestamp);
    const stale = verifyWebhook(expired, trust, identity, issuedAt);
    expect(
      stale.event.payload.request_id === settings.expired_request_id &&
        stale.event.protected.purpose === 'review' &&
        Date.now() - issuedAt >= 300_000,
    );
    const refused = await receiver(replay.pathname, expired);
    expect([400, 401, 403, 409, 422].includes(refused.status));
    verifyInbox(await observe('replay_state', settings.review_id), events);
    const expiredState = await observe('replay_state', settings.expired_request_id);
    expect(
      Array.isArray(expiredState?.rows) &&
        expiredState.rows.length === 0 &&
        expiredState.pending_revision === 0,
    );
    facts.expired_status = refused.status;
    pass(
      stage,
      'The receiver refused a correctly signed delivery beyond the five-minute window and stored no event for it.',
    );

    stage = 'redirect_refused';
    try {
      await operate('arm_redirect', redirect.href);
      const { status: created, body } = await api(
        '/v2/requests',
        redirectInput(request.route, settings.probe_id),
      );
      expect(created === 201 && typeof body.request?.id === 'string' && uuid.test(body.request.id));
      const id = body.request.id;
      const observed = await waitFor(() => observe('redirect', id));
      const original = verifyWebhook(observed.envelope, trust, identity);
      expect(
        original.event.payload.request_id === id &&
          original.event.payload.reason === 'created' &&
          observed.location === redirect.href &&
          observed.response_status >= 300 &&
          observed.response_status < 400,
      );
      const failure = await waitFor(async () => {
        const { status, body } = await api('/v2/requests/' + id);
        expect(status === 200 && body.request.metadata.haip_acceptance_role === 'redirect');
        const jobs = body.delivery.filter(({ kind }) => kind === 'webhook');
        expect(jobs.length === 1);
        return jobs[0].attempts > 0 && jobs[0].error === 'delivery_failed' ? jobs[0] : null;
      });
      const after = await observe('redirect', id);
      expect(
        after?.target_hits === 0 &&
          observed.target_hits === 0 &&
          after.location === redirect.href &&
          digest(verifyWebhook(after.envelope, trust, identity).event) === digest(original.event),
      );
      facts.redirect_attempts = failure.attempts;
      pass(
        stage,
        'The receiver returned a redirect, its target received no request, and the producer could see the failed delivery.',
      );
    } finally {
      try {
        await operate('restore_redirect');
        pass('restore_redirect', 'The receiver returned to its ordinary delivery mode.');
      } catch (error) {
        stage = 'restore_redirect';
        throw error;
      }
    }
    status = fixture ? 'blocked' : 'passed';
  } catch {
    assertions.push({
      name: stage,
      passed: false,
      detail: 'The notification observation differed from the plan or did not arrive.',
    });
  } finally {
    await browser?.close();
  }
  const evidence = await privateEvidence(directory, 'notifications', 'notification_observations', {
    recorded_at: new Date().toISOString(),
    check_id: checkId,
    status,
    source_commit: plan.source.commit,
    service_artifact_digest: plan.deployment.service_artifact_digest,
    plan_digest: planDigest,
    settings_digest: sha256(bytes),
    assertions,
    facts,
  });
  return {
    status,
    assertions,
    facts,
    evidence: [evidence],
    summary: {
      passed: 'SMTP and webhook observations passed on the isolated deployment.',
      blocked: 'The local SMTP and webhook exercise passed.',
      failed: 'The notification drill failed during ' + stage.replaceAll('_', ' ') + '.',
    }[status],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plan, evidence, settings, ...rest] = process.argv.slice(2);
  if (!plan || !evidence || !settings || rest.length) {
    console.error(
      'Usage: node deployment/adapters/notifications.mjs PLAN EVIDENCE_DIRECTORY SETTINGS',
    );
    process.exitCode = 64;
  } else {
    try {
      console.log(JSON.stringify(await collectNotifications(plan, evidence, settings)));
    } catch {
      console.error('Notification adapter did not complete.');
      process.exitCode = 1;
    }
  }
}
