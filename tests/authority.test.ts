import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { toHttpHeadersLike } from '@azure/core-http-compat';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import { BlobServiceClient, newPipeline } from '@azure/storage-blob';
import { environment } from './environment.js';
import { HAIPClient, verifyExecutionAuthority } from '@haip/sdk';
import { digest, canonicalise, signRecord } from '@haip/protocol/crypto';
import { AzureAnchor } from '../haip-server/src/anchor.js';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { RecoveryGuard } from '../haip-server/src/recovery.js';
import { TestSafetyStore } from './fixtures/safety.js';
let env: Awaited<ReturnType<typeof environment>>;
before(async () => {
  env = await environment();
});
after(async () => await env?.close());
async function authorise(extra: Record<string, unknown> = {}, fixture = env) {
  const body = fixture.request(true, extra),
    created = await fixture.api('/v2/requests', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request.id;
  const human = await fixture.login();
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
  for (const purpose of ['review', undefined]) {
    const payload = { ...input.receipt.payload, purpose };
    if (purpose === undefined) delete payload.purpose;
    const receipt = signRecord(payload, input.receipt.protected, env.service.config.signingKey);
    await assert.rejects(
      verifyExecutionAuthority({ ...input, receipt: receipt as any }),
      /Decision does not authorise this request/,
      'a valid signature cannot conceal a missing or contradictory receipt purpose',
    );
  }
  for (const unsupported of [{ 'unknown.required': '1' }, { 'haip.mcp-app': '1-draft.1' }])
    await assert.rejects(
      verifyExecutionAuthority({
        ...input,
        request: {
          ...input.request,
          profiles: { ...input.request.profiles, ...unsupported },
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
test('a checkpoint outage blocks claims and permits and recovery preserves grant expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haip-checkpoint-outage-'));
  const originalRecovery = env.service.recovery;
  try {
    const safety = new TestSafetyStore(directory);
    env.service.recovery = new RecoveryGuard(env.service, safety);
    await env.worker.reconcile();
    const available = await authorise();
    const claimed = await authorise();
    await env.flush();
    const claimInput = (request: Awaited<ReturnType<typeof authorise>>, identity: string) => ({
      execution_identity: identity,
      execution_binding_digest: digest(request.body.execution),
    });
    const ready = claimInput(available, 'claim-after-outage');
    const previous = claimInput(claimed, 'claim-before-outage');
    const claim = await env.api(`/v2/requests/${claimed.id}/claims`, previous);
    assert.equal(claim.status, 201);
    const permit = {
      claim_id: claim.body.payload.id,
      execution_identity: previous.execution_identity,
      nonce: 'nonce-during-checkpoint-outage',
    };
    env.anchor.unavailable = true;
    await env.service.recovery.assertActive(
      'test-tenant',
      available.created.request.authority_namespace,
    );
    const unavailable = await env.api(`/v2/requests/${available.id}/claims`, ready);
    const blocked = await env.api(`/v2/requests/${claimed.id}/admission`, permit);
    assert.deepEqual([unavailable.status, blocked.status], [503, 503]);
    assert.deepEqual(
      [unavailable.body.error, blocked.body.error],
      ['anchor_unavailable', 'anchor_unavailable'],
    );
    assert.equal((await env.api(`/v2/requests/${available.id}`)).body.grant_state, 'available');

    env.anchor.unavailable = false;
    const retryClaim = await env.api(`/v2/requests/${available.id}/claims`, ready);
    assert.equal(retryClaim.status, 201);
    assert.equal(retryClaim.body.payload.dispatch_before, available.receipt.payload.grant_deadline);
    const retryPermit = await env.api(`/v2/requests/${claimed.id}/admission`, permit);
    assert.equal(retryPermit.status, 200);
    assert.equal(retryPermit.body.payload.dispatch_before, claimed.receipt.payload.grant_deadline);

    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: { ...env.route.limits, grant_seconds: 3 },
    });
    const expiring = await authorise();
    const expiringClaimed = await authorise();
    await env.flush();
    const expiringInput = claimInput(expiring, 'unclaimed-at-expiry');
    const expiringConsumed = claimInput(expiringClaimed, 'claimed-before-expiry');
    const expiringClaim = await env.api(
      `/v2/requests/${expiringClaimed.id}/claims`,
      expiringConsumed,
    );
    assert.equal(expiringClaim.status, 201);
    assert.equal(
      expiringClaim.body.payload.dispatch_before,
      expiringClaimed.receipt.payload.grant_deadline,
    );
    const expiringPermit = {
      claim_id: expiringClaim.body.payload.id,
      execution_identity: expiringConsumed.execution_identity,
      nonce: 'nonce-crossing-checkpoint-outage',
    };
    const pending = () =>
      Promise.all([
        env.api(`/v2/requests/${expiring.id}/claims`, expiringInput),
        env.api(`/v2/requests/${expiringClaimed.id}/admission`, expiringPermit),
      ]);
    env.anchor.unavailable = true;
    const during = await pending();
    assert.deepEqual(
      during.map(({ status }) => status),
      [503, 503],
    );
    assert.deepEqual(
      during.map(({ body }) => body.error),
      ['anchor_unavailable', 'anchor_unavailable'],
    );
    await env.store.pool.query('SELECT pg_sleep_until(GREATEST($1::timestamptz,$2::timestamptz))', [
      expiring.receipt.payload.grant_deadline,
      expiringClaimed.receipt.payload.grant_deadline,
    ]);
    env.anchor.unavailable = false;
    const after = await pending();
    assert.deepEqual(
      after.map(({ status }) => status),
      [409, 409],
    );
    assert.deepEqual(
      after.map(({ body }) => body.error),
      ['grant_expired', 'grant_expired'],
    );
    for (const review of [expiring, expiringClaimed]) {
      const status = await env.api('/v2/requests/' + review.id);
      assert.equal(
        status.body.receipt.payload.grant_deadline,
        review.receipt.payload.grant_deadline,
      );
    }
  } finally {
    env.anchor.unavailable = false;
    env.service.recovery = originalRecovery;
    await env.put('/v2/admin/routes/review', env.route);
    await rm(directory, { recursive: true, force: true });
  }
});
test('checkpoint verification leaves the tenant unlocked and refuses a changed receipt', async (t) => {
  const review = await authorise();
  await env.flush();
  const inspected = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const verify = env.anchor.verifyAcceptance.bind(env.anchor);
  t.mock.method(env.anchor, 'verifyAcceptance', async (...input: Parameters<typeof verify>) => {
    await verify(...input);
    inspected.resolve();
    await resume.promise;
  });
  const pending = env.api(`/v2/requests/${review.id}/claims`, {
    execution_identity: 'checkpoint-race',
    execution_binding_digest: digest(review.body.execution),
  });
  try {
    await Promise.race([
      inspected.promise,
      pending.then(({ status }) => {
        throw new Error(`Claim returned ${status} before verifying the checkpoint`);
      }),
    ]);
    const status = await env.api(`/v2/requests/${review.id}`);
    const nextRetention = new Date(
      Date.parse(status.body.anchor.acceptance.retained_until) + 1000,
    ).toISOString();
    await env.store.transaction('test-tenant', async (tx) => {
      await tx.query(
        "UPDATE haip_requests SET data=jsonb_set(data,'{anchor,acceptance,retained_until}',to_jsonb($3::text)) WHERE tenant=$1 AND id=$2",
        ['test-tenant', review.id, nextRetention],
      );
    });
  } finally {
    resume.resolve();
    await pending;
  }
  const refused = await pending;
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'anchor_recheck_required');
  assert.equal((await env.api(`/v2/requests/${review.id}`)).body.grant_state, 'available');
});

