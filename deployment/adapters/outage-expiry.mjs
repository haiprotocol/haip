import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXECUTION_PROFILE, EXECUTION_VERSION, PROTOCOL_REVISION } from '@haip/protocol';
import { digest, parseJson, verifyRecord } from '@haip/protocol/crypto';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';

const execute = promisify(execFile);
const checkId = 'outage_expiry';
const tokenName = 'HAIP_ACCEPTANCE_OUTAGE_PRODUCER_TOKEN';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const label = /^[A-Za-z0-9_.:@/-]{1,160}$/;
const maximumWait = 180_000;
const restoreWindow = 60_000;
const maximumResponse = 1024 * 1024;

function expect(condition) {
  if (!condition) throw new Error('Observation differs from the outage plan');
}

function readSettings(plan, planDigest, settings) {
  const origin = new URL(plan.deployment.trusted_origin);
  expect(
    origin.protocol === 'https:' &&
      origin.origin === plan.deployment.trusted_origin &&
      plan.deployment.protocol_revision === PROTOCOL_REVISION &&
      settings?.plan_digest === planDigest,
  );
  const { fresh, preclaim, control } = settings.requests ?? {};
  const ids = [fresh, preclaim, control];
  expect(
    ids.every((id) => typeof id === 'string' && uuid.test(id)) &&
      new Set(ids).size === ids.length &&
      typeof settings.probe_id === 'string' &&
      uuid.test(settings.probe_id) &&
      [settings.tenant, settings.producer].every(
        (value) => typeof value === 'string' && label.test(value),
      ),
  );
  expect(
    settings.trust_manifest?.issuer === origin.origin &&
      settings.trust_manifest.protocol_revision === PROTOCOL_REVISION &&
      Array.isArray(settings.trust_manifest.keys) &&
      settings.trust_manifest.keys.length > 0 &&
      settings.trust_manifest.keys.length <= 128,
  );
  const { control_command: command, control_env: names } = settings;
  expect(
    Array.isArray(command) &&
      command.length > 0 &&
      command.length <= 40 &&
      command.every(
        (arg) =>
          typeof arg === 'string' && arg.length > 0 && arg.length <= 2048 && !arg.includes('\0'),
      ) &&
      isAbsolute(command[0]) &&
      Array.isArray(names) &&
      names.length <= 24 &&
      names.every(
        (name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name) && name !== tokenName,
      ),
  );
  return origin;
}

