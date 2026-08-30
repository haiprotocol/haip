import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';
test('operator metrics expose own pressure, failures, uncertainty and checkpoint lag without other tenant contents', async () => {
  const env = await environment();
  try {
    await env.api('/v2/requests', env.request());
    await env.flush();
    await env.worker.cleanup();
    assert.equal((await env.api('/v2/admin/metrics')).status, 403);
    const metrics = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.requests.retained, 1);
    assert.equal(metrics.body.requests.pending, 1);
    assert.ok(metrics.body.operations.some((o: any) => o.name === 'retention' && o.succeeded_at));
    assert.ok(
      metrics.body.delivery.some((o: any) => o.kind === 'checkpoint' && o.state === 'accepted'),
    );
    const foreign = await env.api('/v2/admin/metrics', undefined, env.credentials.foreignOperator);
    assert.equal(foreign.body.requests.retained, 0);
    assert.equal(JSON.stringify(metrics.body).includes('A stored support message'), false);
    const prometheus = await fetch(env.origin + '/v2/admin/metrics.prom', {
      headers: { Authorization: 'Bearer ' + env.credentials.operator },
    });
    assert.equal(prometheus.status, 200);
    const text = await prometheus.text();
    assert.match(text, /haip_pending 1/);
    assert.match(text, /haip_operation_last_success_seconds\{operation="retention"\} [1-9]/);
    const transaction = env.store.transaction.bind(env.store);
    env.store.transaction = async () => {
      throw new Error('injected_worker_failure');
    };
    await assert.rejects(env.worker.cleanup(), /injected_worker_failure/);
    env.store.transaction = transaction;
    const failed = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert(failed.body.operations.some((o: any) => o.name === 'retention' && o.failed_at));
  } finally {
    await env.close();
  }
});