test('fresh execution authority requires the original response, anchored receipt and signed claim', async () => {
  const fixture = await environment({ singleTenant: true });
  try {
    const review = await authorise({}, fixture);
    await fixture.flush();
    const path = `/v2/requests/${review.id}`;
    const stored = async () =>
      (
        await fixture.store.pool.query('SELECT data FROM haip_requests WHERE tenant=$1 AND id=$2', [
          'test-tenant',
          review.id,
        ])
      ).rows[0].data;
    const persist = (data: unknown) =>
      fixture.store.pool.query('UPDATE haip_requests SET data=$1 WHERE tenant=$2 AND id=$3', [
        JSON.stringify(data),
        'test-tenant',
        review.id,
      ]);
    const refuses = async (route: string, input: unknown) => {
      const result = await fixture.api(path + route, input);
      assert.equal(result.status, 409);
      assert.equal(result.body.error, 'material_integrity_mismatch');
    };
    const original = await stored();
    const input = {
      execution_identity: 'original-claim',
      execution_binding_digest: digest(review.body.execution),
    };
    await persist({
      ...original,
      candidate: { ...original.candidate, response: { choice: 'decline' } },
    });
    await refuses('/claims', input);

    const later = new Date(Date.parse(review.receipt.payload.confirmed_at) + 50).toISOString();
    const replacement = signRecord(
      { ...review.receipt.payload, confirmed_at: later },
      { ...review.receipt.protected, issued_at: later },
      fixture.service.config.signingKey,
    );
    await persist({ ...original, receipt: replacement, records: [replacement] });
    await refuses('/claims', input);
    const corruptedProof = structuredClone(original.anchor);
    corruptedProof.proof[0].head = digest('different chain node');
    await persist({ ...original, anchor: corruptedProof });
    await refuses('/claims', input);
    assert.equal((await stored()).claim, undefined);

    await persist(original);
    const registered = await fixture.api(path + '/claims', input);
    assert.equal(registered.status, 201);
    const claimed = await stored();
    const permit = {
      claim_id: registered.body.payload.id,
      execution_identity: input.execution_identity,
      nonce: 'bound-retained-claim',
    };
    await persist({
      ...claimed,
      grant_deadline: new Date(Date.parse(claimed.grant_deadline) + 1000).toISOString(),
    });
    await refuses('/admission', permit);
    const wrongClaim = {
      ...claimed.claim,
      payload: {
        ...claimed.claim.payload,
        execution_binding_digest: digest('different execution'),
      },
    };
    await persist({ ...claimed, claim: wrongClaim });
    await refuses('/admission', permit);
    const outcome = {
      status: 'completed',
      execution_identity: input.execution_identity,
      details: {},
    };
    await refuses('/outcomes', outcome);

    await persist(claimed);
    const admitted = await fixture.api(path + '/admission', permit);
    assert.equal(admitted.status, 200);
    assert.equal(admitted.body.payload.dispatch_before, review.receipt.payload.grant_deadline);
    assert.equal((await fixture.api(path + '/discard', {})).status, 200);
    const reported = await fixture.api(path + '/outcomes', outcome);
    assert.equal(reported.status, 200);
    assert.equal(reported.body.payload.claim_digest, digest(registered.body));
  } finally {
    await fixture.close();
  }
});

