#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { discovery } from 'openid-client';
import { validHostCookie } from './origins-tls.mjs';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const humanId = /^[a-zA-Z0-9_.:@/-]{1,160}$/;
const sessionName = '__Host-haip';
const loginCookieName = '__Host-haip-login';
const sessionPath = '/auth/session';
const fixtureMarker = 'external_identity';

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Expected an HTTPS URL');
  return url;
}

function settings(plan, config) {
  const trusted = httpsUrl(plan.deployment.trusted_origin);
  const issuer = httpsUrl(config.issuer);
  if (
    trusted.origin !== plan.deployment.trusted_origin ||
    issuer.search ||
    typeof config.client_id !== 'string' ||
    !config.client_id ||
    config.client_id.length > 256 ||
    !['oidc', 'oauth2'].includes(config.discovery ?? 'oidc') ||
    !['client_secret_basic', 'client_secret_post'].includes(config.client_auth) ||
    typeof config.review_id !== 'string' ||
    !uuid.test(config.review_id) ||
    typeof config.reviewer !== 'string' ||
    !humanId.test(config.reviewer) ||
    typeof config.requester !== 'string' ||
    !humanId.test(config.requester) ||
    config.reviewer === config.requester ||
    (config.unmapped_account !== undefined && typeof config.unmapped_account !== 'boolean')
  )
    throw new Error('Invalid identity acceptance settings');
  return { trusted, issuer };
}

function tokenEvidence(plan, config) {
  const observation = config.provider_observation;
  if (observation === undefined) return undefined;
  const identity = plan.deployment.components?.find((part) => part.kind === 'identity');
  if (
    !identity ||
    observation.source_commit !== plan.source.commit ||
    observation.service_artifact_digest !== plan.deployment.service_artifact_digest ||
    observation.configuration_revision !== plan.deployment.configuration_revision ||
    observation.identity_revision !== identity.revision ||
    observation.issuer !== config.issuer ||
    observation.client_id !== config.client_id ||
    observation.client_auth !== config.client_auth ||
    typeof observation.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(observation.digest) ||
    typeof observation.reference !== 'string' ||
    !/^private-evidence:[A-Za-z0-9_.:/-]{1,200}$/.test(observation.reference) ||
    typeof observation.recorded_at !== 'string' ||
    !Number.isFinite(Date.parse(observation.recorded_at))
  )
    throw new Error(
      'The provider observation must refer to the configured client and release revisions',
    );
  return {
    name: 'token-endpoint-client-auth',
    digest: observation.digest,
    reference: observation.reference,
    recorded_at: new Date(observation.recorded_at).toISOString(),
  };
}

async function readSession(page) {
  return page.evaluate(async (path) => {
    const result = await fetch(path, { redirect: 'error' });
    return { status: result.status, body: result.ok ? await result.json() : null };
  }, sessionPath);
}

