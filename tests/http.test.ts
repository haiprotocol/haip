import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';
import { digest, verifyRecord } from '@haip/protocol/crypto';
let env: Awaited<ReturnType<typeof environment>>;
before(async () => {
  env = await environment();
});
after(async () => {
  await env?.close();
});
async function confirm(
  id: string,
  decision = 'answer',
  response: unknown = { choice: 'accept', score: 0.1 },
) {
  const human = await env.login();
  const c = await human.call(`/v2/requests/${id}/candidates`, { decision, response });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const receipt = await human.call(`/v2/requests/${id}/confirm`, {
    candidate_id: c.body.id,
    candidate_digest: digest(c.body),
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  return { receipt: receipt.body, human, candidate: c.body };
}
test('ordinary HTTP structured review produces an authenticated signed receipt without execution fields', async () => {
  const created = await env.api('/v2/requests', env.request());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.request.execution, undefined);
  assert.equal(created.body.grant_state, 'not_applicable');
  const id = created.body.request.id,
    { receipt } = await confirm(id);
  verifyRecord(receipt, env.trust, {
    issuer: env.origin,
    audience: 'producer',
    type: 'DecisionReceipt',
    tenant: 'test-tenant',
    purpose: 'review',
  });
  const status = await env.api(`/v2/requests/${id}`);
  assert.equal(status.body.audit_state, 'pending');
  assert.equal(
    status.body.receipt.payload.response_digest,
    digest({ choice: 'accept', score: 0.1 }),
  );
  const claim = await env.api(`/v2/requests/${id}/claims`, {
    execution_identity: 'x',
    execution_binding_digest: digest({}),
  });
  assert.equal(claim.status, 409);
  assert.equal(claim.body.error, 'execution_purpose_required');
  await env.flush();
  const anchored = await env.api(`/v2/requests/${id}`);
  assert.equal(anchored.body.audit_state, 'anchored');
  assert.equal(anchored.body.grant_state, 'not_applicable');
  const events = await env.api('/v2/events');
  assert(
    events.body.items.some(
      (x: any) => x.payload.request_id === id && x.payload.reason === 'decision',
    ),
  );
});
test('exclusive claim, fresh admission, outcomes and replays keep one execution identity', async () => {
  const input = env.request(true),
    created = await env.api('/v2/requests', input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request.id;
  await confirm(id, 'authorise');
  const claimInput = {
    execution_identity: 'counter-once',
    execution_binding_digest: digest(input.execution),
  };
  assert.equal(
    (await env.api(`/v2/requests/${id}/claims`, claimInput)).body.error,
    'pending_anchor',
  );
  await env.flush();
  assert.equal(
    (
      await env.api(`/v2/requests/${id}/claims`, {
        ...claimInput,
        execution_binding_digest: digest({ changed: true }),
      })
    ).status,
    409,
  );
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      env.api(`/v2/requests/${id}/claims`, { ...claimInput, execution_identity: 'counter-' + i }),
    ),
  );
  assert.equal(attempts.filter((x) => x.status === 201).length, 1);
  const claim = attempts.find((x) => x.status === 201)!.body;
  verifyRecord(claim, env.trust, {
    issuer: env.origin,
    audience: 'producer',
    type: 'ExecutionClaim',
    purpose: 'authorise_execution',
  });
  const admission = await env.api(`/v2/requests/${id}/admission`, {
    claim_id: claim.payload.id,
    execution_identity: claim.payload.execution_identity,
    nonce: 'fresh_nonce_123456789',
  });
  assert.equal(admission.status, 200, JSON.stringify(admission.body));
  verifyRecord(admission.body, env.trust, {
    issuer: env.origin,
    audience: 'producer',
    type: 'AdmissionStatus',
    purpose: 'authorise_execution',
  });
  assert.equal(admission.body.payload.claim_digest, digest(claim));
  assert.equal(admission.body.payload.dispatch_before, claim.payload.dispatch_before);
  assert.equal(
    (
      await env.api(`/v2/requests/${id}/admission`, {
        claim_id: claim.payload.id,
        execution_identity: claim.payload.execution_identity,
        nonce: 'fresh_nonce_123456789',
      })
    ).status,
    409,
  );
  const outcome = {
    execution_identity: claim.payload.execution_identity,
    status: 'completed',
    details: { counter: 1 },
  };
  const result = await env.api(`/v2/requests/${id}/outcomes`, outcome);
  assert.equal(result.status, 200);
  assert.deepEqual((await env.api(`/v2/requests/${id}/outcomes`, outcome)).body, result.body);
  assert.equal(
    (await env.api(`/v2/requests/${id}/outcomes`, { ...outcome, status: 'uncertain' })).status,
    409,
  );
  assert.equal((await env.api('/v2/requests', input)).status, 409);
});
test('tenant, producer and publisher ownership is checked without existence leaks', async () => {
  const registered = await env.api(
    '/v2/bundles',
    {
      html: '<!doctype html><p>Test</p>',
      compatibility: { agent_ui: '1' },
      author: 'Fixture author',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(registered.status, 201);
  const input = env.request(false, {
    bundle_id: registered.body.id,
    profiles: { 'haip.agent-ui': '1' },
  });
  const created = await env.api('/v2/requests', input);
  assert.equal(created.status, 201);
  const id = created.body.request.id;
  for (const token of [
    env.credentials.otherProducer,
    env.credentials.foreignProducer,
    env.credentials.publisher,
  ])
    for (const path of [
      `/v2/requests/${id}`,
      `/v2/requests/${id}/export`,
      `/v2/requests/${id}/material`,
    ])
      assert.equal((await env.api(path, undefined, token)).status, 404);
  for (const token of [env.credentials.otherProducer, env.credentials.foreignProducer]) {
    assert.equal((await env.api('/v2/requests', input, token)).status, 404);
    for (const [operation, body] of Object.entries({
      cancel: {},
      discard: {},
      remind: {},
      supersede: env.request(),
      claims: { execution_identity: 'foreign', execution_binding_digest: digest({}) },
      admission: { claim_id: id, execution_identity: 'foreign', nonce: 'foreign_nonce_12345678' },
      outcomes: { execution_identity: 'foreign', status: 'completed', details: {} },
    }))
      assert.equal(
        (await env.api(`/v2/requests/${id}/${operation}`, body, token)).status,
        404,
        operation,
      );
    assert(
      !(await env.api('/v2/events', undefined, token)).body.items.some(
        (e: any) => e.payload.request_id === id,
      ),
    );
  }
  assert.equal(
    (
      await env.api(
        `/v2/requests/${id}/reconcile`,
        {
          execution_identity: 'foreign',
          status: 'abandoned',
          details: { reason: 'test', evidence: 'test' },
        },
        env.credentials.foreignOperator,
      )
    ).status,
    404,
  );
});
test('producer cannot confirm; human separation, CSRF and frozen candidates are enforced', async () => {
  const created = await env.api('/v2/requests', env.request()),
    id = created.body.request.id;
  assert.equal(
    (await env.api(`/v2/requests/${id}/confirm`, { candidate_id: 'x', candidate_digest: 'x' }))
      .status,
    403,
  );
  const requester = await env.login('requester');
  assert.equal(
    (
      await requester.call(`/v2/requests/${id}/candidates`, {
        decision: 'approve',
        response: { choice: 'accept' },
      })
    ).status,
    403,
  );
  const human = await env.login();
  assert.equal(
    (
      await human.call(
        `/v2/requests/${id}/candidates`,
        { decision: 'approve', response: { choice: 'accept' } },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  const first = await human.call(`/v2/requests/${id}/candidates`, {
    decision: 'approve',
    response: { choice: 'accept' },
  });
  const second = await human.call(`/v2/requests/${id}/candidates`, {
    decision: 'reject',
    response: { choice: 'decline' },
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(
    (
      await human.call(`/v2/requests/${id}/confirm`, {
        candidate_id: first.body.id,
        candidate_digest: digest(first.body),
      })
    ).status,
    409,
  );
  const receipts = await Promise.all(
    Array.from({ length: 5 }, () =>
      human.call(`/v2/requests/${id}/confirm`, {
        candidate_id: second.body.id,
        candidate_digest: digest(second.body),
      }),
    ),
  );
  assert.equal(receipts.filter((x) => x.status === 200).length, 1);
});
test('creation idempotency, unsupported profiles and ambiguous JSON reject without downgrade', async () => {
  const input = env.request(false, {
      metadata: { future: { authorising: false, value: 'retained' } },
    }),
    headers = { 'Idempotency-Key': 'same-input' };
  const first = await env.api('/v2/requests', input, undefined, 'POST', headers),
    second = await env.api('/v2/requests', input, undefined, 'POST', headers);
  assert.deepEqual(second.body, first.body);
  assert.equal(
    (await env.api('/v2/requests', { ...input, summary: 'changed' }, undefined, 'POST', headers))
      .status,
    409,
  );
  assert.equal(
    (await env.api('/v2/requests', env.request(false, { profiles: { unknown: '99' } }))).status,
    422,
  );
  assert.equal(
    (await env.api('/v2/requests', '{"purpose":"review","purpose":"authorise_execution"}')).status,
    400,
  );
  assert.equal(
    (
      await env.api(
        '/v2/requests',
        env.request(false, { response_schema: { $ref: 'https://evil.invalid/schema' } }),
      )
    ).status,
    400,
  );
  assert.equal(first.body.request.metadata.future.value, 'retained');
});
test('targeted revocation survives re-adding a reviewer and issued permits remain historical', async () => {
  const input = env.request(true),
    created = await env.api('/v2/requests', input),
    id = created.body.request.id;
  await confirm(id, 'authorise');
  await env.flush();
  await env.put('/v2/admin/routes/review', {
    ...env.route,
    reviewers: [...env.route.reviewers, 'unrelated'],
  });
  assert.equal((await env.api(`/v2/requests/${id}`)).body.grant_state, 'available');
  const claim = await env.api(`/v2/requests/${id}/claims`, {
    execution_identity: 'revocation-test',
    execution_binding_digest: digest(input.execution),
  });
  assert.equal(claim.status, 201);
  const body = {
    claim_id: claim.body.payload.id,
    execution_identity: 'revocation-test',
    nonce: 'before_revoke_12345678',
  };
  const permit = await env.api(`/v2/requests/${id}/admission`, body);
  assert.equal(permit.status, 200);
  await env.put('/v2/admin/routes/review', { ...env.route, reviewers: ['reviewer2', 'requester'] });
  await env.put('/v2/admin/routes/review', env.route);
  assert.equal(
    (await env.api(`/v2/requests/${id}/admission`, { ...body, nonce: 'after_revoke_123456789' }))
      .status,
    409,
  );
  verifyRecord(permit.body, env.trust, {
    issuer: env.origin,
    audience: 'producer',
    type: 'AdmissionStatus',
    purpose: 'authorise_execution',
  });
});
test('supersession atomically invalidates old candidates and preserves occurrence identity', async () => {
  const input = env.request(true),
    created = await env.api('/v2/requests', input),
    id = created.body.request.id;
  const human = await env.login(),
    candidate = await human.call(`/v2/requests/${id}/candidates`, {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
  const next = await env.api(`/v2/requests/${id}/supersede`, {
    ...input,
    summary: 'Revised context',
  });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal(
    next.body.request.execution.action_occurrence_id,
    input.execution!.action_occurrence_id,
  );
  assert.equal(
    (
      await human.call(`/v2/requests/${id}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      })
    ).status,
    409,
  );
});
test('independent bounded HTTP counter validates authority and never repeats its effect', async () => {
  const { HAIPClient } = await import('@haip/sdk');
  const { runCounter } = await import('../examples/http/counter.js');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { canonicalise, digestBytes } = await import('@haip/protocol/crypto');
  const directory = await mkdtemp(join(tmpdir(), 'haip-counter-'));
  try {
    const input = env.request(true),
      created = await env.api('/v2/requests', input),
      id = created.body.request.id;
    assert.equal(created.status, 201);
    await confirm(id, 'authorise');
    await env.flush();
    const options = {
      client: new HAIPClient(env.origin, env.credentials.producer, true),
      requestId: id,
      directory,
      trust: env.trust,
      tenant: 'test-tenant',
      producer: 'producer',
      verifyAnchor: async (checkpoint: any, acceptance: any) => {
        assert.equal(acceptance.backend, 'test_filesystem');
        assert.equal(await readFile(acceptance.key, 'utf8'), canonicalise(checkpoint));
        assert.equal(acceptance.digest, digestBytes(canonicalise(checkpoint)));
      },
    };
    const report = options.client.outcome.bind(options.client);
    let lostReport = true;
    options.client.outcome = async (...args) => {
      if (lostReport) {
        lostReport = false;
        throw new Error('Test outcome connection lost');
      }
      return report(...args);
    };
    await assert.rejects(() => runCounter(options), /Test outcome connection lost/);
    assert.equal(JSON.parse(await readFile(join(directory, 'counter.json'), 'utf8')).count, 1);
    const first = await runCounter(options),
      second = await runCounter(options);
    assert.equal(first.count, 1);
    assert.deepEqual(second, first);
    assert.equal(JSON.parse(await readFile(join(directory, 'counter.json'), 'utf8')).count, 1);
    assert.equal((await env.api('/v2/requests/' + id)).body.execution_state, 'completed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('HITL browser/poll mapping uses the same authoritative lifecycle and never executes', async () => {
  const created = await env.api('/v2/requests', env.request()),
    id = created.body.request.id;
  const pending = await env.api('/v2/hitl/' + id);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.hitl.spec_version, '0.8');
  assert.equal(pending.body.hitl.submit_url, undefined);
  assert.equal((await env.api(`/v2/hitl/${id}/poll`)).body.status, 'pending');
  await confirm(id);
  const completed = await env.api(`/v2/hitl/${id}/poll`);
  assert.equal(completed.body.status, 'completed');
  assert.equal(completed.body.result.data.response.choice, 'accept');
});
