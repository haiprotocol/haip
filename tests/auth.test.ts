import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';

async function begin(
  env: Awaited<ReturnType<typeof environment>>,
  oldCookie?: string,
  alter?: (query: URLSearchParams) => void,
  subject = 'reviewer',
) {
  const login = await fetch(env.origin + '/auth/login', {
    redirect: 'manual',
    headers: oldCookie ? { Cookie: oldCookie } : {},
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const provider = new URL(login.headers.get('location')!);
  alter?.(provider.searchParams);
  const grant = await fetch(provider.origin + '/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: provider.searchParams.toString(), subject }),
  });
  return { cookie, callback: grant.headers.get('location')! };
}
const fetchCallback = (flow: { cookie: string; callback: string }) =>
  fetch(flow.callback, {
    redirect: 'manual',
    headers: { Cookie: flow.cookie },
  });

test('OIDC state, nonce, PKCE, one-use callbacks and session rotation fail closed through HTTP', async () => {
  const env = await environment();
  try {
    const existing = await env.login();
    const sessionStatus = async (cookie = existing.cookie) =>
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: cookie } })).status;
    const invalidState = await begin(env, existing.cookie);
    assert.equal(await sessionStatus(), 200, 'GET login cannot terminate an authenticated session');
    const changed = new URL(invalidState.callback);
    changed.searchParams.set('state', 'unrelated-state');
    assert.notEqual((await fetchCallback({ ...invalidState, callback: changed.href })).status, 302);
    assert.equal(
      (await fetchCallback(invalidState)).status,
      401,
      'failed callback also consumes its login state',
    );
    assert.equal(
      await sessionStatus(),
      200,
      'wrong state and replay preserve the existing session',
    );
    for (const [name, value] of [
      ['nonce', 'wrong-nonce'],
      ['code_challenge', 'wrong-challenge'],
    ]) {
      const flow = await begin(env, existing.cookie, (q) => q.set(name!, value!));
      const failed = await fetchCallback(flow);
      assert.notEqual(failed.status, 302);
      assert.equal(
        failed.headers.getSetCookie().some((s) => s.startsWith('__Host-haip=')),
        false,
      );
      assert.equal((await fetchCallback(flow)).status, 401);
      assert.equal(
        await sessionStatus(),
        200,
        `${name} failure must preserve the existing session`,
      );
    }
    const unmapped = await begin(env, existing.cookie, undefined, 'not-in-the-directory');
    assert.equal((await fetchCallback(unmapped)).status, 403);
    assert.equal((await fetchCallback(unmapped)).status, 401);
    assert.equal(
      await sessionStatus(),
      200,
      'directory refusal also preserves the existing session',
    );
    const unrelated = await env.login();
    const valid = await begin(env, existing.cookie);
    assert.equal(await sessionStatus(), 200, 'rotation waits for a fully successful callback');
    const results = await Promise.all([fetchCallback(valid), fetchCallback(valid)]);
    assert.equal(results.filter((r) => r.status === 302).length, 1);
    assert.equal(results.filter((r) => r.status === 401).length, 1);
    const authenticated = results.find((r) => r.status === 302)!;
    const cookie = authenticated.headers
      .getSetCookie()
      .find((s) => s.startsWith('__Host-haip='))!
      .split(';')[0]!;
    assert.notEqual(cookie, existing.cookie);
    assert.notEqual(cookie.split('=')[1], valid.cookie.split('=')[1]);
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: cookie } })).status,
      200,
    );
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: valid.cookie } })).status,
      401,
    );
    assert.equal(await sessionStatus(), 401, 'success retires the session bound at login start');
    assert.equal(
      await sessionStatus(unrelated.cookie),
      200,
      'other sessions for the same human remain valid',
    );
  } finally {
    await env.close();
  }
});

test('failed authenticated-session insert preserves the old session but consumes login state', async () => {
  const env = await environment();
  try {
    const existing = await env.login(),
      flow = await begin(env, existing.cookie);
    // Exercise a real transaction failure after successful OIDC and directory validation.
    await env.store.pool
      .query(`CREATE FUNCTION reject_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture_session_insert_failure'; END;
    $$;
    CREATE TRIGGER reject_session_insert BEFORE INSERT ON haip_sessions
    FOR EACH ROW WHEN (NEW.data ? 'id' AND NEW.data ? 'tenant')
    EXECUTE FUNCTION reject_session_insert();`);
    const failed = await fetchCallback(flow);
    assert.equal(failed.status, 503);
    assert.equal(
      failed.headers.getSetCookie().some((value) => value.startsWith('__Host-haip=')),
      false,
    );
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: existing.cookie } })).status,
      200,
      'replacement failure must roll back retirement of the authenticated session',
    );
    assert.equal(
      (await fetchCallback(flow)).status,
      401,
      'login state is not restored by session rollback',
    );
    await env.store.pool.query(
      'DROP TRIGGER reject_session_insert ON haip_sessions; DROP FUNCTION reject_session_insert()',
    );
    const retry = await fetchCallback(await begin(env, existing.cookie));
    assert.equal(retry.status, 302);
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: existing.cookie } })).status,
      401,
    );
  } finally {
    await env.close();
  }
});

test('CSRF tokens with equal string lengths but unequal UTF-8 byte lengths return 403', async () => {
  const env = await environment();
  try {
    const human = await env.login(),
      created = await env.api('/v2/requests', env.request()),
      invalid = 'é' + human.csrf.slice(1);
    assert.equal(invalid.length, human.csrf.length);
    assert.notEqual(Buffer.byteLength(invalid, 'utf8'), Buffer.byteLength(human.csrf, 'utf8'));
    const refused = await human.call(
      `/v2/requests/${created.body.request.id}/assignment`,
      {},
      {
        'X-CSRF-Token': invalid,
      },
    );
    assert.equal(
      refused.status,
      403,
      'invalid CSRF must not throw a buffer-length error and become 503',
    );
    assert.equal(refused.body.error, 'csrf');
    assert.equal(
      (await human.call(`/v2/requests/${created.body.request.id}/assignment`, {})).status,
      200,
      'the same session and its genuine CSRF token remain usable',
    );
  } finally {
    await env.close();
  }
});
