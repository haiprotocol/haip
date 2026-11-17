import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, verifyRecord } from '@haip/protocol/crypto';
import { environment } from './environment.js';

let env: Awaited<ReturnType<typeof environment>>;
before(async () => {
  env = await environment();
});
after(async () => env?.close());

async function startReview() {
  const created = await env.api('/v2/requests', env.request());
  assert.equal(created.status, 201);
  const { request } = created.body;
  const path = `/v2/requests/${request.id}`;
  const handoff = `/v2/hitl/${request.id}`;
  return { request, path, handoff, poll: handoff + '/poll' };
}

async function confirm(
  path: string,
  decision: string,
  human: Awaited<ReturnType<typeof env.login>>,
) {
  const candidate = await human.call(path + '/candidates', {
    decision,
    response: { choice: 'accept' },
  });
  assert.equal(candidate.status, 201);
  const receipt = await human.call(path + '/confirm', {
    candidate_id: candidate.body.id,
    candidate_digest: digest(candidate.body),
  });
  assert.equal(receipt.status, 200);
  return receipt.body;
}

test('the HITL input handoff uses the pinned release defaults and preserves the signed decision', async () => {
  const human = await env.login();
  for (const decision of ['answer', 'approve', 'reject']) {
    const { request, path, handoff, poll } = await startReview();
    const offered = await env.api(handoff);
    assert.equal(offered.status, 202);
    assert.deepEqual(offered.body, {
      status: 'human_input_required',
      hitl: {
        spec_version: '0.8',
        case_id: request.id,
        review_url: `${env.origin}/review/${request.id}`,
        poll_url: env.origin + poll,
        type: 'input',
        prompt: request.summary,
        timeout: `PT${request.limits.review_seconds}S`,
        default_action: 'abort',
        created_at: request.accepted_at,
        expires_at: request.review_deadline,
      },
    });
    const browser = await fetch(offered.body.hitl.review_url, { redirect: 'manual' });
    assert.equal(browser.status, 302);
    const pending = await env.api(poll);
    assert.deepEqual(pending.body, {
      case_id: request.id,
      status: 'pending',
      created_at: request.accepted_at,
      expires_at: request.review_deadline,
    });
    const receipt = await confirm(path, decision, human);
    const completed = await env.api(poll);
    assert.equal(completed.status, 200);
    assert.deepEqual(completed.body, {
      case_id: request.id,
      status: 'completed',
      created_at: request.accepted_at,
      completed_at: receipt.payload.confirmed_at,
      result: {
        action: 'submit',
        data: {
          response: { choice: 'accept' },
          haip_receipt: receipt,
          audit_state: 'pending',
          material_available: true,
        },
      },
    });
    assert.equal(receipt.payload.decision, decision);
    verifyRecord(receipt, env.trust, {
      issuer: env.origin,
      tenant: 'test-tenant',
      audience: 'producer',
      type: 'DecisionReceipt',
      purpose: 'review',
    });
    assert.deepEqual((await env.api(handoff)).body, completed.body);
  }
});