async function login(context, state, subject, change) {
  const { trusted, review, authorize, wait, signIn, fetchLogin } = state;
  const page = await context.newPage();
  const matchesAuthorize = (url) =>
    url.origin === authorize.origin && url.pathname === authorize.pathname;
  const outgoing = page
    .waitForRequest(
      (request) => matchesAuthorize(new URL(request.url())) && request.isNavigationRequest(),
      { timeout: wait },
    )
    .catch(() => undefined);
  const callback = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === trusted.origin &&
          url.pathname === '/auth/callback' &&
          response.request().isNavigationRequest()
        );
      },
      { timeout: wait },
    )
    .catch(() => undefined);
  const start = new URL('/auth/login', trusted);
  start.searchParams.set('return_to', review.pathname);
  let changedValue;
  if (change) {
    if ((await context.cookies([review.href])).some((entry) => entry.name === sessionName))
      throw new Error('identity_refusal_requires_signed_out_context');
    const initiated = await fetchLogin(start);
    if (initiated.status !== 302) throw new Error('identity_login_redirect');
    const changed = httpsUrl(initiated.headers.get('location'));
    if (!matchesAuthorize(changed)) throw new Error('identity_authorization_endpoint');
    const cookies = initiated.headers
      .getSetCookie()
      .filter((header) => header.startsWith(`${loginCookieName}=`));
    const loginCookie = cookies[0];
    if (cookies.length !== 1 || !validHostCookie(loginCookie, loginCookieName))
      throw new Error('identity_login_cookie');
    await context.addCookies([
      {
        name: loginCookieName,
        value: loginCookie.split(';')[0].slice(loginCookieName.length + 1),
        domain: trusted.hostname,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    changedValue = randomBytes(32).toString('base64url');
    changed.searchParams.set(change, changedValue);
    await page.goto(changed.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  } else {
    await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  }
  await signIn(page, subject, change);
  const [sent, result] = await Promise.all([outgoing, callback]);
  const cookie = (await context.cookies([review.href])).find((entry) => entry.name === sessionName);
  const setCookies = ((await result?.headerValues('set-cookie')) ?? []).filter((header) =>
    header.startsWith(`${sessionName}=`),
  );
  const params = sent ? new URL(sent.url()).searchParams : new URLSearchParams();
  const callbackParams = result ? new URL(result.url()).searchParams : new URLSearchParams();
  return {
    page,
    result,
    params,
    tamperingObserved: change ? params.get(change) === changedValue : false,
    codeReturned:
      !!callbackParams.get('code') &&
      !callbackParams.has('error') &&
      !!params.get('state') &&
      callbackParams.get('state') === params.get('state'),
    cookie,
    setCookies,
  };
}

async function markedRequest(page, reviewId, requester) {
  return page.evaluate(
    async ({ reviewId, marker, requester }) => {
      const path = `/v2/requests/${reviewId}`;
      const [status, material] = await Promise.all([
        fetch(path, { redirect: 'error' }),
        fetch(`${path}/material`, { redirect: 'error' }),
      ]);
      if (!status.ok || !material.ok) return false;
      const { decision_state } = await status.json();
      const { request, candidate } = await material.json();
      return (
        decision_state === 'pending' &&
        request?.id === reviewId &&
        request?.purpose === 'review' &&
        request?.requester?.source === 'operator_directory' &&
        request?.requester?.subject === requester &&
        request?.metadata?.haip_acceptance_fixture === marker &&
        candidate === null
      );
    },
    { reviewId, marker: fixtureMarker, requester },
  );
}

export async function collectExternalIdentity(
  plan,
  config,
  { fixturePins, signIn, fixtureLogin } = {},
) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('TLS verification is required');
  const { trusted, issuer } = settings(plan, config);
  if (
    fixturePins &&
    (!fixturePins.length ||
      !trusted.hostname.endsWith('.test') ||
      issuer.hostname !== '127.0.0.1' ||
      !signIn ||
      !fixtureLogin)
  )
    throw new Error('Identity fixtures require verified loopback certificate pins');
  const assertions = [];
  const assert = (name, passed, detail) => {
    assertions.push({ name, passed: !!passed, detail });
    if (!passed) throw new Error(name);
  };
  const review = new URL(`/review/${config.review_id}`, trusted);
  let browser;
  let stage = 'issuer_discovery';
  let version;
  try {
    const metadata = (
      await discovery(issuer, config.client_id, undefined, undefined, {
        algorithm: config.discovery ?? 'oidc',
        timeout: 10,
      })
    ).serverMetadata();
    const authorize = httpsUrl(metadata.authorization_endpoint);
    const token = httpsUrl(metadata.token_endpoint);
    assert(
      'identity_issuer',
      metadata.issuer === config.issuer && !!token,
      'Discovery presents the exact configured issuer and an HTTPS token endpoint.',
    );
    assert(
      'identity_client_auth_supported',
      (metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic']).includes(
        config.client_auth,
      ),
      'Discovery permits the configured confidential-client authentication method.',
    );

    stage = 'browser_launch';
    browser = await chromium.launch({
      channel: 'chromium',
      headless: !!fixturePins,
      timeout: 10_000,
      ...(fixturePins
        ? {
            args: [
              '--host-resolver-rules=MAP *.test 127.0.0.1',
              `--ignore-certificate-errors-spki-list=${fixturePins.join(',')}`,
            ],
          }
        : {}),
    });
    version = browser.version();
    const newContext = async () => {
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      context.setDefaultTimeout(8000);
      if (fixturePins)
        await context.route('**/*', (route) => {
          const origin = new URL(route.request().url()).origin;
          return origin === trusted.origin || origin === issuer.origin
            ? route.continue()
            : route.abort();
        });
      return context;
    };
    const state = {
      trusted,
      authorize,
      review,
      wait: fixturePins ? 10_000 : 100_000,
      fetchLogin: fixturePins
        ? fixtureLogin
        : (url) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }),
      signIn:
        signIn ??
        (async (page, subject, change) => {
          await page.bringToFront();
          console.error(
            `Sign in as ${subject}${change ? ` for the ${change} refusal check` : ''} in the new browser tab.`,
          );
        }),
    };
    const verifiedLogin = async (context, subject, prefix) => {
      const result = await login(context, state, subject);
      assert(
        `${prefix}_callback`,
        result.result?.status() === 302 &&
          (await result.result.headerValue('location')) === review.pathname &&
          result.setCookies.length === 1 &&
          validHostCookie(result.setCookies[0]) &&
          result.cookie?.domain === trusted.hostname &&
          result.cookie.httpOnly &&
          result.cookie.secure &&
          result.cookie.path === '/' &&
          result.cookie.sameSite === 'Lax',
        'The callback returns to the chosen review and issues one host-only Secure HttpOnly SameSite=Lax session.',
      );
      await result.page.waitForURL(review.href, { waitUntil: 'domcontentloaded' });
      const session = await readSession(result.page);
      assert(
        `${prefix}_subject`,
        session.status === 200 && session.body?.subject === subject,
        'The authenticated account maps to the expected HAIP directory entry.',
      );
      return result;
    };
    const cookieRetired = async (cookie) => {
      const probe = await newContext();
      try {
        await probe.addCookies([cookie]);
        return (
          (await (await probe.newPage()).goto(new URL(sessionPath, trusted).href))?.status() === 401
        );
      } finally {
        await probe.close();
      }
    };

    stage = 'reviewer_login';
    const reviewer = await newContext();
    const initial = await verifiedLogin(reviewer, config.reviewer, 'reviewer');
    const params = initial.params;
    assert(
      'identity_authorization_parameters',
      params.get('client_id') === config.client_id &&
        params.get('redirect_uri') === new URL('/auth/callback', trusted).href &&
        params.get('response_type') === 'code' &&
        params.get('code_challenge_method') === 'S256' &&
        /^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '') &&
        /^[A-Za-z0-9_-]{16,256}$/.test(params.get('state') ?? '') &&
        /^[A-Za-z0-9_-]{16,256}$/.test(params.get('nonce') ?? ''),
      'The authorisation request uses the exact client and callback, code flow, S256 PKCE, state and nonce.',
    );
    assert(
      'identity_disposable_review',
      await markedRequest(initial.page, config.review_id, config.requester),
      'The reviewer can read the marked disposable review before any test mutation.',
    );

    stage = 'session_rotation';
    const rotated = await verifiedLogin(reviewer, config.reviewer, 'rotated');
    assert(
      'identity_session_rotation',
      initial.cookie.value !== rotated.cookie.value && (await cookieRetired(initial.cookie)),
      'Successful sign-in replaces the previous browser session.',
    );
    const replay = await initial.page.goto(initial.result.url(), { waitUntil: 'domcontentloaded' });
    assert(
      'identity_callback_replay_refused',
      replay?.status() === 401,
      'Repeating a consumed callback is refused.',
    );
    const signedOut = await rotated.page.evaluate(async () => {
      const session = await (await fetch('/auth/session')).json();
      return (
        await fetch('/auth/logout', {
          method: 'POST',
          headers: { 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' },
          body: '{}',
          redirect: 'error',
        })
      ).status;
    });
    assert(
      'identity_logout',
      signedOut === 204 &&
        (await readSession(rotated.page)).status === 401 &&
        (await cookieRetired(rotated.cookie)),
      'Logout ends the current session and rejects a replay of its cookie.',
    );

    stage = 'self_review';
    const requester = await newContext();
    const owner = await verifiedLogin(requester, config.requester, 'requester');
    assert(
      'identity_requester_review_fixture',
      await markedRequest(owner.page, config.review_id, config.requester),
      'The authenticated requester is in the test review route for the separation probe.',
    );
    const proposed = await owner.page.evaluate(
      async ({ path, key }) => {
        const session = await (await fetch('/auth/session')).json();
        const response = await fetch(path, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': session.csrf,
            'Idempotency-Key': key,
          },
          body: JSON.stringify({ decision: 'answer', response: { choice: 'accept' } }),
        });
        return { status: response.status, error: (await response.json()).error };
      },
      { path: `/v2/requests/${config.review_id}/candidates`, key: randomUUID() },
    );
    assert(
      'identity_self_review_refused',
      proposed.status === 403 &&
        proposed.error === 'separation_of_duties' &&
        (await markedRequest(owner.page, config.review_id, config.requester)),
      'The service refuses a requester proposal and leaves the candidate slot empty.',
    );

    for (const [change, name] of [
      ['state', 'state'],
      ['nonce', 'nonce'],
      ['code_challenge', 'pkce'],
    ]) {
      stage = `invalid_${name}`;
      const attempt = await login(reviewer, state, config.reviewer, change);
      const statuses = name === 'state' ? [401] : [400, 401, 403, 503];
      assert(
        `identity_${name}_refused`,
        attempt.tamperingObserved &&
          attempt.codeReturned &&
          statuses.includes(attempt.result?.status()) &&
          !attempt.cookie &&
          attempt.setCookies.length === 0,
        `The callback with a changed ${name} is refused without issuing a session.`,
      );
    }
    if (config.unmapped_account) {
      stage = 'unmapped_account';
      const attempt = await login(
        await newContext(),
        state,
        'the account outside the HAIP directory',
      );
      assert(
        'identity_unmapped_refused',
        attempt.codeReturned &&
          attempt.result?.status() === 403 &&
          !attempt.cookie &&
          attempt.setCookies.length === 0,
        'An authenticated provider account without a matching issuer and subject in the directory is refused.',
      );
    }
    stage = 'reviewer_login_after_refusals';
    await verifiedLogin(reviewer, config.reviewer, 'recovered_reviewer');
    return { passed: true, assertions, browser_version: version };
  } catch {
    if (!assertions.some((row) => !row.passed))
      assertions.push({
        name: stage,
        passed: false,
        detail: 'The identity probe did not complete at this step.',
      });
    return { passed: false, assertions, browser_version: version };
  } finally {
    await browser?.close();
  }
}

