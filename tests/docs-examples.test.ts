import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

test('current navigation and archive links preserve their declared documentation version', async () => {
  const navigation = JSON.parse(await read('docs/docs.json'));
  const versions = JSON.parse(await read('docs/versions.json'));
  const workspace = JSON.parse(await read('package.json'));
  assert.equal(versions.current.protocol, workspace.version);
  const pages: string[] = navigation.navigation.groups.flatMap(
    (group: { pages: string[] }) => group.pages,
  );
  assert.equal(new Set(pages).size, pages.length);
  for (const page of pages) await stat(new URL(`docs/${page}.mdx`, root));
  for (const file of await readdir(new URL('docs/', root), { recursive: true })) {
    if (!file.endsWith('.mdx')) continue;
    if (!file.startsWith('archive/')) {
      assert(pages.includes(file.slice(0, -4)), `Live page missing from navigation: ${file}`);
      continue;
    }
    const source = await read('docs/' + file);
    assert(source.includes('Unsupported HAIP 1 archive.'), `Missing archive banner: ${file}`);
    for (const link of source.matchAll(/(?:\]\(|\bhref=["'])(\/[^)\s"']+)/g)) {
      const path = new URL(link[1], 'https://docs.invalid').pathname;
      if (path === '/index') continue;
      assert(path.startsWith('/archive/v1/'), `${file} leaves the archive: ${link[1]}`);
      await stat(new URL(`docs${path}${extname(path) ? '' : '.mdx'}`, root));
    }
  }
  for (const redirect of navigation.redirects)
    await stat(new URL(`docs${redirect.destination}.mdx`, root));
  const archived = versions.archive.find((version: { major: number }) => version.major === 1);
  assert.equal(archived.supported, false);
  await stat(new URL(`docs${archived.path}.mdx`, root));
  await stat(new URL(`docs${archived.openapi}`, root));
  await stat(new URL(`${archived.source}/LICENSE`, root));
});

test('the executable HTTP review example normalises origins and rejects foreign URL components', async () => {
  const requests: { path: string; token: string; key: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url!,
      token: request.headers.authorization!,
      key: request.headers['idempotency-key'] as string,
      body: JSON.parse(body),
    });
    response.writeHead(201, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        request: { id: 'example-request' },
        review_link: '/review/example-request',
        polling_link: '/v2/requests/example-request',
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = (configured: string, local = 'true') =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('examples/http/review.mjs', root))],
      {
        timeout: 10000,
        env: {
          HAIP_URL: configured,
          HAIP_TOKEN: 'isolated-example-token',
          HAIP_IDEMPOTENCY_KEY: 'isolated-example-key',
          HAIP_LOCAL_HTTP: local,
        },
      },
    );
  try {
    for (const configured of [origin, origin + '/']) {
      const result = await run(configured);
      assert.equal(JSON.parse(result.stdout).request_id, 'example-request');
      assert.equal(result.stderr, '');
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.path, '/v2/requests');
      assert.equal(request.token, 'Bearer isolated-example-token');
      assert.equal(request.key, 'isolated-example-key');
      assert.equal(request.body.purpose, 'review');
      assert.equal(request.body.execution, undefined);
    }
    for (const configured of [
      origin + '/v2',
      origin + '/?query=value',
      origin + '/#fragment',
      origin.replace('http://', 'http://user:password@'),
      origin.replace('http:', 'ftp:'),
      origin.replace('127.0.0.1', '127.0.0.2'),
    ])
      await assert.rejects(() => run(configured));
    await assert.rejects(() => run(origin, 'false'));
    assert.equal(requests.length, 2, 'invalid origins must fail before a request');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