test('rotating a bearer stops claims and admissions already waiting for storage', async () => {
  const fixture = await environment({ singleTenant: true });
  const verify = fixture.anchor.verifyAcceptance.bind(fixture.anchor);
  async function rotateDuring(path: string, input: object, previous: string, replacement: string) {
    const inspected = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    fixture.anchor.verifyAcceptance = async (...args) => {
      await verify(...args);
      inspected.resolve();
      await resume.promise;
    };
    const pending = fixture.api(path, input, previous);
    try {
      await Promise.race([
        inspected.promise,
        pending.then(({ status }) => {
          throw new Error(`Request returned ${status} before inspecting its checkpoint`);
        }),
      ]);
      await fixture.principal(
        'producer',
        'producer',
        { enabled: true, publisher: 'publisher', owner: 'requester', routes: ['review'] },
        replacement,
      );
    } finally {
      resume.resolve();
      try {
        await pending;
      } finally {
        fixture.anchor.verifyAcceptance = verify;
      }
    }
    const refused = await pending;
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error, 'unauthenticated');
  }

  try {
    const review = await authorise({}, fixture);
    await fixture.flush();
    const path = '/v2/requests/' + review.id;
    const claimInput = {
      execution_identity: 'rotating-producer',
      execution_binding_digest: digest(review.body.execution),
    };
    const first = randomBytes(32).toString('base64url');
    await rotateDuring(path + '/claims', claimInput, fixture.credentials.producer, first);
    const afterRotation = await fixture.api(path, undefined, first);
    assert.equal(afterRotation.body.grant_state, 'available');
    assert.equal(afterRotation.body.claim, null);
    const claim = await fixture.api(path + '/claims', claimInput, first);
    assert.equal(claim.status, 201);
    const permitInput = {
      claim_id: claim.body.payload.id,
      execution_identity: claimInput.execution_identity,
      nonce: 'rotation-before-admission',
    };
    const second = randomBytes(32).toString('base64url');
    await rotateDuring(path + '/admission', permitInput, first, second);
    const permit = await fixture.api(path + '/admission', permitInput, second);
    assert.equal(permit.status, 200);
    assert.equal(permit.body.payload.dispatch_before, review.receipt.payload.grant_deadline);
  } finally {
    await fixture.close();
  }
});

