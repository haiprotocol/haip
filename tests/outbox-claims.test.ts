import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { environment } from './environment.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation_timeout')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkpoint(env: Awaited<ReturnType<typeof environment>>) {
  const principal = (
    await env.store.pool.query(
      "SELECT * FROM haip_principals WHERE tenant='test-tenant' AND id='operator'",
    )
  ).rows[0];
  const sequence = await env.store.transaction('test-tenant', (tx, now) =>
    env.service.audit(tx, principal, now, 'ClaimFixture', { id: randomUUID() }),
  );
  return (
    await env.store.pool.query(
      "SELECT id FROM haip_outbox WHERE tenant='test-tenant' AND kind='checkpoint' AND (body->'payload'->>'sequence')::bigint=$1",
      [sequence],
    )
  ).rows[0].id as string;
}

test('a checkpoint claim releases the tenant lock and prevents a concurrent delivery', async () => {
  const env = await environment();
  const entered = deferred(),
    release = deferred();
  let first: Promise<number> | undefined,
    lockWrite: Promise<void> | undefined,
    calls = 0;
  const accept = env.anchor.accept.bind(env.anchor);
  try {
    await env.flush();
    const id = await checkpoint(env);
    env.anchor.accept = async (record) => {
      calls++;
      entered.resolve();
      await release.promise;
      return accept(record);
    };
    first = env.worker.tick();
    await within(entered.promise);
    lockWrite = env.store.transaction('test-tenant', async (tx) => {
      await tx.query("UPDATE haip_tenants SET config=config WHERE id='test-tenant'");
    });
    await within(lockWrite);
    assert.equal(await within(new OutboxWorker(env.service, env.anchor).tick()), 0);
    assert.equal(calls, 1);
    const claimed = (
      await env.store.pool.query(
        'SELECT state,attempts,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(claimed.state, 'pending');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.claim_generation, 1);
    assert(claimed.claim_until);
    assert.match(claimed.claim_revision, /^sha256:[a-f0-9]{64}$/);
    release.resolve();
    assert.equal(await first, 1);
    const accepted = (
      await env.store.pool.query(
        'SELECT state,attempts,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.deepEqual(accepted, {
      state: 'accepted',
      attempts: 1,
      claim_until: null,
      claim_revision: null,
    });
  } finally {
    release.resolve();
    await Promise.allSettled([first, lockWrite].filter(Boolean) as Promise<unknown>[]);
    env.anchor.accept = accept;
    await env.close();
  }
});

test('a failed checkpoint releases its claim and retries the same immutable record', async () => {
  const env = await environment();
  const accept = env.anchor.accept.bind(env.anchor);
  let calls = 0;
  try {
    await env.flush();
    const id = await checkpoint(env);
    env.anchor.accept = async (record) => {
      calls++;
      if (calls === 1) throw new Error('test_anchor_outage');
      return accept(record);
    };
    const failedAt = Date.now();
    assert.equal(await env.worker.tick(), 0);
    const failed = (
      await env.store.pool.query(
        'SELECT state,attempts,next_at,claim_generation,claim_until,claim_revision,error FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(failed.state, 'pending');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.claim_generation, 1);
    assert.equal(failed.claim_until, null);
    assert.equal(failed.claim_revision, null);
    assert.equal(failed.error, 'delivery_failed');
    assert(failed.next_at.getTime() >= failedAt + 1900);
    await env.store.pool.query('UPDATE haip_outbox SET next_at=clock_timestamp() WHERE id=$1', [
      id,
    ]);
    assert.equal(await env.worker.tick(), 1);
    assert.equal(calls, 2);
    const accepted = (
      await env.store.pool.query(
        'SELECT state,attempts,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.deepEqual(accepted, {
      state: 'accepted',
      attempts: 2,
      claim_generation: 2,
      claim_until: null,
      claim_revision: null,
    });
  } finally {
    env.anchor.accept = accept;
    await env.close();
  }
});

test('a reclaimed checkpoint rejects its stale worker finalisation', async () => {
  const env = await environment();
  const entered = deferred(),
    release = deferred();
  const accept = env.anchor.accept.bind(env.anchor);
  let first: Promise<number> | undefined,
    calls = 0;
  try {
    await env.flush();
    const id = await checkpoint(env);
    env.anchor.accept = async (record) => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return accept(record);
    };
    first = env.worker.tick();
    await within(entered.promise);
    await env.store.pool.query(
      "UPDATE haip_outbox SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id],
    );
    assert.equal(await new OutboxWorker(env.service, env.anchor).tick(), 1);
    release.resolve();
    assert.equal(await first, 0);
    assert.equal(calls, 2);
    assert.deepEqual(
      (
        await env.store.pool.query(
          'SELECT state,attempts,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
          [id],
        )
      ).rows[0],
      {
        state: 'accepted',
        attempts: 2,
        claim_generation: 2,
        claim_until: null,
        claim_revision: null,
      },
    );
  } finally {
    release.resolve();
    await Promise.allSettled([first].filter(Boolean) as Promise<unknown>[]);
    env.anchor.accept = accept;
    await env.close();
  }
});

test('the claim migration upgrades existing pending jobs with an empty claim', async () => {
  const env = await environment();
  try {
    await env.flush();
    const id = await checkpoint(env);
    await env.store.pool.query('DROP INDEX haip_outbox_ready_delivery');
    await env.store.pool.query('DROP INDEX haip_outbox_ready');
    await env.store.pool.query('ALTER TABLE haip_outbox DROP CONSTRAINT haip_outbox_claim_pair');
    await env.store.pool.query(
      'ALTER TABLE haip_outbox DROP COLUMN claim_revision,DROP COLUMN claim_until,DROP COLUMN claim_generation',
    );
    await env.store.pool.query(
      "CREATE INDEX haip_outbox_ready ON haip_outbox(tenant,next_at,created_at,id) WHERE state='pending'",
    );
    await env.store.pool.query(
      "CREATE INDEX haip_outbox_ready_delivery ON haip_outbox(tenant,next_at,created_at,id) WHERE state='pending' AND kind IN ('smtp','webhook')",
    );
    await env.store.pool.query("DELETE FROM haip_migrations WHERE name='007_outbox_claims.sql'");
    await env.store.migrate();
    assert.deepEqual(
      (
        await env.store.pool.query(
          'SELECT state,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
          [id],
        )
      ).rows[0],
      {
        state: 'pending',
        claim_generation: 0,
        claim_until: null,
        claim_revision: null,
      },
    );
    assert.equal(
      (
        await env.store.pool.query(
          "SELECT count(*)::integer AS count FROM pg_indexes WHERE indexname IN ('haip_outbox_ready','haip_outbox_ready_delivery')",
        )
      ).rows[0].count,
      2,
    );
  } finally {
    await env.close();
  }
});

test('the ready index skips a large active claim set', async () => {
  const env = await environment();
  try {
    await env.flush();
    const id = await checkpoint(env);
    await env.store.pool.query(
      `INSERT INTO haip_outbox(id,tenant,kind,body,next_at,created_at,claim_generation,claim_until,claim_revision)
       SELECT gen_random_uuid(),'test-tenant','checkpoint',template.body,statement_timestamp()-interval '1 day',statement_timestamp()-interval '2 days',1,statement_timestamp()+interval '1 day','sha256:'||repeat('a',64)
       FROM generate_series(1,10000),LATERAL(SELECT body FROM haip_outbox WHERE id=$1) template`,
      [id],
    );
    await env.store.pool.query('ANALYZE haip_outbox');
    const explained = await env.store.pool.query(
      `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
       SELECT id,tenant FROM haip_outbox WHERE tenant=$1 AND state='pending'
       AND GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz))<=statement_timestamp()
       ORDER BY GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz)),created_at,id LIMIT 50`,
      ['test-tenant'],
    );
    const plan = explained.rows[0]['QUERY PLAN'][0].Plan;
    const nodes: any[] = [];
    const visit = (node: any) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan);
    assert(
      nodes.some(
        (node) =>
          ['Index Scan', 'Index Only Scan'].includes(node['Node Type']) &&
          node['Index Name'] === 'haip_outbox_ready',
      ),
      JSON.stringify(plan),
    );
    assert(!nodes.some((node) => node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Sort'));
    assert(
      Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0) < 100,
      JSON.stringify(plan),
    );
    assert.equal(await env.worker.tick(), 1);
  } finally {
    await env.close();
  }
});

test('webhook claims preserve authority recorded at claim and stop stale failure retries', async (t) => {
  for (const outcome of ['accepted', 'failed'] as const)
    await t.test(outcome, async () => {
      const env = await environment();
      const entered = deferred();
      let finish: (() => void) | undefined,
        first: Promise<number> | undefined,
        requests = 0;
      try {
        env.service.config.webhookHosts.push('receiver.test');
        await env.principal(
          'producer',
          'producer',
          {
            enabled: true,
            publisher: 'publisher',
            owner: 'requester',
            routes: ['review'],
            webhook: 'https://receiver.test/events',
          },
          env.credentials.producer,
        );
        await env.flush();
        const created = await env.api('/v2/requests', env.request());
        assert.equal(created.status, 201);
        const item = (
          await env.store.pool.query(
            "SELECT id FROM haip_outbox WHERE tenant='test-tenant' AND request_id=$1 AND kind='webhook'",
            [created.body.request.id],
          )
        ).rows[0];
        const worker = new OutboxWorker(env.service, undefined, {
          webhookTransport: {
            resolve: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
            request: ((_url: URL, _options: unknown, callback: (response: any) => void) => {
              const request = new EventEmitter() as any;
              request.destroy = (error: Error) => request.emit('error', error);
              request.end = () => {
                requests++;
                finish = () => {
                  if (outcome === 'failed') {
                    request.emit('error', new Error('fixture_delivery_failed'));
                    return;
                  }
                  const response = new PassThrough() as any;
                  response.statusCode = 204;
                  callback(response);
                  response.end();
                };
                entered.resolve();
              };
              return request;
            }) as any,
          },
        });
        first = worker.tick();
        await within(entered.promise);
        await within(
          env.store.transaction('test-tenant', async (tx) => {
            await tx.query(
              "UPDATE haip_principals SET config=jsonb_set(config,'{enabled}','false') WHERE tenant='test-tenant' AND id='producer'",
            );
          }),
        );
        assert.equal(await within(worker.tick()), 0);
        assert.equal(requests, 1);
        finish();
        finish = undefined;
        assert.equal(await first, outcome === 'accepted' ? 1 : 0);
        assert.deepEqual(
          (
            await env.store.pool.query(
              'SELECT state,attempts,error,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
              [item.id],
            )
          ).rows[0],
          {
            state: outcome,
            attempts: 1,
            error: outcome === 'accepted' ? null : 'destination_changed',
            claim_until: null,
            claim_revision: null,
          },
        );
        assert.equal(await worker.tick(), 0);
        assert.equal(requests, 1);
      } finally {
        finish?.();
        await Promise.allSettled([first].filter(Boolean) as Promise<unknown>[]);
        await env.close();
      }
    });
});
