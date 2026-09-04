import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@haip/protocol/crypto';
import { environment } from './environment.js';

async function rewriteStoredRequest(
  env: Awaited<ReturnType<typeof environment>>,
  id: string,
  change: (request: Record<string, any>) => void,
) {
  const result = await env.store.pool.query(
    'SELECT data FROM haip_requests WHERE tenant=$1 AND id=$2',
    ['test-tenant', id],
  );
  const data = result.rows[0].data;
  change(data.request);
  data.request_digest = digest(data.request);
  await env.store.pool.query('UPDATE haip_requests SET data=$1 WHERE tenant=$2 AND id=$3', [
    JSON.stringify(data),
    'test-tenant',
    id,
  ]);
}

test('retired requests remain visible and revocable but do not gain review or execution authority', async () => {
  const env = await environment();
  try {
    const human = await env.login();
    const review = await env.api('/v2/requests', env.request());
    assert.equal(review.status, 201, JSON.stringify(review.body));
    const reviewId = review.body.request.id;
    const candidate = await human.call(`/v2/requests/${reviewId}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201, JSON.stringify(candidate.body));
    await rewriteStoredRequest(env, reviewId, (request) => {
      request.protocol_revision = '2.0.0-draft.2';
      request.profiles['haip.agent-ui'] = '1';
    });
    const visible = await env.api(`/v2/requests/${reviewId}`);
    assert.equal(visible.status, 200);
    assert.equal(visible.body.request.protocol_revision, '2.0.0-draft.2');
    assert(
      (await env.api('/v2/requests')).body.items.some(
        (item: { id: string }) => item.id === reviewId,
      ),
    );
    for (const result of [
      await human.call(`/v2/requests/${reviewId}/candidates`, {
        decision: 'answer',
        response: { choice: 'decline' },
      }),
      await human.call(`/v2/requests/${reviewId}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      }),
      await env.api(`/v2/requests/${reviewId}/remind`, {}),
    ]) {
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { error: 'unsupported_revision' });
    }
    const cancelled = await env.api(`/v2/requests/${reviewId}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.decision_state, 'cancelled');
    assert.equal((await env.api(`/v2/requests/${reviewId}/discard`, {})).status, 200);
    const discarded = await env.store.pool.query(
      'SELECT material,data FROM haip_requests WHERE tenant=$1 AND id=$2',
      ['test-tenant', reviewId],
    );
    assert.equal(discarded.rows[0].material, null);
    assert.equal(discarded.rows[0].data.material_deleted, true);

    const oldProfile = await env.api('/v2/requests', env.request());
    assert.equal(oldProfile.status, 201, JSON.stringify(oldProfile.body));
    const oldProfileId = oldProfile.body.request.id;
    await rewriteStoredRequest(env, oldProfileId, (request) => {
      request.profiles['haip.agent-ui'] = '1';
    });
    const rejectedProfile = await human.call(`/v2/requests/${oldProfileId}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(rejectedProfile.status, 409);
    assert.deepEqual(rejectedProfile.body, { error: 'unsupported_profile' });
    assert.equal((await env.api(`/v2/requests/${oldProfileId}`)).status, 200);
    assert.equal((await env.api(`/v2/requests/${oldProfileId}/cancel`, {})).status, 200);

    const executionInput = env.request(true);
    const execution = await env.api('/v2/requests', executionInput);
    assert.equal(execution.status, 201, JSON.stringify(execution.body));
    const executionId = execution.body.request.id;
    const executionCandidate = await human.call(`/v2/requests/${executionId}/candidates`, {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
    assert.equal(executionCandidate.status, 201, JSON.stringify(executionCandidate.body));
    const receipt = await human.call(`/v2/requests/${executionId}/confirm`, {
      candidate_id: executionCandidate.body.id,
      candidate_digest: digest(executionCandidate.body),
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    await env.flush();
    await rewriteStoredRequest(env, executionId, (request) => {
      request.protocol_revision = '2.0.0-draft.2';
      request.profiles['haip.agent-ui'] = '1';
    });
    const claim = await env.api(`/v2/requests/${executionId}/claims`, {
      execution_identity: 'retired-request',
      execution_binding_digest: digest(executionInput.execution),
    });
    assert.equal(claim.status, 409);
    assert.deepEqual(claim.body, { error: 'unsupported_revision' });
    assert.equal((await env.api(`/v2/requests/${executionId}`)).body.grant_state, 'available');
    const revoked = await env.api(`/v2/requests/${executionId}/revoke`, {});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.grant_state, 'revoked');
  } finally {
    await env.close();
  }
});
