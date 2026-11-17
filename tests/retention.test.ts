import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';
import { digest } from '@haip/protocol/crypto';
import { randomBytes } from 'node:crypto';
import { OutboxWorker } from '../haip-server/src/worker.js';

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
        audit_seconds: 11,
      },
    });
    const input = env.request(true);
    input.execution!.execution_seconds = 1;
    const headers = { 'Idempotency-Key': 'audit-retention-request' };
    const create = (body = input) =>
      env.api('/v2/requests', body, env.credentials.producer, 'POST', headers);
    const created = await create();
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
    assert.equal((await create()).body.request.id, id);
    const review = await env.api('/v2/requests', env.request());
    assert.equal(review.status, 201);
    const reviewId = review.body.request.id;
    assert.equal((await env.api(`/v2/hitl/${reviewId}/poll`)).body.status, 'pending');
    const ledger = () => env.api('/v2/admin/ledger', undefined, env.credentials.operator);
    const original = (await ledger()).body.find((row: any) => row.request_id === id && row.record);
    assert.ok(original);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(created.body.request.private_delete_at) - Date.now() + 30),
      ),
    );
    assert.equal((await env.api(`/v2/requests/${id}/material`)).status, 410);
    assert.equal((await env.api(`/v2/requests/${id}/export`)).body.material, null);
    assert.ok((await env.api(`/v2/requests/${id}`)).body.receipt);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(review.body.request.audit_delete_at) - Date.now() + 30),
      ),
    );
    const retained = await env.store.pool.query(
      'SELECT 1 FROM haip_requests WHERE tenant=$1 AND id=ANY($2::uuid[])',
      ['test-tenant', [id, reviewId]],
    );
    assert.equal(retained.rowCount, 2);
    for (const path of [
      `/v2/requests/${id}`,
      `/v2/requests/${id}/material`,
      `/v2/requests/${id}/export`,
      `/v2/hitl/${reviewId}`,
      `/v2/hitl/${reviewId}/poll`,
    ])
      assert.equal((await env.api(path)).status, 404, path);
    assert.equal(
      (await fetch(`${env.origin}/review/${id}`, { headers: { Cookie: human.cookie } })).status,
      404,
    );
    assert.equal((await env.api(`/v2/requests/${id}/remind`, {})).status, 404);
    assert.equal((await create()).body.error, 'idempotent_result_expired');
    assert.equal(
      (await create({ ...input, summary: 'Different input' })).body.error,
      'idempotency_conflict',
    );

    const live = await env.api('/v2/requests', env.request());
    assert.equal(live.status, 201);
    const liveId = live.body.request.id;
    const inbox = await env.api('/v2/requests');
    assert.deepEqual(
      inbox.body.items.map((row: any) => row.id),
      [liveId],
    );
    const events = await env.api('/v2/events');
    assert.deepEqual(
      events.body.items.map((event: any) => event.payload.request_id),
      [liveId],
    );
    assert.ok(events.body.next > 0);
    const redacted = (await ledger()).body.find((row: any) => row.sequence === original.sequence);
    assert.deepEqual(redacted, { ...original, record: null });

    await env.worker.cleanup();
    assert.equal((await env.api(`/v2/requests/${id}`)).status, 404);
    const retry = await env.api('/v2/requests', input);
    assert.equal(retry.body.error, 'occurrence_unavailable');
    assert((await ledger()).body.some((row: any) => row.request_id === id && row.record === null));
  } finally {
    await env.close();
  }
});

test('a short audit window closes review and delivery while preserving pending checkpoints', async () => {
  const env = await environment({ singleTenant: true });
  try {
    env.service.config.webhookHosts.push('retention.test');
    await env.principal(
      'producer',
      'producer',
      {
        enabled: true,
        publisher: 'publisher',
        owner: 'requester',
        routes: ['review', 'short-review'],
        webhook: 'https://retention.test/events',
      },
      env.credentials.producer,
    );
    await env.put('/v2/admin/routes/short-review', {
      ...env.route,
      limits: { ...env.route.limits, audit_seconds: 5, review_seconds: 6, grant_seconds: 9 },
    });
    const human = await env.login();
    async function confirm(id: string, decision: 'answer' | 'authorise') {
      const path = '/v2/requests/' + id;
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
    const live = await env.api('/v2/requests', env.request());
    assert.equal(live.status, 201);
    await confirm(live.body.request.id, 'answer');
    const created = await env.api('/v2/requests', env.request(true, { route: 'short-review' }));
    assert.equal(created.status, 201);
    const { id, audit_delete_at } = created.body.request;
    assert.equal(created.body.request.review_deadline, audit_delete_at);
    assert.equal(created.body.request.private_delete_at, audit_delete_at);
    const receipt = await confirm(id, 'authorise');
    assert.equal(receipt.payload.grant_deadline, audit_delete_at);

    const { rows: jobs } = await env.store.pool.query(
      'SELECT id,kind,body FROM haip_outbox WHERE tenant=$1 AND request_id=$2',
      ['test-tenant', id],
    );
    const checkpoint = jobs.find((job) => job.kind === 'checkpoint');
    const webhook = jobs.find((job) => job.kind === 'webhook');
    assert.ok(checkpoint && webhook);
    let resolutions = 0;
    const worker = new OutboxWorker(env.service, env.anchor, {
      webhookTransport: {
        resolve: async () => {
          resolutions++;
          throw new Error('fixture_transport_invoked');
        },
        request: () => assert.fail('No network request is expected'),
      },
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(audit_delete_at) - Date.now() + 30)),
    );
    assert.deepEqual(await worker.runJob(webhook.id), { state: 'settled' });
    assert.equal(resolutions, 0);
    assert.deepEqual(
      (
        await env.store.pool.query('SELECT state,body,destination FROM haip_outbox WHERE id=$1', [
          webhook.id,
        ])
      ).rows[0],
      { state: 'expired', body: {}, destination: null },
    );
    await worker.cleanup();
    const held = (
      await env.store.pool.query('SELECT state,body,request_id FROM haip_outbox WHERE id=$1', [
        checkpoint.id,
      ])
    ).rows[0];
    assert.deepEqual(held, { state: 'pending', body: checkpoint.body, request_id: null });
    assert.deepEqual(await worker.runJob(checkpoint.id), { state: 'settled' });
    const liveStatus = await env.api(`/v2/requests/${live.body.request.id}`);
    assert.equal(liveStatus.body.audit_state, 'anchored');
    assert.equal(digest(liveStatus.body.anchor.checkpoint), digest(checkpoint.body));
    const { ledger_id, generation, sequence, head } = checkpoint.body.payload;
    assert(
      (await env.anchor.history(ledger_id, generation)).some(
        (entry) => entry.sequence === sequence && entry.head === head,
      ),
    );
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
