import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HAIPClient } from '../haip-sdk/src/index.js';

test('SDK requests and CLI events use the same routes with a trailing slash', async () => {
  const received: { path: string; method: string; token: string; key?: string; body: string }[] =
    [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({
      path: request.url!,
      method: request.method!,
      token: request.headers.authorization!,
      key: request.headers['idempotency-key'] as string | undefined,
      body,
    });
    if (!request.url!.startsWith('/v2/')) {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"items":[],"next":0}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const configured of [origin, origin + '/']) {
      const client = new HAIPClient(configured, 'test-token', true);
      const events = await client.events();
      assert.deepEqual(events.items, []);
      assert.equal(events.next, 0);
      await client.cancel('request/with space', 'cancel-key');
    }
    const cli = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../haip-cli/src/index.ts', import.meta.url)),
        'events',
      ],
      {
        env: {
          ...process.env,
          HAIP_URL: origin + '/',
          HAIP_TOKEN: 'test-token',
          HAIP_LOCAL_HTTP: 'true',
        },
        timeout: 15000,
      },
    );
    assert.equal(cli.stderr, '');
    assert.deepEqual(JSON.parse(cli.stdout), { items: [], next: 0 });
    assert.deepEqual(
      received.map(({ path, method }) => ({ path, method })),
      [
        { path: '/v2/events?after=0', method: 'GET' },
        { path: '/v2/requests/request%2Fwith%20space/cancel', method: 'POST' },
        { path: '/v2/events?after=0', method: 'GET' },
        { path: '/v2/requests/request%2Fwith%20space/cancel', method: 'POST' },
        { path: '/v2/events?after=0', method: 'GET' },
      ],
    );
    assert(received.every((request) => request.token === 'Bearer test-token'));
    assert(
      received
        .filter((request) => request.method === 'POST')
        .every((request) => request.key === 'cancel-key' && request.body === '{}'),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('SDK accepts HTTPS origins and explicitly enabled HTTP loopback only', () => {
  assert.equal(
    new HAIPClient('HTTPS://EXAMPLE.INVALID:443/', 'test-token').origin,
    'https://example.invalid',
  );
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.throws(() => new HAIPClient(`http://${host}:8080`, 'test-token'), /requires HTTPS/);
    assert.equal(
      new HAIPClient(`http://${host}:8080/`, 'test-token', true).origin,
      `http://${host}:8080`,
    );
    for (const scheme of ['ftp:', 'ws:', 'file:'])
      assert.throws(
        () => new HAIPClient(`${scheme}//${host}/`, 'test-token', true),
        /requires HTTPS/,
      );
  }
  for (const host of ['example.invalid', 'localhost.example.invalid', '127.0.0.2'])
    assert.throws(() => new HAIPClient(`http://${host}`, 'test-token', true), /requires HTTPS/);
  for (const origin of [
    'https://user:password@example.invalid',
    'https://example.invalid/v2',
    'https://example.invalid/?query=value',
    'https://example.invalid/#fragment',
  ])
    assert.throws(() => new HAIPClient(origin, 'test-token'), /Expected an origin/);
});
