import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';
import { validate } from '../haip-server/src/validation.js';

async function copies(env: Awaited<ReturnType<typeof environment>>, id: string, count: number) {
  await env.store.pool.query(
    `INSERT INTO haip_requests(tenant,id,producer,route,data,material,retained_bytes,created_at)
     SELECT r.tenant,copy.id,r.producer,r.route,
       jsonb_set(r.data,'{request,id}',to_jsonb(copy.id::text)),NULL,0,r.created_at
     FROM haip_requests r CROSS JOIN (SELECT gen_random_uuid() AS id FROM generate_series(1,$2::integer)) copy
     WHERE r.tenant='test-tenant' AND r.id=$1`,
    [id, count],
  );
}

test('inbox lookahead returns truthful empty, exact and partial pages without counting retained history', async () => {
  const env = await environment();
  try {
    assert.deepEqual((await env.api('/v2/requests')).body, { items: [], next_offset: null });
    const initial = await env.api('/v2/requests', env.request());
    assert.equal(initial.status, 201);
    const id = initial.body.request.id;
    await copies(env, id, 49);
    const read = env.store.read.bind(env.store);
    const queries: { sql: string; rows: number }[] = [];
    env.store.read = (run) =>
      read((tx, now) => {
        const query = tx.query.bind(tx);
        const observed = new Proxy(tx, {
          get(target, name) {
            if (name !== 'query') return Reflect.get(target, name);
            return async (...args: any[]) => {
              const result = await (query as any)(...args);
              if (/\bFROM\s+haip_requests\b/i.test(String(args[0])))
                queries.push({ sql: String(args[0]), rows: result.rows.length });
              return result;
            };
          },
        });
        return run(observed, now);
      });
    try {
      const exact = await env.api('/v2/requests');
      assert.equal(exact.status, 200);
      assert.equal(exact.body.items.length, 50);
      assert.equal(exact.body.next_offset, null);
      assert.equal(exact.body.total, undefined);
      validate('RequestList', exact.body);
      await copies(env, id, 1);
      const first = await env.api('/v2/requests');
      const last = await env.api('/v2/requests?offset=' + first.body.next_offset);
      assert.equal(first.body.items.length, 50);
      assert.equal(first.body.next_offset, 50);
      assert.equal(last.body.items.length, 1);
      assert.equal(last.body.next_offset, null);
      validate('RequestList', first.body);
      validate('RequestList', last.body);
      assert.equal(
        new Set([...first.body.items, ...last.body.items].map((r: { id: string }) => r.id)).size,
        51,
      );
      assert.deepEqual((await env.api('/v2/requests?offset=100')).body, {
        items: [],
        next_offset: null,
      });
      assert.deepEqual(
        (await env.api('/v2/requests', undefined, env.credentials.otherProducer)).body,
        { items: [], next_offset: null },
      );
      assert(queries.length > 0);
      assert(
        queries.every((q) => q.rows <= 51),
        'only a page and one lookahead row are loaded',
      );
      assert(
        queries.every((q) => !/\bcount\s*\(/i.test(q.sql)),
        'listing must not aggregate the whole visible history to compute a total',
      );
    } finally {
      env.store.read = read;
    }
  } finally {
    await env.close();
  }
});

test(
  'the last allowed inbox page never advertises an offset the service rejects',
  { timeout: 45000 },
  async () => {
    const env = await environment();
    try {
      const initial = await env.api('/v2/requests', env.request());
      assert.equal(initial.status, 201);
      // A real retained history leaves one lookahead row beyond the final accepted page.
      await copies(env, initial.body.request.id, 100050);
      const beforeLast = await env.api('/v2/requests?offset=99950');
      assert.equal(beforeLast.status, 200);
      assert.equal(beforeLast.body.items.length, 50);
      assert.equal(beforeLast.body.next_offset, 100000);
      const last = await env.api('/v2/requests?offset=' + beforeLast.body.next_offset);
      assert.equal(last.status, 200);
      assert.equal(last.body.items.length, 50);
      assert.equal(last.body.next_offset, null);
      validate('RequestList', last.body);
      assert.equal((await env.api('/v2/requests?offset=100001')).status, 400);
    } finally {
      await env.close();
    }
  },
);
