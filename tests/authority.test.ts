import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { environment } from './environment.js';
import { HAIPClient, verifyExecutionAuthority } from '@haip/sdk';
import { digest, canonicalise } from '@haip/protocol/crypto';
let env: Awaited<ReturnType<typeof environment>>;
before(async () => {
  env = await environment();
});
after(async () => await env?.close());
async function authorise(extra: Record<string, unknown> = {}) {
  const body = env.request(true, extra),
    created = await env.api('/v2/requests', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request.id;
  const human = await env.login();
  const candidate = await human.call(`/v2/requests/${id}/candidates`, {
    decision: 'authorise',
    response: { choice: 'accept' },
  });
  assert.equal(candidate.status, 201);
  const receipt = await human.call(`/v2/requests/${id}/confirm`, {
    candidate_id: candidate.body.id,
    candidate_digest: digest(candidate.body),
  });
  assert.equal(receipt.status, 200);
  return { id, created: created.body, body, candidate: candidate.body, receipt: receipt.body };
}
test('expiry during anchoring does not restart the grant clock', async () => {
  await env.put('/v2/admin/routes/review', {
    ...env.route,
    limits: { ...env.route.limits, grant_seconds: 1 },
  });
  const request = await authorise();
  const deadline = request.receipt.payload.grant_deadline;
  await new Promise((r) => setTimeout(r, 1100));
  await env.flush();
  const status = await env.api('/v2/requests/' + request.id);
  assert.equal(status.body.grant_state, 'expired');
  assert.equal(status.body.receipt.payload.grant_deadline, deadline);
  assert.equal(
    (
      await env.api(`/v2/requests/${request.id}/claims`, {
        execution_identity: 'expired',
        execution_binding_digest: digest(request.body.execution),
      })
    ).status,
    409,
  );
  const during = await authorise(),
    originalAccept = env.anchor.accept.bind(env.anchor),
    duringDeadline = during.receipt.payload.grant_deadline,
    sequence = (
      await env.store.pool.query('SELECT data FROM haip_requests WHERE tenant=$1 AND id=$2', [
        'test-tenant',
        during.id,
      ])
    ).rows[0].data.decision_sequence;
  let delayed = false;
  env.anchor.accept = async (record) => {
    if (!delayed && (record.payload as any).sequence >= sequence) {
      delayed = true;
      assert(Date.now() < Date.parse(duringDeadline), 'acceptance starts before grant expiry');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(duringDeadline) - Date.now() + 30)),
      );
    }
    return originalAccept(record);
  };
  try {
    await env.flush();
    assert(delayed);
    const stored = (
      await env.store.pool.query('SELECT data FROM haip_requests WHERE tenant=$1 AND id=$2', [
        'test-tenant',
        during.id,
      ])
    ).rows[0].data;
    assert.equal(stored.grant_state, 'expired', 'anchor worker resamples time after external I/O');
    assert.equal(stored.grant_deadline, duringDeadline);
  } finally {
    env.anchor.accept = originalAccept;
  }
  await env.put('/v2/admin/routes/review', env.route);
});
test('uncertain identity temporarily blocks admission without permanently revoking grants', async () => {
  const request = await authorise();
  await env.flush();
  await env.principal('reviewer', 'human', {
    enabled: true,
    identity_certain: false,
    oidc_issuer: env.service.config.oidc.issuer,
    oidc_subject: 'reviewer',
  });
  const claim = {
    execution_identity: 'identity-uncertain',
    execution_binding_digest: digest(request.body.execution),
  };
  assert.equal((await env.api(`/v2/requests/${request.id}/claims`, claim)).status, 503);
  assert.equal((await env.api('/v2/requests/' + request.id)).body.grant_state, 'available');
  await env.principal('reviewer', 'human', {
    enabled: true,
    identity_certain: true,
    oidc_issuer: env.service.config.oidc.issuer,
    oidc_subject: 'reviewer',
  });
  assert.equal((await env.api(`/v2/requests/${request.id}/claims`, claim)).status, 201);
});
test('offline authority rejects tampering, stale nonces, clock skew and missing independent anchoring', async (t) => {
  const r = await authorise();
  await env.flush();
  const client = new HAIPClient(env.origin, env.credentials.producer, true),
    identity = 'offline-verification';
  const claim = await client.claim(
    r.id,
    { execution_identity: identity, execution_binding_digest: digest(r.body.execution) },
    identity,
  );
  const admission = await client.admission(r.id, claim);
  const material = await client.audit(r.id);
  const input = {
    request: r.created.request,
    receipt: r.receipt,
    candidate: r.candidate,
    claim,
    admission,
    material: material.material,
    trust: env.trust,
    issuer: env.origin,
    tenant: 'test-tenant',
    producer: 'producer',
    executionIdentity: identity,
    executionBindingDigest: digest(r.body.execution),
    verifyAnchor: async (cp: any, ack: any) => {
      assert.equal(await readFile(ack.key, 'utf8'), canonicalise(cp));
    },
  };
  const verified = await verifyExecutionAuthority(input);
  await assert.rejects(
    verifyExecutionAuthority({
      ...input,
      request: {
        ...input.request,
        profiles: { ...input.request.profiles, 'unknown.required': '1' },
      },
    }),
    /Unsupported required profile/,
  );
  for (const altered of [
    { ...input, request: { ...input.request, purpose: 'review' } },
    { ...input, executionBindingDigest: digest({}) },
    { ...input, receipt: { ...input.receipt, signature: 'A'.repeat(86) } },
    { ...input, admission: { ...admission, nonce: 'wrong' } },
    {
      ...input,
      admission: {
        ...admission,
        startedWall: admission.startedWall + 31000,
        receivedWall: admission.receivedWall + 31000,
      },
    },
    {
      ...input,
      admission: {
        ...admission,
        startedWall: admission.startedWall - 31000,
        receivedWall: admission.receivedWall - 31000,
      },
    },
    { ...input, admission: { ...admission, receivedWall: admission.receivedWall + 2000 } },
    {
      ...input,
      verifyAnchor: async () => {
        throw new Error('independent anchor unavailable');
      },
    },
  ])
    await assert.rejects(() => verifyExecutionAuthority(altered as any));
  let now = verified.deadlineMono - 1;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(Date, 'now', () => admission.startedWall + now - admission.startedMono);
  try {
    verified.checkBeforeDispatch();
    now = verified.deadlineMono;
    assert.throws(() => verified.checkBeforeDispatch(), /Admission expired/, 'equality is expired');
    now++;
    assert.throws(() => verified.checkBeforeDispatch(), /Admission expired/);
  } finally {
    t.mock.restoreAll();
  }
});
test('checkpoint conflict fences every new claim', async () => {
  const r = await authorise();
  await env.flush();
  env.anchor.conflict = true;
  await env.api('/v2/requests', env.request());
  await env.worker.tick();
  assert.equal(
    (
      await env.api(`/v2/requests/${r.id}/claims`, {
        execution_identity: 'fenced',
        execution_binding_digest: digest(r.body.execution),
      })
    ).body.error,
    'admission_fenced',
  );
  env.anchor.conflict = false;
});
