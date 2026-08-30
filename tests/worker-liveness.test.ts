import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';
import { OutboxWorker } from '../haip-server/src/worker.js';

async function copyRequests(
  env: Awaited<ReturnType<typeof environment>>,
  id: string,
  count: number,
) {
  await env.store.pool.query(
    `INSERT INTO haip_requests(tenant,id,producer,route,data,material,retained_bytes,created_at)
     SELECT r.tenant,copy.id,r.producer,r.route,jsonb_set(r.data,'{request,id}',to_jsonb(copy.id::text)),r.material,r.retained_bytes,r.created_at
     FROM haip_requests r CROSS JOIN (SELECT gen_random_uuid() AS id FROM generate_series(1,$2::integer)) copy
     WHERE r.tenant='test-tenant' AND r.id=$1`,
    [id, count],
  );
}
async function deadlines(
  env: Awaited<ReturnType<typeof environment>>,
  id: string,
  deadline: string,
) {
  await env.store.pool.query(
    `UPDATE haip_requests SET data=jsonb_set(jsonb_set(data,'{request,review_deadline}',to_jsonb($2::text)),'{request,private_delete_at}',to_jsonb($2::text)) WHERE tenant='test-tenant' AND id=$1`,
    [id, deadline],
  );
}

test('a stalled row and a full stalled page finish their pass without rewriting timestamps or hiding later expiry', async () => {
  const env = await environment();
  try {
    const base = await env.api('/v2/requests', env.request()),
      id = base.body.request.id;
    assert.equal(base.status, 201);
    // An offline-import fixture: lexically in the past, but an hour in the future as an instant.
    const noncanonical = new Date(Date.now() - 2 * 3600000).toISOString().replace('Z', '-03:00');
    assert(Date.parse(noncanonical) > Date.now());
    assert(noncanonical < new Date().toISOString());
    await deadlines(env, id, noncanonical);
    const before = (await env.store.pool.query('SELECT data FROM haip_requests WHERE id=$1', [id]))
      .rows[0].data;
    const incidentCount = async () =>
      Number(
        (
          await env.store.pool.query(
            "SELECT count(*) FROM haip_incidents WHERE tenant='test-tenant' AND code='retention_stalled'",
          )
        ).rows[0].count,
      );
    assert.deepEqual(
      await env.worker.cleanup(),
      { examined: 1, changed: 0, stalled: 1, more: false },
      'one stuck row did not cause the original full-page loop',
    );
    assert.deepEqual(await env.worker.cleanup(), {
      examined: 1,
      changed: 0,
      stalled: 1,
      more: false,
    });
    assert.equal(await incidentCount(), 1);
    assert.deepEqual(
      (await env.store.pool.query('SELECT data FROM haip_requests WHERE id=$1', [id])).rows[0].data,
      before,
    );
    await copyRequests(env, id, 49);
    const healthy = await env.api('/v2/requests', env.request());
    assert.equal(healthy.status, 201);
    await deadlines(env, healthy.body.request.id, new Date(Date.now() - 3600000).toISOString());
    assert.deepEqual(await env.worker.cleanup(), {
      examined: 50,
      changed: 0,
      stalled: 50,
      more: true,
    });
    assert.deepEqual(
      await env.worker.cleanup(),
      { examined: 1, changed: 1, stalled: 0, more: false },
      'a bounded continuation reaches healthy rows after the stalled page',
    );
    assert.equal(
      (
        await env.store.pool.query('SELECT material FROM haip_requests WHERE id=$1', [
          healthy.body.request.id,
        ])
      ).rows[0].material,
      null,
    );
    assert.equal(await incidentCount(), 1);
    assert.deepEqual(
      (await env.store.pool.query('SELECT data FROM haip_requests WHERE id=$1', [id])).rows[0].data,
      before,
    );
    const restarted = new OutboxWorker(env.service, env.anchor);
    assert.deepEqual(
      await restarted.cleanup(),
      { examined: 50, changed: 0, stalled: 50, more: false },
      'restart safely begins a fresh bounded pass; the wholly stalled set does not request immediate retries',
    );
    assert.deepEqual(await restarted.cleanup(), {
      examined: 50,
      changed: 0,
      stalled: 50,
      more: false,
    });
    assert.equal(await incidentCount(), 1);
  } finally {
    await env.close();
  }
});