test('a different version in Azure listing after a checkpoint upload fences existing grants', async () => {
  const r = await authorise();
  const claimed = await authorise();
  await env.flush();
  assert.equal((await env.api(`/v2/requests/${r.id}`)).body.grant_state, 'available');
  const claim = await env.api(`/v2/requests/${claimed.id}/claims`, {
    execution_identity: 'before-conflict',
    execution_binding_digest: digest(claimed.body.execution),
  });
  assert.equal(claim.status, 201);
  await env.flush();
  const origin = 'https://fixture.blob.core.windows.net';
  const container = 'checkpoint-fixture';
  const tokenCredential = {
    async getToken() {
      return { token: 'fixture-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  };
  const puts = new Set<string>();
  const listings = new Set<string>();
  const pipeline = newPipeline(tokenCredential, {
    retryOptions: { maxTries: 1 },
    httpClient: {
      async sendRequest(request) {
        const url = new URL(request.url);
        assert.equal(url.origin, origin);
        assert.equal(request.headers.get('authorization'), 'Bearer fixture-token');
        if (request.method === 'PUT') {
          assert.equal(request.headers.get('if-none-match'), '*');
          assert.equal(request.headers.get('x-ms-blob-type'), 'BlockBlob');
          assert.ok(url.pathname.startsWith(`/${container}/haip/`));
          puts.add(url.pathname.slice(container.length + 2));
          return {
            request,
            status: 201,
            headers: toHttpHeadersLike(
              createHttpHeaders({ 'x-ms-version-id': '2026-09-04T00:00:00.0000000Z' }),
            ),
          };
        }
        assert.equal(request.method, 'GET');
        assert.equal(url.pathname, `/${container}`);
        assert.equal(url.searchParams.get('comp'), 'list');
        const include = url.searchParams.getAll('include').flatMap((value) => value.split(','));
        assert.deepEqual(
          new Set(include),
          new Set(['versions', 'snapshots', 'deleted', 'deletedwithversions']),
        );
        const key = url.searchParams.get('prefix');
        assert.ok(key && /^[a-z0-9/.-]+$/.test(key) && puts.has(key));
        listings.add(key);
        return {
          request,
          status: 200,
          headers: toHttpHeadersLike(createHttpHeaders({ 'content-type': 'application/xml' })),
          bodyAsText: `<EnumerationResults><Blobs><Blob><Name>${key}</Name><VersionId>2026-09-04T00:00:01.0000000Z</VersionId><IsCurrentVersion>true</IsCurrentVersion><Properties><BlobType>BlockBlob</BlobType></Properties></Blob></Blobs><NextMarker/></EnumerationResults>`,
        };
      },
    },
  });
  const anchor = new AzureAnchor(origin, container, 'haip', env.trust, tokenCredential);
  Object.defineProperty(anchor, 'container', {
    value: new BlobServiceClient(origin, pipeline).getContainerClient(container),
  });
  const worker = new OutboxWorker(env.service, anchor);
  assert.equal((await env.api('/v2/requests', env.request())).status, 201);
  const due = await env.store.pool.query(
    "UPDATE haip_outbox SET next_at=clock_timestamp() WHERE tenant='test-tenant' AND checkpoint_batch_count IS NOT NULL",
  );
  assert.equal(due.rowCount, 1);
  await worker.tick();
  assert.equal(puts.size, 1);
  assert.deepEqual(listings, puts);
  const incidents = await env.store.pool.query(
    'SELECT code FROM haip_incidents WHERE tenant=$1 AND code=$2',
    ['test-tenant', 'anchor_version_conflict'],
  );
  assert.ok(incidents.rowCount);
  assert.equal(
    (
      await env.api(`/v2/requests/${r.id}/claims`, {
        execution_identity: 'fenced',
        execution_binding_digest: digest(r.body.execution),
      })
    ).body.error,
    'admission_fenced',
  );
  const admission = await env.api(`/v2/requests/${claimed.id}/admission`, {
    claim_id: claim.body.payload.id,
    nonce: 'checkpoint-conflict-test',
    execution_identity: 'before-conflict',
  });
  assert.equal(admission.status, 503);
  assert.equal(admission.body.error, 'admission_fenced');
});

test('a missing accepted checkpoint fences the tenant before the worker sees it', async () => {
  const fixture = await environment();
  try {
    const lost = await authorise({}, fixture);
    await fixture.flush();
    const intact = await authorise({}, fixture);
    await fixture.flush();
    const lostStatus = await fixture.api(`/v2/requests/${lost.id}`);
    const intactStatus = await fixture.api(`/v2/requests/${intact.id}`);
    assert.notEqual(lostStatus.body.anchor.acceptance.key, intactStatus.body.anchor.acceptance.key);
    await rm(lostStatus.body.anchor.acceptance.key);
    const claim = (review: Awaited<ReturnType<typeof authorise>>, identity: string) =>
      fixture.api(`/v2/requests/${review.id}/claims`, {
        execution_identity: identity,
        execution_binding_digest: digest(review.body.execution),
      });
    const refused = await claim(lost, 'missing-checkpoint');
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, 'anchor_version_conflict');
    const later = await claim(intact, 'intact-checkpoint');
    assert.equal(later.status, 503);
    assert.equal(later.body.error, 'admission_fenced');
    const incidents = await fixture.store.pool.query(
      'SELECT code FROM haip_incidents WHERE tenant=$1',
      ['test-tenant'],
    );
    assert.deepEqual(incidents.rows, [{ code: 'anchor_version_conflict' }]);
    assert.equal((await fixture.api(`/v2/requests/${intact.id}`)).body.audit_state, 'conflict');
  } finally {
    await fixture.close();
  }
});
