import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest, verifyRecord } from '@haip/protocol/crypto';
import { PROTOCOL_REVISION } from '@haip/protocol';

/** Public HTTP only. Provision an isolated tenant and perform confirmation through its real host. */
export async function exerciseReviewFixture({
  origin,
  producerToken,
  publisherToken,
  otherProducerToken,
  foreignProducerToken,
  tenant,
  producer,
  route,
  trust,
  bundleHtml,
  confirm,
}) {
  assert.equal(new URL(origin).origin, origin);
  const call = async (path, body, token = producerToken, idempotency = randomUUID()) => {
    const response = await fetch(origin + path, {
      redirect: 'error',
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const discovery = await call('/.well-known/haip');
  assert.equal(discovery.status, 200);
  assert(discovery.body.revisions.includes(PROTOCOL_REVISION));
  const bundle = await call(
    '/v2/bundles',
    {
      html: bundleHtml,
      compatibility: { agent_ui: '1' },
      author: 'HAIP HTTP fixture',
      licence: 'MIT',
    },
    publisherToken,
  );
  assert.equal(bundle.status, 201);
  const payload = { question: 'Choose one support response', choices: ['accept', 'decline'] };
  const input = {
    protocol_revision: PROTOCOL_REVISION,
    purpose: 'review',
    profiles: { 'haip.agent-ui': '1' },
    route,
    summary: 'Independent structured-choice fixture',
    bundle_id: bundle.body.id,
    artefact: {
      digest: digest(payload),
      representation: 'application/json',
      digest_rules: 'rfc8785-sha256',
    },
    payload,
    review_document: 'Choose accept or decline. This review has no execution authority.',
    response_schema: {
      type: 'object',
      properties: { choice: { enum: ['accept', 'decline'] } },
      required: ['choice'],
      additionalProperties: false,
    },
    metadata: { fixture_id: randomUUID(), future_optional: { meaning: 'non-authorising' } },
  };
  assert.equal(
    (
      await call('/v2/requests', {
        ...input,
        profiles: { 'haip.agent-ui': '1', unsupported: 'unknown' },
      })
    ).status,
    422,
  );
  const key = randomUUID(),
    created = await call('/v2/requests', input, producerToken, key);
  assert.equal(created.status, 201);
  assert.deepEqual((await call('/v2/requests', input, producerToken, key)).body, created.body);
  assert.equal(
    (await call('/v2/requests', { ...input, summary: 'Changed content' }, producerToken, key))
      .status,
    409,
  );
  const id = created.body.request.id,
    path = '/v2/requests/' + id;
  for (const token of [otherProducerToken, foreignProducerToken, publisherToken]) {
    for (const suffix of ['', '/material', '/export'])
      assert.equal((await call(path + suffix, undefined, token)).status, 404);
    if (token !== publisherToken) {
      assert.equal((await call(path + '/cancel', {}, token)).status, 404);
      assert.equal((await call('/v2/requests', input, token)).status, 404);
    }
  }
  await confirm(created.body.review_link, id);
  const status = (await call(path)).body;
  assert.equal(status.decision_state, 'confirmed');
  assert.equal(status.request.execution, undefined);
  assert.equal(status.grant_state, 'not_applicable');
  assert.equal(status.execution_state, 'not_applicable');
  assert.deepEqual(status.request.metadata, input.metadata);
  verifyRecord(status.receipt, trust, {
    issuer: origin,
    audience: producer,
    tenant,
    type: 'DecisionReceipt',
    purpose: 'review',
  });
  assert.equal(status.receipt.payload.request_digest, digest(status.request));
  const exported = (await call(path + '/export')).body;
  assert.equal(
    status.receipt.payload.response_digest,
    digest(exported.material.candidate.response),
  );
  assert.equal(
    (
      await call(path + '/claims', {
        execution_identity: randomUUID(),
        execution_binding_digest: digest({}),
      })
    ).status,
    409,
  );
  let cursor = 0,
    found = false;
  for (let pages = 0; pages < 100; pages++) {
    const events = (await call('/v2/events?after=' + cursor)).body;
    for (const event of events.items)
      if (event.payload.request_id === id && event.payload.reason === 'decision') {
        verifyRecord(event, trust, {
          issuer: origin,
          audience: producer,
          tenant,
          type: 'RequestChangedEvent',
          purpose: 'review',
        });
        found = true;
      }
    if (events.next === cursor || !events.items.length || found) break;
    cursor = events.next;
  }
  assert(found, 'confirmed decision must be available through producer events');
  return { request_id: id, result: 'passed', purpose: 'review', execution_authority: false };
}
