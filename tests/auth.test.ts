import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './environment.js';

test('OIDC state, nonce, PKCE, one-use callbacks and session rotation fail closed through HTTP', async () => {
  const env = await environment();
  try {
    const existing = await env.login();
    async function begin(oldCookie?: string, alter?: (query: URLSearchParams) => void) {
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
        body: new URLSearchParams({ query: provider.searchParams.toString(), subject: 'reviewer' }),
      });
      return { cookie, callback: grant.headers.get('location')! };
    }
    const fetchCallback = (flow: { cookie: string; callback: string }) =>
      fetch(flow.callback, {
        redirect: 'manual',
        headers: { Cookie: flow.cookie },
      });
    const invalidState = await begin(existing.cookie);
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: existing.cookie } })).status,
      401,
    );
    const changed = new URL(invalidState.callback);
    changed.searchParams.set('state', 'unrelated-state');
    assert.notEqual((await fetchCallback({ ...invalidState, callback: changed.href })).status, 302);
    assert.equal(
      (await fetchCallback(invalidState)).status,
      401,
      'failed callback also consumes its login state',
    );
    for (const [name, value] of [
      ['nonce', 'wrong-nonce'],
      ['code_challenge', 'wrong-challenge'],
    ]) {
      const flow = await begin(undefined, (q) => q.set(name!, value!));
      const failed = await fetchCallback(flow);
      assert.notEqual(failed.status, 302);
      assert.equal(
        failed.headers.getSetCookie().some((s) => s.startsWith('__Host-haip=')),
        false,
      );
      assert.equal((await fetchCallback(flow)).status, 401);
    }
    const valid = await begin();
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
  } finally {
    await env.close();
  }
});