test('cleanup caps request work, collects once per tenant, and expires sessions once outside tenant locks', async () => {
  const env = await environment();
  try {
    const first = await env.api('/v2/requests', env.request()),
      id = first.body.request.id;
    await deadlines(env, id, new Date(Date.now() - 1000).toISOString());
    await copyRequests(env, id, 524);
    await env.store.pool.query(
      `INSERT INTO haip_sessions(token_hash,data,expires_at)
       SELECT 'expired-'||i,jsonb_build_object('principal',jsonb_build_object('tenant',CASE WHEN i%2=0 THEN 'test-tenant' ELSE 'foreign-tenant' END)),statement_timestamp()-interval '1 day'
       FROM generate_series(1,601) i`,
    );
    await env.store.pool.query(
      "INSERT INTO haip_sessions(token_hash,data,expires_at) VALUES('live-session','{}',statement_timestamp()+interval '1 day')",
    );
    await env.store.pool.query(
      `INSERT INTO haip_idempotency(tenant,actor,operation,key,digest,result,created_at)
       SELECT 'test-tenant','producer','create','retention-'||i,'retained-commitment',
         CASE WHEN i<=501 THEN NULL ELSE '{"retained":"private"}'::jsonb END,
         statement_timestamp()-interval '100 days'
       FROM generate_series(1,1002) i`,
    );
    const retainedResults = async () =>
      Number(
        (
          await env.store.pool.query(
            "SELECT count(*) FROM haip_idempotency WHERE key LIKE 'retention-%' AND result IS NOT NULL",
          )
        ).rows[0].count,
      );
    const transaction = env.store.transaction.bind(env.store),
      query = env.store.pool.query.bind(env.store.pool);
    const collections = new Map<string, number>();
    let held = 0,
      sessionPasses = 0,
      largestCollection = 0;
    env.store.pool.query = (async (...args: any[]) => {
      if (String(args[0]).includes('FROM haip_sessions retained')) {
        sessionPasses++;
        assert.equal(
          held,
          0,
          'session expiry is not repeated inside another tenant’s advisory lock',
        );
      }
      return (query as any)(...args);
    }) as any;
    env.store.transaction = (tenant, run) =>
      transaction(tenant, async (tx, now) => {
        held++;
        const statement = tx.query.bind(tx);
        const observed = new Proxy(tx, {
          get(target, name) {
            if (name !== 'query') return Reflect.get(target, name);
            return async (...args: any[]) => {
              const table = String(args[0]).match(/FROM (haip_[a-z_]+) retained/)?.[1];
              if (table) collections.set(table, (collections.get(table) ?? 0) + 1);
              const result = await (statement as any)(...args);
              if (table)
                largestCollection = Math.max(largestCollection, Number(result.rows[0].changed));
              return result;
            };
          },
        });
        try {
          return await run(observed, now);
        } finally {
          held--;
        }
      });
    const lock = await env.store.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query("SELECT 1 FROM haip_sessions WHERE token_hash='expired-1' FOR UPDATE");
      assert.deepEqual(await env.worker.cleanup(), {
        examined: 500,
        changed: 500,
        stalled: 0,
        more: true,
      });
      assert.equal(sessionPasses, 1);
      assert.equal(
        Number(
          (
            await env.store.pool.query(
              "SELECT count(*) FROM haip_sessions WHERE token_hash LIKE 'expired-%'",
            )
          ).rows[0].count,
        ),
        101,
        'only 500 unlocked expired sessions are removed',
      );
      assert.equal(await retainedResults(), 1, 'old results are also collected in bounded batches');
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    for (const table of [
      'haip_bundles',
      'haip_audit',
      'haip_outbox',
      'haip_idempotency',
      'haip_notification_windows',
      'haip_creation_windows',
      'haip_bundle_windows',
    ])
      assert.equal(
        collections.get(table),
        2,
        table + ' is collected once for each of the two tenants, irrespective of page count',
      );
    assert.equal(largestCollection, 500);
    assert.equal(
      Number(
        (
          await env.store.pool.query(
            'SELECT count(*) FROM haip_requests WHERE material IS NOT NULL',
          )
        ).rows[0].count,
      ),
      25,
    );
    assert.deepEqual(await env.worker.cleanup(), {
      examined: 25,
      changed: 25,
      stalled: 0,
      more: false,
    });
    assert.equal(sessionPasses, 2);
    assert.equal(await retainedResults(), 0);
    assert.equal(
      Number(
        (
          await env.store.pool.query(
            "SELECT count(*) FROM haip_idempotency WHERE key LIKE 'retention-%' AND digest='retained-commitment'",
          )
        ).rows[0].count,
      ),
      1002,
      'cleared private results preserve commitments without requesting endless cleanup passes',
    );
    assert.equal(
      Number(
        (
          await env.store.pool.query(
            "SELECT count(*) FROM haip_sessions WHERE token_hash LIKE 'expired-%'",
          )
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await env.store.pool.query(
            "SELECT count(*) FROM haip_sessions WHERE token_hash='live-session'",
          )
        ).rows[0].count,
      ),
      1,
    );
    env.store.pool.query = query as any;
    env.store.transaction = transaction;
  } finally {
    await env.close();
  }
});

test('anchored and unanchored drains use tenant and readiness index bounds despite another tenant’s backlog', async () => {
  const env = await environment();
  try {
    await env.flush();
    await env.store.pool.query(
      `INSERT INTO haip_outbox(id,tenant,kind,body,next_at,created_at)
       SELECT gen_random_uuid(),'foreign-tenant','checkpoint',template.body,statement_timestamp()-interval '1 hour',statement_timestamp()-interval '1 day'
       FROM generate_series(1,10000),LATERAL(SELECT body FROM haip_outbox WHERE tenant='foreign-tenant' AND kind='checkpoint' LIMIT 1) template`,
    );
    await env.store.pool.query('ANALYZE haip_outbox');
    const query = env.store.pool.query.bind(env.store.pool),
      statements = new Set<string>();
    env.store.pool.query = (async (...args: any[]) => {
      if (String(args[0]).trimStart().startsWith('SELECT id,tenant FROM haip_outbox'))
        statements.add(String(args[0]));
      return (query as any)(...args);
    }) as any;
    await env.worker.tick();
    await new OutboxWorker(env.service).tick();
    env.store.pool.query = query as any;
    assert.equal(statements.size, 2);
    for (const statement of statements) {
      const explained = await env.store.pool.query(
        'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + statement,
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
            /tenant/.test(node['Index Cond'] ?? '') &&
            /next_at/.test(node['Index Cond'] ?? ''),
        ),
        JSON.stringify(plan),
      );
      assert(
        !nodes.some((node) => node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Sort'),
        JSON.stringify(plan),
      );
      assert(
        Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0) < 100,
        'an empty tenant does not scan another tenant’s 10000 pending jobs',
      );
    }
  } finally {
    await env.close();
  }
});
