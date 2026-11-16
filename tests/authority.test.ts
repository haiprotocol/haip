import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toHttpHeadersLike } from '@azure/core-http-compat';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import { BlobServiceClient, newPipeline } from '@azure/storage-blob';
import { environment } from './environment.js';
import { HAIPClient, verifyExecutionAuthority } from '@haip/sdk';
import { digest, canonicalise, signRecord } from '@haip/protocol/crypto';
import { AzureAnchor } from '../haip-server/src/anchor.js';
import { OutboxWorker } from '../haip-server/src/worker.js';
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
  await worker.tick();
  assert.ok(puts.size > 0);
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
