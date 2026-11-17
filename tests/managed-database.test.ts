import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import pgClient from 'pg';
import { digestBytes } from '@haip/protocol/crypto';
import { createRuntimeStore } from '../haip-server/src/runtime.js';
import { neonConnection } from '../haip-server/src/neon.js';
import { pruneRequestAdmission, requestRateLimit } from '../haip-server/src/rate-limit.js';
import { Store } from '../haip-server/src/store.js';
import { postgres } from './fixtures/postgres.js';

test('Neon runtime and offline operations use separate connection modes with verified TLS', async () => {
  const endpoint = 'ep-haip-test.eu-west-2.aws.neon.tech';
  const direct = 'postgresql://fixture:fixture@' + endpoint + '/haip?sslmode=verify-full';
  const pooled = direct.replace('ep-haip-test.', 'ep-haip-test-pooler.');
  const options = { HAIP_MODE: 'production', HAIP_DATABASE_PROVIDER: 'neon' };
  for (const [url, role, max] of [
    [direct, 'administrative', 1],
    [pooled, 'runtime', 3],
  ] as const) {
    const connection = neonConnection(url, role);
    const actual = new pgClient.Client({ ...connection.options, connectionString: connection.url });
    const ssl = (actual as any).connectionParameters.ssl as ConnectionOptions;
    assert.equal(ssl.rejectUnauthorized, true);
    const configuredHost = new URL(url).hostname;
    const cert = { subjectaltname: `DNS:${configuredHost}` } as Parameters<
      typeof checkServerIdentity
    >[1];
    assert.equal(ssl.checkServerIdentity!('ignored', cert), undefined);
    assert.ok(
      ssl.checkServerIdentity!(configuredHost, { ...cert, subjectaltname: 'DNS:other.test' }),
    );
    const store = createRuntimeStore({ ...options, HAIP_DATABASE_URL: url }, role);
    try {
      assert.equal(store.pool.options.max, max);
      assert.equal(store.pool.options.connectionTimeoutMillis, 8000);
      assert.equal(store.pool.totalCount, 0);
    } finally {
      await store.close();
    }
  }
  assert.throws(() => neonConnection(direct, 'runtime'), /pooled endpoint/);
  assert.throws(() => neonConnection(pooled, 'administrative'), /direct endpoint/);
  for (const url of [
    pooled.replace('verify-full', 'require'),
    pooled.replace('.neon.tech', '.neon.tech.attacker.test'),
    pooled + '&host=other.test',
    pooled + '&sslmode=disable',
    pooled + '&options=-c%20search_path%3Devil',
  ])
    assert.throws(() => neonConnection(url, 'runtime'));
  assert.throws(
    () => createRuntimeStore({ ...options, HAIP_MODE: 'development', HAIP_DATABASE_URL: pooled }),
    /production mode/,
  );
});

test('independent HTTP instances share one atomic request allowance and stop on database errors', async () => {
  const pg = await postgres();
  const stores = [new Store(pg.url), new Store(pg.url)];
  const store = stores[0]!;
  const servers = stores.map(({ pool }) => {
    const app = express();
    app.get(
      '/limited',
      requestRateLimit({ limit: 4, identifier: 'fixture-global' }, pool),
      (_req, res) => res.sendStatus(204),
    );
    app.get(
      '/other',
      requestRateLimit({ limit: 2, identifier: 'fixture-other' }, pool),
      (_req, res) => res.sendStatus(204),
    );
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.sendStatus(503);
      },
    );
    return createServer(app);
  });
  try {
    await store.migrate();
    for (const server of servers)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const call = async (index: number, route: string) => {
      const port = (servers[index % 2]!.address() as { port: number }).port;
      const result = await fetch(`http://127.0.0.1:${port}/${route}`);
      await result.arrayBuffer();
      return result.status;
    };
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) => call(index, 'limited')),
    );
    assert.equal(results.filter((status) => status === 204).length, 4);
    assert.equal(results.filter((status) => status === 429).length, 20);
    assert.equal(await call(1, 'other'), 204);

    await store.pool.query(
      "UPDATE haip_request_admission SET expires_at=statement_timestamp() WHERE bucket='fixture-global'",
    );
    assert.equal(await call(1, 'limited'), 204);
    const window = await store.pool.query(
      "SELECT hits,key_digest FROM haip_request_admission WHERE bucket='fixture-global'",
    );
    assert.deepEqual(window.rows, [{ hits: 1, key_digest: digestBytes('service') }]);

    await store.pool.query(
      "UPDATE haip_request_admission SET expires_at=statement_timestamp() WHERE bucket='fixture-other'",
    );
    assert.equal(await pruneRequestAdmission(store.pool), false);
    assert.deepEqual((await store.pool.query('SELECT bucket FROM haip_request_admission')).rows, [
      { bucket: 'fixture-global' },
    ]);
    await store.pool.query('DROP TABLE haip_request_admission');
    assert.equal(await call(0, 'limited'), 503);
    assert.equal(await call(1, 'limited'), 503);
  } finally {
    for (const server of servers) server.close();
    await Promise.all(stores.map((item) => item.close()));
    await pg.close();
  }
});
