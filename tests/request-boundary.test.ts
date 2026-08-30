import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { environment } from './environment.js';

let env: Awaited<ReturnType<typeof environment>>;
before(async () => {
  env = await environment();
});
after(async () => {
  await env?.close();
});

function rejectUnfinishedBody(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(env.origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    });
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('Server waited for a rejected request body'));
    }, 2500);
    req.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    req.on('response', (response) => {
      clearTimeout(timeout);
      const status = response.statusCode!;
      response.resume();
      response.on('end', () => {
        req.destroy();
        resolve(status);
      });
    });
    req.flushHeaders();
    req.write('{"untrusted":[');
    // Intentionally never finish the body: admission must not wait for it.
  });
}

test('unauthenticated, unknown and wrong-role requests are refused before reading unfinished bodies', async () => {
  assert.equal(await rejectUnfinishedBody('/v2/requests'), 401);
  assert.equal(
    await rejectUnfinishedBody('/v2/requests', { 'Content-Length': String(22 * 1024 ** 2) }),
    401,
  );
  assert.equal(await rejectUnfinishedBody('/not-a-route'), 404);
  assert.equal(
    await rejectUnfinishedBody('/v2/not-a-route', {
      Authorization: 'Bearer ' + env.credentials.producer,
    }),
    404,
  );
  assert.equal(
    await rejectUnfinishedBody('/v2/requests', {
      Authorization: 'Bearer ' + env.credentials.publisher,
    }),
    403,
  );
  assert.equal(
    await rejectUnfinishedBody('/v2/bundles', {
      Authorization: 'Bearer ' + env.credentials.producer,
    }),
    403,
  );
});

test('authenticated JSON is strict and large-body limits apply only to routes that need them', async () => {
  const duplicate = await env.api(
    '/v2/requests',
    '{"purpose":"review","purpose":"authorise_execution"}',
  );
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error, 'invalid_json');
  const invalidUtf8 = await fetch(env.origin + '/v2/requests', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.credentials.producer,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  });
  assert.equal(invalidUtf8.status, 400);
  assert.equal((await invalidUtf8.json()).error, 'invalid_json');
  const large = await env.api(
    '/v2/requests',
    env.request(false, { payload: { text: 'a'.repeat(1024 ** 2 + 1) } }),
  );
  assert.equal(large.status, 201, JSON.stringify(large.body));
  const human = await env.login();
  const oversizedControl = await human.call(`/v2/requests/${large.body.request.id}/assignment`, {
    ignored: 'x'.repeat(70 * 1024),
  });
  assert.equal(oversizedControl.status, 413);
  assert.equal(oversizedControl.body.error, 'body_too_large');
  const incorrectEncoding = await env.api(
    '/v2/requests',
    env.request(),
    env.credentials.producer,
    'POST',
    { 'Content-Encoding': 'gzip' },
  );
  assert.equal(incorrectEncoding.status, 415);
});

test('review CSP permits only its bound sandbox and stored bundle corruption is refused before delivery', async () => {
  const html = '<!doctype html><p>Bound review app</p>';
  const registered = await env.api(
    '/v2/bundles',
    {
      html,
      compatibility: { ext_apps: '1.7.4', mcp_sdk: '1.29.0' },
      author: 'Test fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const created = await env.api(
    '/v2/requests',
    env.request(false, {
      bundle_id: registered.body.id,
      profiles: { 'haip.mcp-app': '1-draft.1' },
    }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const human = await env.login();
  const id = created.body.request.id;
  const app = await human.call(`/v2/requests/${id}/app`);
  assert.equal(app.status, 200, JSON.stringify(app.body));
  assert.equal(app.body.html, html);
  const reviewPage = await fetch(env.origin + '/review/' + id, {
    headers: { Cookie: human.cookie },
  });
  assert.equal(reviewPage.status, 200);
  const policy = reviewPage.headers.get('Content-Security-Policy')!;
  assert.equal(
    policy
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('frame-src ')),
    'frame-src ' + app.body.origin,
  );
  const inbox = await fetch(env.origin + '/inbox', { headers: { Cookie: human.cookie } });
  assert.match(inbox.headers.get('Content-Security-Policy')!, /frame-src 'none'/);
  const sandbox = new URL(app.body.origin);
  for (const path of ['/unknown', '/sandbox/not-a-scope', '/sandbox/' + app.body.scope]) {
    const result = await new Promise<{
      status: number;
      headers: import('node:http').IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = httpRequest(
        `http://localhost:${sandbox.port}${path}`,
        { headers: { Host: sandbox.host } },
        (response) => {
          response.resume();
          response.on('end', () =>
            resolve({ status: response.statusCode!, headers: response.headers }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(result.status, path.endsWith(app.body.scope) ? 200 : 404);
    assert.match(result.headers['content-security-policy'] as string, /default-src 'none'/);
    assert.match(result.headers['content-security-policy'] as string, /connect-src 'none'/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
  }
  await env.store.pool.query('UPDATE haip_bundles SET html=$1 WHERE tenant=$2 AND id=$3', [
    '<script>changed()</script>',
    'test-tenant',
    registered.body.id,
  ]);
  const corrupted = await human.call(`/v2/requests/${id}/app`);
  assert.equal(corrupted.status, 409);
  assert.equal(corrupted.body.error, 'bundle_integrity_mismatch');
  assert.equal(corrupted.body.html, undefined);
  await env.store.pool.query(
    "UPDATE haip_bundles SET html=$1,manifest=jsonb_set(manifest,'{publisher}','\"different\"') WHERE tenant=$2 AND id=$3",
    [html, 'test-tenant', registered.body.id],
  );
  assert.equal(
    (await human.call(`/v2/requests/${id}/app`)).body.error,
    'bundle_integrity_mismatch',
  );
});

test('an exhausted producer is refused before its next body is buffered while existing review remains available', async () => {
  const created = await env.api('/v2/requests', env.request());
  assert.equal(created.status, 201);
  await env.store.pool.query(
    "UPDATE haip_creation_windows SET count=200 WHERE tenant='test-tenant' AND scope='producer' AND subject='producer' AND day=(clock_timestamp() AT TIME ZONE 'UTC')::date",
  );
  assert.equal(
    await rejectUnfinishedBody('/v2/requests', {
      Authorization: 'Bearer ' + env.credentials.producer,
    }),
    429,
  );
  const human = await env.login();
  const candidate = await human.call(`/v2/requests/${created.body.request.id}/candidates`, {
    decision: 'answer',
    response: { choice: 'accept' },
  });
  assert.equal(candidate.status, 201);
  const { digest } = await import('@haip/protocol/crypto');
  assert.equal(
    (
      await human.call(`/v2/requests/${created.body.request.id}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      })
    ).status,
    200,
  );
});
