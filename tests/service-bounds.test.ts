import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DEFAULT_LIMITS, RENDERER } from '@haip/protocol';
import { digest } from '@haip/protocol/crypto';
import { environment } from './environment.js';
import type { Principal } from '../haip-server/src/config.js';

async function producer(env: Awaited<ReturnType<typeof environment>>) {
  return (
    await env.store.pool.query(
      "SELECT * FROM haip_principals WHERE tenant='test-tenant' AND id='producer'",
    )
  ).rows[0] as Principal;
}

test('exhausted create credentials fail before body preparation or tenant locking; retries and confirmation still work', async () => {
  const env = await environment();
  try {
    const body = env.request(),
      headers = { 'Idempotency-Key': 'original-create' };
    const first = await env.api('/v2/requests', body, env.credentials.producer, 'POST', headers);
    assert.equal(first.status, 201);
    const p = await producer(env);
    await env.store.pool.query(
      "UPDATE haip_creation_windows SET count=200 WHERE tenant='test-tenant' AND scope='producer' AND subject='producer'",
    );
    const lock = await env.store.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [p.tenant]);
      let touched = false;
      const hostile = {
        ...body,
        get payload() {
          touched = true;
          throw new Error('payload_was_prepared');
        },
      };
      await assert.rejects(env.service.create(p, hostile as any, 'rejected'), /daily_quota/);
      assert.equal(touched, false, 'quota checks do not traverse attacker-controlled material');
      // This response must arrive even while a separate transaction owns the tenant write lock.
      await assert.rejects(env.service.preflightCreate(p, 'large-body-rejected'), /daily_quota/);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    const repeated = await env.api('/v2/requests', body, env.credentials.producer, 'POST', headers);
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.request.id, first.body.request.id);
    assert.equal(
      (
        await env.api(
          '/v2/requests',
          { ...body, summary: 'Changed' },
          env.credentials.producer,
          'POST',
          headers,
        )
      ).body.error,
      'idempotency_conflict',
    );
    const human = await env.login();
    const candidate = await human.call(`/v2/requests/${first.body.request.id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    const confirmed = await human.call(`/v2/requests/${first.body.request.id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    assert.equal(confirmed.status, 200);
  } finally {
    await env.close();
  }
});

test('request preparation stays outside the write lock and concurrent creation cannot overspend the final daily slot', async () => {
  const env = await environment();
  try {
    const p = await producer(env),
      original = env.store.transaction.bind(env.store);
    let locked = false,
      reads = 0;
    env.store.transaction = (tenant, run) =>
      original(tenant, async (tx, now) => {
        locked = true;
        try {
          return await run(tx, now);
        } finally {
          locked = false;
        }
      });
    const input = env.request();
    Object.defineProperty(input, 'payload', {
      enumerable: true,
      get() {
        assert.equal(
          locked,
          false,
          'untrusted JSON must not be traversed while holding the tenant lock',
        );
        reads++;
        return { message: 'Prepared outside the lock' };
      },
    });
    const created = await env.service.create(p, input as any, 'prepared-outside-lock');
    assert(created.request.id);
    assert(reads > 0);
    env.store.transaction = original;
    await env.store.pool.query(
      "UPDATE haip_creation_windows SET count=99 WHERE tenant='test-tenant' AND scope='route' AND subject='review'",
    );
    const attempts = await Promise.all([
      env.api('/v2/requests', env.request()),
      env.api('/v2/requests', env.request()),
    ]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 429]);
    assert.equal(attempts.find((r) => r.status === 429)?.body.error, 'daily_quota');
    const count = (
      await env.store.pool.query(
        "SELECT count FROM haip_creation_windows WHERE tenant='test-tenant' AND scope='route' AND subject='review'",
      )
    ).rows[0].count;
    assert.equal(count, 100);
  } finally {
    await env.close();
  }
});

test('captured metadata and provenance limits are checked before signing or reserving a quota slot', async () => {
  const env = await environment();
  try {
    for (const [field, value] of [
      ['metadata', { note: 'x'.repeat(DEFAULT_LIMITS.response_bytes) }],
      [
        'execution',
        {
          ...env.request(true).execution,
          provenance: {
            profile: 'haip.execution',
            version: '1-draft.1',
            references: { note: 'x'.repeat(DEFAULT_LIMITS.response_bytes) },
          },
        },
      ],
    ] as const) {
      const result = await env.api('/v2/requests', {
        ...env.request(field === 'execution'),
        [field]: value,
      });
      assert.equal(result.status, 413);
      assert.equal(
        result.body.error,
        field === 'metadata' ? 'metadata_too_large' : 'provenance_too_large',
      );
    }
    assert.equal(
      Number(
        (await env.store.pool.query('SELECT count(*) FROM haip_creation_windows')).rows[0].count,
      ),
      0,
    );
  } finally {
    await env.close();
  }
});

