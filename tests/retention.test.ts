import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';
import { digest } from '@haip/protocol/crypto';
import { randomBytes } from 'node:crypto';

test('private deletion removes response copies and cannot restore a consumed occurrence', async () => {
  const env = await environment();
  try {
    const input = env.request(true),
      created = await env.api('/v2/requests', input),
      id = created.body.request.id;
    const human = await env.login(),
      proposal = { decision: 'authorise', response: { choice: 'accept' } };
    const candidate = await human.call(`/v2/requests/${id}/candidates`, proposal);
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    await env.flush();
    const claim = await env.api(`/v2/requests/${id}/claims`, {
      execution_identity: 'retained-fence',
      execution_binding_digest: digest(input.execution),
    });
    assert.equal(claim.status, 201);
    const discarded = await env.api(`/v2/requests/${id}/discard`, {});
    assert.equal(discarded.status, 200);
    assert.equal((await env.api(`/v2/requests/${id}/material`)).status, 410);
    const exported = await env.api(`/v2/requests/${id}/export`);
    assert.equal(exported.body.material, null);
    assert(exported.body.records.some((r: any) => r.protected.type === 'DecisionReceipt'));
    const copies = await env.store.pool.query(
      'SELECT result FROM haip_idempotency WHERE operation=$1',
      ['decision.propose:' + id],
    );
    assert(copies.rows.length);
    assert(
      copies.rows.every((r) => r.result === null),
      'No idempotent response copy survives private deletion',
    );
    assert.equal((await env.api('/v2/requests', input)).body.error, 'occurrence_unavailable');
    assert.equal(
      (
        await env.api(`/v2/requests/${id}/admission`, {
          claim_id: claim.body.payload.id,
          execution_identity: 'retained-fence',
          nonce: 'after_delete_123456789',
        })
      ).status,
      409,
    );
  } finally {
    await env.close();
  }
});

test('captured deadlines expire immediately and cleanup keeps consumption after audit removal', async () => {
  const env = await environment();
  try {
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: {
        ...env.route.limits,
        review_seconds: 3,
        grant_seconds: 3,
        execution_seconds: 1,
        reconciliation_seconds: 1,
        audit_seconds: 9,
      },
    });
    const input = env.request(true);
    input.execution!.execution_seconds = 1;
    const created = await env.api('/v2/requests', input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.request.id;
    const human = await env.login(),
      candidate = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'authorise',
        response: { choice: 'accept' },
      });
    assert.equal(candidate.status, 201);
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    await env.flush();
    const claimed = await env.api(`/v2/requests/${id}/claims`, {
      execution_identity: 'audit-retained-fence',
      execution_binding_digest: digest(input.execution),
    });
    assert.equal(claimed.status, 201);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(created.body.request.private_delete_at) - Date.now() + 30),
      ),
    );
    assert.equal((await env.api(`/v2/requests/${id}/material`)).status, 410);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(created.body.request.audit_delete_at) - Date.now() + 30),
      ),
    );
    await env.worker.cleanup();
    assert.equal((await env.api(`/v2/requests/${id}`)).status, 404);
    const retry = await env.api('/v2/requests', input);
    assert.equal(retry.body.error, 'occurrence_unavailable');
    const ledger = (await env.api('/v2/admin/ledger', undefined, env.credentials.operator)).body;
    assert(ledger.some((r: any) => r.request_id === id && r.record === null));
  } finally {
    await env.close();
  }
});

test('creation quotas and fresh keys cannot bypass fatigue limits or prevent existing confirmation', async () => {
  const env = await environment();
  try {
    const first = await env.api('/v2/requests', env.request()),
      id = first.body.request.id;
    assert.equal((await env.api(`/v2/requests/${id}/remind`, {})).status, 200);
    assert.equal((await env.api(`/v2/requests/${id}/remind`, {})).body.error, 'reminder_limit');
    const replacement = await env.api(`/v2/requests/${id}/supersede`, env.request());
    assert.equal(replacement.status, 201);
    assert.equal(
      (await env.api(`/v2/requests/${replacement.body.request.id}/remind`, {})).body.error,
      'reminder_limit',
    );
    let quota = false;
    for (let i = 0; i < 24; i++) {
      const r = await env.api('/v2/requests', env.request());
      if (r.status === 429) {
        assert.equal(r.body.error, 'creation_rate');
        quota = true;
        break;
      }
    }
    assert(quota);
    const human = await env.login(),
      live = replacement.body.request.id;
    const candidate = await human.call(`/v2/requests/${live}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201);
    assert.equal(
      (
        await human.call(`/v2/requests/${live}/confirm`, {
          candidate_id: candidate.body.id,
          candidate_digest: digest(candidate.body),
        })
      ).status,
      200,
    );
  } finally {
    await env.close();
  }
});

test('daily tenant, producer and route quotas survive audit cleanup, retries and key rotation', async () => {
  for (const [scope, subject, maximum] of [
    ['tenant', '', 1000],
    ['producer', 'producer', 200],
    ['route', 'review', 100],
  ] as const) {
    const env = await environment();
    try {
      await env.put('/v2/admin/routes/review', {
        ...env.route,
        limits: { ...env.route.limits, review_seconds: 1, audit_seconds: 2 },
      });
      // Prime yesterday's and today's independent counters near their boundary,
      // then use real HTTP creation and the actual short-retention cleanup.
      await env.store.pool.query(
        `INSERT INTO haip_creation_windows(tenant,day,scope,subject,count) VALUES
         ('test-tenant',(clock_timestamp() AT TIME ZONE 'UTC')::date,$1,$2,$3),
         ('test-tenant',(clock_timestamp() AT TIME ZONE 'UTC')::date-1,$1,$2,$3)`,
        [scope, subject, maximum - 1],
      );
      const body = env.request(),
        headers = { 'Idempotency-Key': 'daily-last-slot' },
        created = await env.api('/v2/requests', body, env.credentials.producer, 'POST', headers);
      assert.equal(created.status, 201, scope);
      const repeated = await env.api(
        '/v2/requests',
        body,
        env.credentials.producer,
        'POST',
        headers,
      );
      assert.equal(repeated.body.request.id, created.body.request.id);
      assert.equal((await env.api('/v2/requests', env.request())).body.error, 'daily_quota');
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Date.parse(created.body.request.audit_delete_at) - Date.now() + 30),
        ),
      );
      await env.worker.cleanup();
      assert.equal((await env.api('/v2/requests/' + created.body.request.id)).status, 404);
      const windows = await env.store.pool.query(
        'SELECT day,count FROM haip_creation_windows WHERE tenant=$1 AND scope=$2 AND subject=$3',
        ['test-tenant', scope, subject],
      );
      assert.equal(windows.rowCount, 1, 'only expired daily counters are pruned');
      assert.equal(
        windows.rows[0].count,
        maximum,
        'idempotency and failed requests consume no extra slot',
      );
      const freshKey = randomBytes(32).toString('base64url');
      await env.principal(
        'producer',
        'producer',
        {
          enabled: true,
          publisher: 'publisher',
          owner: 'requester',
          routes: ['review'],
        },
        freshKey,
      );
      assert.equal(
        (await env.api('/v2/requests', env.request(), freshKey)).body.error,
        'daily_quota',
        scope,
      );
    } finally {
      await env.close();
    }
  }
});