test('HITL cancellation, supersession and expiry preserve real terminal times', async () => {
  for (const operation of ['cancel', 'supersede']) {
    const { request, path, poll } = await startReview();
    const changed = await env.api(
      path + '/' + operation,
      operation === 'cancel' ? {} : env.request(),
    );
    assert.equal(changed.status, operation === 'cancel' ? 200 : 201);
    const events = await env.api('/v2/events');
    const terminal = events.body.items.find(
      ({ payload }: { payload: { request_id: string; reason: string } }) =>
        payload.request_id === request.id &&
        payload.reason === (operation === 'cancel' ? 'cancelled' : 'supersession'),
    );
    const closed = await env.api(poll);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'cancelled');
    assert.equal(closed.body.created_at, request.accepted_at);
    assert.equal(closed.body.cancelled_at, terminal?.protected.issued_at);
    assert.ok(Date.parse(closed.body.cancelled_at) >= Date.parse(request.accepted_at));
    assert.equal((await env.api(path + '/cancel', {})).status, 200);
    assert.deepEqual((await env.api(poll)).body, closed.body);
  }

  const discarded = await startReview();
  assert.equal((await env.api(discarded.path + '/discard', {})).status, 200);
  const discardedAt = (
    await env.store.pool.query<{ discarded: string }>(
      "SELECT data->>'private_discard_at' AS discarded FROM haip_requests WHERE tenant=$1 AND id=$2",
      ['test-tenant', discarded.request.id],
    )
  ).rows[0]!.discarded;
  const privateExpiry = await env.api(discarded.poll);
  assert.equal(privateExpiry.body.status, 'expired');
  assert.equal(privateExpiry.body.expired_at, discardedAt);
  assert.equal(privateExpiry.body.default_action, 'abort');
  assert.ok(Date.parse(discardedAt) < Date.parse(discarded.request.review_deadline));

  try {
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: { ...env.route.limits, review_seconds: 1 },
    });
    const short = await startReview();
    const deadline = Date.parse(short.request.review_deadline);
    await delay(Math.max(0, deadline - Date.now()) + 50);
    const expired = await env.api(short.poll);
    assert.equal(expired.body.status, 'expired');
    assert.equal(expired.body.expired_at, short.request.review_deadline);
    assert.equal((await env.api(short.path + '/cancel', {})).body.decision_state, 'expired');
    assert.deepEqual((await env.api(short.poll)).body, expired.body);
  } finally {
    await env.put('/v2/admin/routes/review', env.route);
  }
});

test('HITL polling scopes private responses and refuses a changed response under a signed receipt', async () => {
  await env.put('/v2/admin/routes/review', { ...env.route, reviewers: ['reviewer', 'reviewer2'] });
  const owner = await env.login('requester');
  const reviewer = await env.login();
  const { request, path, handoff, poll } = await startReview();
  assert.equal((await owner.call(handoff)).status, 202);
  for (const route of [handoff, poll]) {
    assert.equal((await fetch(env.origin + route)).status, 401);
    for (const bearer of [
      env.credentials.otherProducer,
      env.credentials.foreignProducer,
      env.credentials.publisher,
    ]) {
      assert.equal((await env.api(route, undefined, bearer)).status, 404);
    }
  }

  const execution = await env.api('/v2/requests', env.request(true));
  assert.equal(execution.status, 201);
  for (const suffix of ['', '/poll']) {
    const refused = await env.api('/v2/hitl/' + execution.body.request.id + suffix);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'hitl_review_only');
  }

  const receipt = await confirm(path, 'answer', reviewer);
  const reviewerResult = await reviewer.call(poll);
  assert.equal(reviewerResult.status, 200);
  assert.deepEqual(reviewerResult.body.result.data.response, { choice: 'accept' });
  await env.store.pool.query(
    `UPDATE haip_requests SET data=jsonb_set(data,'{candidate,response,choice}',to_jsonb($3::text))
     WHERE tenant=$1 AND id=$2`,
    ['test-tenant', request.id, 'decline'],
  );
  const changed = await env.api(poll);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'material_integrity_mismatch');

  const different = await startReview();
  const otherReceipt = await confirm(different.path, 'answer', reviewer);
  const replaceReceipt = (replacement: unknown) =>
    env.store.pool.query(
      `UPDATE haip_requests SET data=jsonb_set(data,'{receipt}',$3::jsonb) WHERE tenant=$1 AND id=$2`,
      ['test-tenant', request.id, JSON.stringify(replacement)],
    );
  await replaceReceipt(otherReceipt);
  const mismatched = await owner.call(poll);
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.body.error, 'material_integrity_mismatch');
  await replaceReceipt(receipt);

  const readReceipt = await owner.call(poll);
  assert.equal(readReceipt.status, 200);
  assert.deepEqual(readReceipt.body.result.data, {
    response: null,
    haip_receipt: receipt,
    audit_state: 'pending',
    material_available: false,
  });
  assert.equal((await env.api(path + '/discard', {})).status, 200);
  const discarded = await env.api(poll);
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.status, 'completed');
  assert.deepEqual(discarded.body.result.data, readReceipt.body.result.data);
});