test('bundle quotas survive key rotation and collection, retain idempotency, and bound publisher and tenant storage', async () => {
  const env = await environment();
  try {
    const body = {
      html: '<!doctype html><p>Fixture</p>',
      compatibility: RENDERER,
      author: 'Fixture publisher',
      licence: 'MIT',
    };
    const headers = { 'Idempotency-Key': 'bundle-last-slot' };
    await env.store.pool.query(
      "INSERT INTO haip_bundle_windows(tenant,day,scope,subject,count) VALUES('test-tenant',(clock_timestamp() AT TIME ZONE 'UTC')::date,'publisher','publisher',19)",
    );
    const first = await env.api('/v2/bundles', body, env.credentials.publisher, 'POST', headers);
    assert.equal(first.status, 201);
    assert.equal(
      (await env.api('/v2/bundles', body, env.credentials.publisher, 'POST', headers)).body.id,
      first.body.id,
    );
    assert.equal(
      (await env.api('/v2/bundles', body, env.credentials.publisher)).body.error,
      'bundle_daily_quota',
    );
    await env.store.pool.query(
      "UPDATE haip_bundles SET created_at=clock_timestamp()-interval '16 minutes' WHERE tenant='test-tenant'",
    );
    await env.worker.cleanup();
    assert.equal(
      (await env.store.pool.query('SELECT html FROM haip_bundles WHERE id=$1', [first.body.id]))
        .rows[0].html,
      null,
    );
    const fresh = randomBytes(32).toString('base64url');
    await env.principal('publisher', 'publisher', { enabled: true }, fresh);
    assert.equal((await env.api('/v2/bundles', body, fresh)).body.error, 'bundle_daily_quota');
    assert.equal(
      (await env.api('/v2/bundles', body, fresh, 'POST', headers)).body.id,
      first.body.id,
    );
    await env.store.pool.query("DELETE FROM haip_bundle_windows WHERE tenant='test-tenant'");
    await env.store.pool.query(
      "UPDATE haip_bundles SET retained_bytes=$1 WHERE tenant='test-tenant'",
      [DEFAULT_LIMITS.retained_bytes],
    );
    assert.equal(
      (await env.api('/v2/bundles', body, env.credentials.otherPublisher)).body.error,
      'retained_quota',
    );
    await env.store.pool.query(
      "UPDATE haip_bundles SET retained_bytes=0 WHERE tenant='test-tenant'",
    );
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await env.api('/v2/bundles', body, env.credentials.otherPublisher)).status,
        201,
      );
    assert.equal(
      (await env.api('/v2/bundles', body, env.credentials.otherPublisher)).body.error,
      'bundle_rate',
    );
  } finally {
    await env.close();
  }
});

