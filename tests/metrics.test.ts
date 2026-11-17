import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@haip/protocol/crypto';
import { environment } from './environment.js';
test('operator metrics expose own pressure, failures, uncertainty and checkpoint lag without other tenant contents', async () => {
  const env = await environment();
  try {
    await env.api('/v2/requests', env.request());
    await env.store.pool.query(
      "UPDATE haip_outbox SET next_at=clock_timestamp() WHERE tenant='test-tenant' AND checkpoint_batch_count IS NOT NULL",
    );
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

test('Prometheus counts claim conflicts, authorisation refusals and evidence failures per tenant', async () => {
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request(true));
    assert.equal(created.status, 201);
    const request = created.body.request;
    const path = `/v2/requests/${request.id}`;
    const proposal = { decision: 'authorise', response: { choice: 'accept' } };
    const requester = await env.login('requester');
    const selfReview = await requester.call(path + '/candidates', proposal);
    assert.equal(selfReview.body.error, 'separation_of_duties');
    const reviewer = await env.login();
    const candidate = await reviewer.call(path + '/candidates', proposal);
    assert.equal(candidate.status, 201);
    const receipt = await reviewer.call(path + '/confirm', {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    assert.equal(receipt.status, 200);
    await env.flush();

    const claim = {
      execution_identity: 'first-claim',
      execution_binding_digest: digest(request.execution),
    };
    assert.equal((await env.api(path + '/claims', claim)).status, 201);
    const conflict = await env.api(path + '/claims', {
      ...claim,
      execution_identity: 'second-claim',
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'grant_unavailable');

    await env.store.pool.query(
      "UPDATE haip_requests SET data=jsonb_set(data,'{request_digest}',to_jsonb($2::text)) WHERE id=$1",
      [request.id, digest('altered request')],
    );
    const altered = await env.api(path + '/material');
    assert.equal(altered.status, 409);
    assert.equal(altered.body.error, 'material_integrity_mismatch');

    const scrape = async (credential: string) => {
      const response = await fetch(env.origin + '/v2/admin/metrics.prom', {
        headers: { Authorization: 'Bearer ' + credential },
      });
      assert.equal(response.status, 200);
      return response.text();
    };
    const own = await scrape(env.credentials.operator);
    const foreign = await scrape(env.credentials.foreignOperator);
    for (const metric of [
      'execution_claim_conflicts',
      'authorisation_refusals',
      'evidence_failures',
    ]) {
      assert.match(own, new RegExp(`^haip_${metric}_total 1$`, 'm'));
      assert.match(foreign, new RegExp(`^haip_${metric}_total 0$`, 'm'));
    }
    assert.match(own, /^haip_http_conflicts_total 2$/m);
    const json = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert.deepEqual(Object.keys(json.body.http_since_process_start).sort(), [
      'conflicts',
      'failures',
      'total',
    ]);
  } finally {
    await env.close();
  }
});

test('review pressure reflects the live inbox before cleanup', async () => {
  const env = await environment({ singleTenant: true });
  try {
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      reviewers: ['reviewer', 'reviewer2'],
    });
    await env.put('/v2/admin/routes/another-review', { ...env.route, reviewers: ['reviewer'] });
    const active = await env.api('/v2/requests', env.request());
    assert.equal(active.status, 201);
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const expired = [
      { field: ['request', 'review_deadline'], value: expiredAt },
      { field: ['request', 'private_delete_at'], value: expiredAt },
      { field: ['private_discard_at'], value: expiredAt },
      { field: ['request', 'audit_delete_at'], value: expiredAt },
      { field: ['material_deleted'], value: true },
    ];
    for (const { field, value } of expired) {
      const created = await env.api('/v2/requests', env.request());
      assert.equal(created.status, 201);
      await env.store.pool.query(
        `UPDATE haip_requests SET data=jsonb_set(data,$2::text[],$3::jsonb),
         created_at=clock_timestamp()-interval '3 hours' WHERE id=$1`,
        [created.body.request.id, field, JSON.stringify(value)],
      );
    }
    const inbox = await env.api('/v2/requests?state=pending', undefined, env.credentials.operator);
    assert.equal(inbox.status, 200);
    assert.deepEqual(
      inbox.body.items.map((item: { id: string }) => item.id),
      [active.body.request.id],
    );

    const metrics = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.requests.retained, 6);
    assert.equal(metrics.body.requests.pending, 1);
    assert(metrics.body.requests.oldest_pending_seconds >= 0);
    assert(metrics.body.requests.oldest_pending_seconds < 60);
    assert.equal(metrics.body.enabled_reviewers, 2);
    assert.equal(metrics.body.pending_per_reviewer, 0.5);
    const response = await fetch(env.origin + '/v2/admin/metrics.prom', {
      headers: { Authorization: 'Bearer ' + env.credentials.operator },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /^haip_pending 1$/m);
    assert.match(text, /^haip_pending_per_reviewer 0\.5$/m);
    await env.principal('reviewer2', 'human', {
      enabled: true,
      identity_certain: false,
      oidc_issuer: env.service.config.oidc.issuer,
      oidc_subject: 'reviewer2',
    });
    const reduced = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert.equal(reduced.body.enabled_reviewers, 1);
    assert.equal(reduced.body.pending_per_reviewer, 1);
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
