import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { EXECUTION_PROFILE, EXECUTION_VERSION, PROTOCOL_REVISION } from '@haip/protocol';
import { digest, parseJson, verifyRecord } from '@haip/protocol/crypto';

export const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const label = /^[A-Za-z0-9_.:@/-]{1,160}$/;
const maximumResponse = 1024 * 1024;
const execute = promisify(execFile);

export function expect(condition) {
  if (!condition) throw new Error('Observation differs from the acceptance plan');
}

export function operatorControl(settings, environment, privateNames) {
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
        (name) =>
          typeof name === 'string' &&
          /^[A-Z][A-Z0-9_]*$/.test(name) &&
          !privateNames.includes(name),
      ),
  );
  const env = Object.fromEntries(
    [...new Set(['PATH', ...names])]
      .filter((name) => typeof environment[name] === 'string')
      .map((name) => [name, environment[name]]),
  );
  const secrets = privateNames.map((name) => environment[name]).filter(Boolean);
  expect(
    ![...command, ...Object.values(env)].some((value) =>
      secrets.some((secret) => value.includes(secret)),
    ),
  );
  return (...args) =>
    execute(command[0], [...command.slice(1), ...args], {
      env,
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 32 * 1024,
    });
}

export function callApi(origin, token, fixtureCa) {
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

export function readCanary(result, id, name, settings, checkId, backend) {
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
      anchor.acceptance?.backend === backend &&
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
    anchor,
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

export function confirmedClaim(result, canary, trust) {
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

export function permitInput(claim) {
  return {
    claim_id: claim.payload.id,
    execution_identity: claim.payload.execution_identity,
    nonce: randomBytes(24).toString('base64url'),
  };
}

export function confirmedPermit(result, canary, claim, input, trust) {
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

export function refused(result, status, error) {
  expect(result.status === status && result.body?.error === error);
}
