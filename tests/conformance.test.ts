import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@haip/protocol/crypto';
import { exerciseReviewFixture } from '../conformance/review.mjs';
import { environment } from './environment.js';

test('reusable review fixtures operate solely through the public HTTP contract', async () => {
  const env = await environment();
  try {
    const result = await exerciseReviewFixture({
      origin: env.origin,
      producerToken: env.credentials.producer,
      publisherToken: env.credentials.publisher,
      otherProducerToken: env.credentials.otherProducer,
      foreignProducerToken: env.credentials.foreignProducer,
      tenant: 'test-tenant',
      producer: 'producer',
      route: 'review',
      trust: env.trust,
      bundleHtml: '<!doctype html><p>Independent fixture: use the trusted host form.</p>',
      confirm: async (link: string, id: string) => {
        assert.equal(link, env.origin + '/review/' + id);
        const human = await env.login();
        const c = await human.call(`/v2/requests/${id}/candidates`, {
          decision: 'answer',
          response: { choice: 'accept' },
        });
        assert.equal(c.status, 201);
        assert.equal(
          (
            await human.call(`/v2/requests/${id}/confirm`, {
              candidate_id: c.body.id,
              candidate_digest: digest(c.body),
            })
          ).status,
          200,
        );
      },
    });
    assert.equal(result.result, 'passed');
  } finally {
    await env.close();
  }
});