test('inbox pages enforce visibility in SQL; reads project expiry without audit writes and retention releases locks between pages', async () => {
  const env = await environment();
  try {
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: { ...env.route.limits, review_seconds: 1 },
    });
    const initial = await env.api('/v2/requests', env.request(false, { review_seconds: 1 })),
      id = initial.body.request.id;
    await env.put('/v2/admin/routes/hidden', { ...env.route, reviewers: ['requester'] });
    // Large retained histories need not be fetched into the application to list a single inbox page.
    await env.store.pool.query(
      `INSERT INTO haip_requests(tenant,id,producer,route,data,material,retained_bytes,created_at)
       SELECT r.tenant,copy.id,r.producer,r.route,jsonb_set(r.data,'{request,id}',to_jsonb(copy.id::text)),r.material,r.retained_bytes,r.created_at
       FROM haip_requests r CROSS JOIN (SELECT gen_random_uuid() AS id FROM generate_series(1,74)) copy
       WHERE r.tenant='test-tenant' AND r.id=$1`,
      [id],
    );
    await env.store.pool.query(
      `INSERT INTO haip_requests(tenant,id,producer,route,data,material,retained_bytes,created_at)
       SELECT r.tenant,copy.id,'other-producer','hidden',jsonb_set(jsonb_set(r.data,'{request,id}',to_jsonb(copy.id::text)),'{request,route}','"hidden"'),r.material,r.retained_bytes,r.created_at
       FROM haip_requests r CROSS JOIN (SELECT gen_random_uuid() AS id FROM generate_series(1,25)) copy
       WHERE r.tenant='test-tenant' AND r.id=$1`,
      [id],
    );
    const human = await env.login();
    const one = await human.call('/v2/requests'),
      two = await human.call('/v2/requests?offset=50');
    assert.equal(one.body.total, undefined);
    assert.equal(one.body.items.length, 50);
    assert.equal(one.body.next_offset, 50);
    assert.equal(two.body.items.length, 25);
    assert.equal(two.body.next_offset, null);
    assert.equal(new Set([...one.body.items, ...two.body.items].map((r: any) => r.id)).size, 75);
    assert.deepEqual(
      (await env.api('/v2/requests', undefined, env.credentials.foreignProducer)).body,
      { items: [], next_offset: null },
    );
    const operatorPage = await env.api('/v2/requests', undefined, env.credentials.operator);
    assert.equal(operatorPage.body.items.length, 50);
    assert.equal(operatorPage.body.next_offset, 50);
    const operatorLastPage = await env.api(
      '/v2/requests?offset=50',
      undefined,
      env.credentials.operator,
    );
    assert.equal(operatorLastPage.body.items.length, 50);
    assert.equal(operatorLastPage.body.next_offset, null);
    assert.equal((await env.api('/v2/requests?offset=100001')).status, 400);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(initial.body.request.private_delete_at) - Date.now() + 20),
      ),
    );
    const before = (
      await env.store.pool.query("SELECT audit_sequence FROM haip_tenants WHERE id='test-tenant'")
    ).rows[0].audit_sequence;
    const lock = await env.store.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['test-tenant']);
      assert.deepEqual((await human.call('/v2/requests?state=pending')).body, {
        items: [],
        next_offset: null,
      });
      const expired = await human.call('/v2/requests?state=expired');
      assert.equal(expired.body.items.length, 50);
      assert.equal(expired.body.next_offset, 50);
      assert.equal((await human.call('/v2/requests/' + id)).body.decision_state, 'expired');
      assert.equal((await human.call('/v2/requests/' + id + '/material')).status, 410);
      assert.equal((await human.call('/v2/requests/' + id + '/export')).body.material, null);
      assert.equal((await env.api('/v2/events')).status, 200);
      assert.equal(
        (await env.api('/v2/admin/metrics', undefined, env.credentials.operator)).status,
        200,
      );
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    assert.equal(
      (await env.store.pool.query("SELECT audit_sequence FROM haip_tenants WHERE id='test-tenant'"))
        .rows[0].audit_sequence,
      before,
    );
    const transaction = env.store.transaction.bind(env.store);
    let maximumRows = 0,
      batches = 0;
    env.store.transaction = (tenant, run) =>
      transaction(tenant, async (tx, now) => {
        batches++;
        const query = tx.query.bind(tx);
        const observed = new Proxy(tx, {
          get(target, name) {
            if (name !== 'query') return Reflect.get(target, name);
            return async (...args: any[]) => {
              const result = await (query as any)(...args);
              if (/^\s*SELECT .*haip_requests/s.test(String(args[0])))
                maximumRows = Math.max(maximumRows, result.rows.length);
              return result;
            };
          },
        });
        return run(observed, now);
      });
    await env.worker.cleanup();
    env.store.transaction = transaction;
    assert(batches >= 3, 'retention gives other writers an opportunity between bounded pages');
    assert(maximumRows <= 50, 'retention never materialises a whole retained tenant');
    assert.equal(
      Number(
        (
          await env.store.pool.query(
            "SELECT count(*) FROM haip_requests WHERE tenant='test-tenant' AND material IS NOT NULL",
          )
        ).rows[0].count,
      ),
      0,
    );
    const discarded = (
      await env.store.pool.query(
        "SELECT record FROM haip_audit WHERE tenant='test-tenant' AND record LIKE '%MaterialDiscarded%' LIMIT 1",
      )
    ).rows[0];
    assert.deepEqual(JSON.parse(discarded.record).payload.recorded_by, {
      kind: 'system',
      subject: 'haip.retention',
    });
    assert.notEqual(JSON.parse(discarded.record).protected.audience, 'reviewer');
  } finally {
    await env.close();
  }
});

test('reserved response space stays available after later bundle storage; extra candidate copies still need quota', async () => {
  const env = await environment();
  try {
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: { ...env.route.limits, retained_bytes: 4 * 1024 ** 2 },
    });
    const input = env.request(false, {
      response_schema: {
        type: 'object',
        properties: { choice: { type: 'string' }, note: { type: 'string' } },
        required: ['choice'],
        additionalProperties: false,
      },
    });
    const created = await env.api('/v2/requests', input);
    assert.equal(created.status, 201);
    const registration = await env.api(
      '/v2/bundles',
      {
        html: '<!doctype html><p>' + 'x'.repeat(4 * 1024 ** 2) + '</p>',
        compatibility: RENDERER,
        author: 'Fixture publisher',
        licence: 'MIT',
      },
      env.credentials.publisher,
    );
    assert.equal(registration.status, 201);
    const human = await env.login(),
      id = created.body.request.id;
    let candidate = await human.call(`/v2/requests/${id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201, 'the initial candidate uses the already reserved storage');
    let exhausted = false;
    for (let i = 0; i < 8; i++) {
      const next = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'answer',
        response: { choice: 'accept', note: 'x'.repeat(200 * 1024) },
      });
      if (next.status === 429) {
        assert.equal(next.body.error, 'retained_quota');
        exhausted = true;
        break;
      }
      assert.equal(next.status, 201);
      candidate = next;
    }
    assert(
      exhausted,
      'additional idempotent response copies cannot exceed the reserved storage for free',
    );
    const confirmed = await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    assert.equal(
      confirmed.status,
      200,
      'confirmation requires no extra creation or material quota',
    );
  } finally {
    await env.close();
  }
});