function callApi(origin, token, fixtureCa) {
  return (path, body, key) =>
    new Promise((complete, reject) => {
      const outgoing = request(
        new URL(path, origin),
        {
          method: body === undefined ? 'GET' : 'POST',
          agent: false,
          rejectUnauthorized: true,
          signal: AbortSignal.timeout(20_000),
          ...(fixtureCa
            ? {
                ca: fixtureCa,
                lookup: (_host, options, callback) =>
                  options.all
                    ? callback(null, [{ address: '127.0.0.1', family: 4 }])
                    : callback(null, '127.0.0.1', 4),
              }
            : {}),
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + token,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Idempotency-Key': key ?? randomUUID() }),
          },
        },
        (incoming) => {
          const chunks = [];
          let bytes = 0;
          incoming.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maximumResponse) outgoing.destroy(new Error('Response exceeds limit'));
            else chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => {
            try {
              complete({
                status: incoming.statusCode,
                body: parseJson(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

function readCanary(result, id, name, settings, fixture) {
  const { request: canary, receipt, anchor } = result.body;
  const deadline = Date.parse(receipt?.payload?.grant_deadline);
  expect(
    result.status === 200 &&
      result.body.decision_state === 'confirmed' &&
      result.body.audit_state === 'anchored' &&
      result.body.grant_state === 'available' &&
      result.body.execution_state === 'unclaimed' &&
      result.body.claim === null &&
      result.body.outcome === null &&
      canary?.id === id &&
      canary.tenant === settings.tenant &&
      canary.producer === settings.producer &&
      canary.protocol_revision === PROTOCOL_REVISION &&
      typeof canary.authority_namespace === 'string' &&
      uuid.test(canary.authority_namespace) &&
      canary.purpose === 'authorise_execution' &&
      canary.profiles?.[EXECUTION_PROFILE] === EXECUTION_VERSION &&
      canary.execution?.mode === 'fixed_mock' &&
      canary.metadata?.haip_acceptance_fixture === checkId &&
      canary.metadata.haip_acceptance_probe === settings.probe_id &&
      canary.metadata.haip_acceptance_role === name &&
      receipt?.payload?.request_id === id &&
      receipt.payload.decision === 'authorise' &&
      receipt.payload.purpose === canary.purpose &&
      receipt.payload.request_digest === result.body.request_digest &&
      receipt.payload.request_digest === digest(canary) &&
      Number.isFinite(deadline) &&
      deadline > Date.now() &&
      receipt.protected.issued_at === receipt.payload.confirmed_at &&
      deadline ===
        Math.min(
          Date.parse(receipt.payload.confirmed_at) + canary.limits.grant_seconds * 1000,
          Date.parse(canary.execution.valid_until),
        ) &&
      anchor?.checkpoint?.payload?.generation === canary.authority_namespace &&
      anchor.acceptance?.backend === (fixture ? 'test_filesystem' : 'azure_blob_locked_worm') &&
      anchor.acceptance.digest === digest(anchor.checkpoint),
  );
  const context = {
    issuer: settings.trust_manifest.issuer,
    audience: canary.producer,
    tenant: canary.tenant,
    purpose: canary.purpose,
  };
  verifyRecord(
    receipt,
    settings.trust_manifest,
    { ...context, type: 'DecisionReceipt' },
    new Date(),
  );
  expect(digest(receipt.protected.profiles) === digest(canary.profiles));
  const { ledger_id: ledger } = anchor.checkpoint.payload;
  expect(typeof ledger === 'string' && uuid.test(ledger));
  verifyRecord(
    anchor.checkpoint,
    settings.trust_manifest,
    {
      issuer: context.issuer,
      audience: 'haip.audit',
      tenant: ledger,
      purpose: 'service',
      type: 'AuditCheckpoint',
    },
    new Date(),
  );
  return {
    context,
    request: canary,
    receipt,
    receiptDigest: digest(receipt),
    requestDigest: result.body.request_digest,
    deadline,
    path: '/v2/requests/' + id,
    claimInput: {
      execution_identity: 'outage-probe-' + randomUUID(),
      execution_binding_digest: digest(canary.execution),
    },
    idempotencyKey: randomUUID(),
  };
}

function confirmedClaim(result, canary, trust) {
  const claim = result.body;
  const fields = claim?.payload;
  expect(
    result.status === 201 &&
      typeof fields?.id === 'string' &&
      uuid.test(fields.id) &&
      fields.request_id === canary.request.id &&
      fields.request_digest === canary.requestDigest &&
      fields.receipt_digest === canary.receiptDigest &&
      fields.action_occurrence_id === canary.request.execution.action_occurrence_id &&
      fields.execution_identity === canary.claimInput.execution_identity &&
      fields.execution_binding_digest === canary.claimInput.execution_binding_digest &&
      fields.execution_seconds === canary.request.execution.execution_seconds &&
      Date.parse(fields.claimed_at) < canary.deadline &&
      fields.dispatch_before === canary.receipt.payload.grant_deadline,
  );
  verifyRecord(claim, trust, { ...canary.context, type: 'ExecutionClaim' }, new Date());
  expect(digest(claim.protected.profiles) === digest(canary.request.profiles));
  return claim;
}

function permitInput(claim) {
  return {
    claim_id: claim.payload.id,
    execution_identity: claim.payload.execution_identity,
    nonce: randomBytes(24).toString('base64url'),
  };
}

function confirmedPermit(result, canary, claim, input, trust) {
  const record = result.body;
  const data = record?.payload;
  expect(
    result.status === 200 &&
      data?.request_id === canary.request.id &&
      data.claim_id === claim.payload.id &&
      data.claim_digest === digest(claim) &&
      data.nonce === input.nonce &&
      data.execution_identity === claim.payload.execution_identity &&
      data.execution_binding_digest === claim.payload.execution_binding_digest &&
      data.execution_seconds === claim.payload.execution_seconds &&
      Date.parse(data.checked_at) < canary.deadline &&
      data.dispatch_before === canary.receipt.payload.grant_deadline,
  );
  verifyRecord(record, trust, { ...canary.context, type: 'AdmissionStatus' }, new Date());
  expect(digest(record.protected.profiles) === digest(canary.request.profiles));
}

function refused(result, status, error) {
  expect(result.status === status && result.body?.error === error);
}

export async function collectOutageExpiry(
  planPath,
  evidenceDirectory,
  settingsPath,
  { environment = process.env, fixtureCa } = {},
) {
  const { plan, digest: planDigest } = await readAcceptancePlan(planPath);
  if (!fixtureCa && plan.deployment.independent_administration_asserted !== true)
    return {
      status: 'blocked',
      summary: 'The outage drill needs an independently administered isolated deployment.',
      assertions: [],
      evidence: [],
      facts: { scope: 'isolated_deployment' },
    };
  const { bytes, document: settings } = await readJsonDocument(settingsPath);
  const directory = await privateDirectory(evidenceDirectory);
  const assertions = [];
  const facts = { scope: fixtureCa ? 'local_fixture' : 'isolated_deployment' };
  const passed = (name, detail) => assertions.push({ name, passed: true, detail });
  let stage = 'settings';
  let status = 'failed';
  try {
    expect((environment.HAIP_ACCEPTANCE_CHECK_ID ?? checkId) === checkId);
    const origin = readSettings(plan, planDigest, settings);
    const token = environment[tokenName];
    expect(typeof token === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(token));
    const { control_command: command, control_env: names, trust_manifest: trust } = settings;
    const controlEnv = Object.fromEntries(
      [...new Set(['PATH', ...names])]
        .filter((name) => typeof environment[name] === 'string')
        .map((name) => [name, environment[name]]),
    );
    expect(![...command, ...Object.values(controlEnv)].some((value) => value.includes(token)));
    const call = callApi(origin, token, fixtureCa);
    const claim = (canary) =>
      call(canary.path + '/claims', canary.claimInput, canary.idempotencyKey);
    stage = 'bound_canaries';
    const namesOfCanaries = ['fresh', 'preclaim', 'control'];
    const [fresh, preclaim, control] = await Promise.all(
      namesOfCanaries.map(async (name) => {
        const id = settings.requests[name];
        const result = await call('/v2/requests/' + id);
        return readCanary(result, id, name, settings, !!fixtureCa);
      }),
    );
    const expires = Math.max(fresh.deadline, preclaim.deadline);
    expect(
      expires - Date.now() <= maximumWait &&
        control.deadline > expires + restoreWindow &&
        [preclaim, control].every(
          (canary) => canary.request.authority_namespace === fresh.request.authority_namespace,
        ) &&
        new Set(
          [fresh, preclaim, control].map(({ request }) => request.execution.action_occurrence_id),
        ).size === 3,
    );
    facts.fresh_deadline = fresh.receipt.payload.grant_deadline;
    facts.preclaim_deadline = preclaim.receipt.payload.grant_deadline;
    facts.control_deadline = control.receipt.payload.grant_deadline;
    passed(stage, 'Three distinct signed and anchored test grants matched the reviewed probe.');

    stage = 'claim_before_outage';
    const original = confirmedClaim(await claim(preclaim), preclaim, trust);
    const originalPermit = permitInput(original);
    expect(Math.min(fresh.deadline, preclaim.deadline) > Date.now());
    passed(
      stage,
      'The preclaim request was consumed against its original deadline before the outage.',
    );
    const latePermit = () => call(preclaim.path + '/admission', originalPermit);
    const probePair = async () => {
      const results = await Promise.allSettled([claim(fresh), latePermit()]);
      return results.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
    };

    const remaining = expires - Date.now();
    expect(remaining > 0 && remaining <= maximumWait);
    const waitUntil = performance.now() + remaining + 250;
    const leaseSeconds = Math.ceil((remaining + restoreWindow) / 1000);
    const setFault = (action) =>
      execute(
        command[0],
        [...command.slice(1), action, settings.probe_id, planDigest, String(leaseSeconds)],
        { env: controlEnv, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 },
      );
    try {
      stage = 'start_outage';
      await setFault('begin');
      stage = 'refused_during_outage';
      const during = await probePair();
      for (const result of during) refused(result, 503, 'anchor_unavailable');
      passed(
        stage,
        'The checkpoint outage refused a fresh claim and fresh admission before expiry.',
      );
      stage = 'outage_crossed_expiry';
      await delay(Math.max(0, waitUntil - performance.now()));
      refused(await latePermit(), 409, 'grant_expired');
      const observedExpiry = await call(fresh.path);
      expect(observedExpiry.status === 200 && observedExpiry.body.grant_state === 'expired');
      refused(await claim(control), 503, 'anchor_unavailable');
      passed(stage, 'The longer grant still saw the outage after both short grants had expired.');
    } finally {
      try {
        await setFault('restore');
        passed(
          'restore_checkpoint_access',
          'The outage controller reported restored checkpoint access.',
        );
      } catch {
        stage = 'restore_checkpoint_access';
        throw new Error('Outage controller did not confirm restoration');
      }
    }

    stage = 'expired_after_restore';
    for (const result of await probePair()) refused(result, 409, 'grant_expired');
    const [freshAfter, preclaimAfter] = await Promise.all([call(fresh.path), call(preclaim.path)]);
    expect(
      freshAfter.status === 200 &&
        freshAfter.body.grant_state === 'expired' &&
        freshAfter.body.claim === null &&
        freshAfter.body.outcome === null &&
        digest(freshAfter.body.receipt) === fresh.receiptDigest &&
        preclaimAfter.status === 200 &&
        preclaimAfter.body.grant_state === 'consumed' &&
        preclaimAfter.body.execution_state === 'claimed' &&
        preclaimAfter.body.outcome === null &&
        digest(preclaimAfter.body.claim) === digest(original) &&
        digest(preclaimAfter.body.receipt) === preclaim.receiptDigest,
    );
    passed(
      stage,
      'Both expired operations returned grant_expired and both original receipts were preserved.',
    );

    stage = 'restored_control';
    const restored = confirmedClaim(await claim(control), control, trust);
    const restoredInput = permitInput(restored);
    confirmedPermit(
      await call(control.path + '/admission', restoredInput),
      control,
      restored,
      restoredInput,
      trust,
    );
    passed(
      stage,
      'The longer grant received a signed claim and fresh admission with its original deadline.',
    );
    status = fixtureCa ? 'blocked' : 'passed';
  } catch {
    assertions.push({
      name: stage,
      passed: false,
      detail: 'The outage step failed or its observations differed from the plan.',
    });
  }
  const evidence = await privateEvidence(directory, 'outage-expiry', 'outage_observations', {
    recorded_at: new Date().toISOString(),
    check_id: checkId,
    source_commit: plan.source.commit,
    service_artifact_digest: plan.deployment.service_artifact_digest,
    plan_digest: planDigest,
    settings_digest: sha256(bytes),
    assertions,
    facts,
    status,
  });
  const summary = {
    passed: 'Checkpoint outage and grant expiry passed on the isolated deployment.',
    blocked: 'The local checkpoint outage and expiry exercise passed.',
    failed: 'The checkpoint outage drill failed during ' + stage.replaceAll('_', ' ') + '.',
  }[status];
  return { status, summary, assertions, evidence: [evidence], facts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plan, evidence, settings, option, caPath, ...extra] = process.argv.slice(2);
  if (
    !plan ||
    !evidence ||
    !settings ||
    extra.length ||
    (option !== undefined && (option !== '--fixture-ca' || !caPath))
  ) {
    console.error(
      'Usage: node deployment/adapters/outage-expiry.mjs PLAN EVIDENCE_DIRECTORY SETTINGS [--fixture-ca CA_FILE]',
    );
    process.exitCode = 64;
  } else {
    try {
      console.log(
        JSON.stringify(
          await collectOutageExpiry(plan, evidence, settings, {
            fixtureCa: caPath ? await readFile(caPath) : undefined,
          }),
        ),
      );
    } catch {
      console.error('Checkpoint outage adapter did not complete.');
      process.exitCode = 1;
    }
  }
}
