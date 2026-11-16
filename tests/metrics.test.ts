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
    await env.store.pool.query(
      "INSERT INTO haip_operations(name,failed_at) VALUES('legacy_foreign_recovery',clock_timestamp())",
    );
    await env.store.pool.query(
      "INSERT INTO haip_tenant_operations(tenant,name,failed_at) VALUES('foreign-tenant','foreign_recovery',clock_timestamp())",
    );
    const scoped = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert(!scoped.body.operations.some((o: any) => o.name.includes('foreign')));
    assert.equal(JSON.stringify(metrics.body).includes('A stored support message'), false);
    const prometheus = await fetch(env.origin + '/v2/admin/metrics.prom', {
      headers: { Authorization: 'Bearer ' + env.credentials.operator },
    });
    assert.equal(prometheus.status, 200);
    const text = await prometheus.text();
    assert.match(text, /haip_pending 1/);
    assert.match(text, /haip_operation_last_success_seconds\{operation="retention"\} [1-9]/);
    const transaction = env.store.transaction.bind(env.store);
    env.store.transaction = async (tenant, run) => {
      if (tenant === 'test-tenant') throw new Error('injected_worker_failure');
      return transaction(tenant, run);
    };
    await assert.rejects(env.worker.cleanup(), /injected_worker_failure/);
    env.store.transaction = transaction;
    const failed = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert(failed.body.operations.some((o: any) => o.name === 'retention' && o.failed_at));
    const unaffected = await env.api(
      '/v2/admin/metrics',
      undefined,
      env.credentials.foreignOperator,
    );
    assert(!unaffected.body.operations.some((o: any) => o.name === 'retention' && o.failed_at));
    assert(
      unaffected.body.operations.some((o: any) => o.name === 'foreign_recovery' && o.failed_at),
    );
  } finally {
    await env.close();
  }
});

test('execution metrics use captured deadlines and retain reported uncertainty until reconciliation', async () => {
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request(true));
    assert.equal(created.status, 201);
    const id = created.body.request.id;
    for (const { state, relativeDispatch, outcome, unresolved, due } of [
      { state: 'claimed', relativeDispatch: 60, unresolved: 1, due: 0 },
      { state: 'claimed', relativeDispatch: -15, unresolved: 1, due: 1 },
      { state: 'admitted', relativeDispatch: -15, unresolved: 1, due: 0 },
      { state: 'admitted', relativeDispatch: -65, unresolved: 1, due: 1 },
      { state: 'uncertain', relativeDispatch: 60, outcome: 'uncertain', unresolved: 1, due: 1 },
      { state: 'completed', relativeDispatch: -65, outcome: 'completed', unresolved: 0, due: 0 },
    ]) {
      await env.store.pool.query(
        "UPDATE haip_requests SET data=(data - 'outcome') || $2::jsonb WHERE id=$1",
        [
          id,
          JSON.stringify({
            execution_state: state,
            claim: {
              payload: {
                dispatch_before: new Date(Date.now() + relativeDispatch * 1000).toISOString(),
                execution_seconds: 60,
              },
            },
            ...(outcome ? { outcome: { payload: { outcome: { status: outcome } } } } : {}),
          }),
        ],
      );
      const { status, body } = await env.api(
        '/v2/admin/metrics',
        undefined,
        env.credentials.operator,
      );
      assert.equal(status, 200);
      assert.equal(body.requests.unresolved_execution, unresolved, state);
      assert.equal(body.requests.execution_reconciliation_due, due, state);
    }
    const prometheus = await fetch(env.origin + '/v2/admin/metrics.prom', {
      headers: { Authorization: 'Bearer ' + env.credentials.operator },
    });
    assert.match(await prometheus.text(), /^haip_execution_reconciliation_due 0$/m);
  } finally {
    await env.close();
  }
});