async function main() {
  const [planPath, evidencePath, settingsPath, ...rest] = process.argv.slice(2);
  if (!planPath || !evidencePath || !settingsPath || rest.length)
    throw new Error(
      'Usage: node deployment/adapters/external-identity.mjs PLAN PRIVATE_EVIDENCE_DIRECTORY IDENTITY_SETTINGS',
    );
  if (
    process.env.HAIP_ACCEPTANCE_CHECK_ID &&
    process.env.HAIP_ACCEPTANCE_CHECK_ID !== fixtureMarker
  )
    throw new Error('This adapter serves external_identity only');
  const [{ plan, digest }, { document: config }] = await Promise.all([
    readAcceptancePlan(planPath),
    readJsonDocument(settingsPath),
  ]);
  const providerEvidence = tokenEvidence(plan, config);
  const directory = await privateDirectory(evidencePath);
  const browser = await collectExternalIdentity(plan, config);
  const document = {
    format: 'haip.external-identity.v1',
    evidence_kind: 'live_browser',
    recorded_at: new Date().toISOString(),
    source_commit: plan.source.commit,
    plan_digest: digest,
    issuer_digest: sha256(config.issuer),
    client_id_digest: sha256(config.client_id),
    review_id_digest: sha256(config.review_id),
    client_auth: config.client_auth,
    browser,
    provider_evidence: providerEvidence ?? null,
  };
  const evidence = [
    await privateEvidence(directory, 'external-identity', 'oidc-browser-probes', document),
  ];
  if (providerEvidence) evidence.push(providerEvidence);
  const status = !browser.passed ? 'failed' : !providerEvidence ? 'blocked' : 'passed';
  const summary =
    status === 'passed'
      ? 'The identity flow and the bound token endpoint observation passed.'
      : status === 'blocked'
        ? 'The browser identity flow passed. The token endpoint authentication observation is pending.'
        : 'One or more identity probes failed.';
  process.stdout.write(
    JSON.stringify({
      status,
      summary,
      evidence,
      assertions: [
        ...browser.assertions,
        {
          name: 'identity_token_endpoint_observation',
          passed: !!providerEvidence,
          detail:
            'A private provider observation is bound to the exact client and deployment revisions.',
        },
      ],
      facts: {
        browser_flow_exercised: browser.passed,
        token_endpoint_observed: !!providerEvidence,
      },
    }) + '\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(
      JSON.stringify({
        status: 'failed',
        summary: 'The identity adapter could not validate its inputs or preserve private evidence.',
        assertions: [
          {
            name: 'adapter_completed',
            passed: false,
            detail: 'Check the reviewed plan, identity settings and private evidence directory.',
          },
        ],
        evidence: [],
        facts: {},
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
