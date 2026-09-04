import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestBytes } from '@haip/protocol/crypto';
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
  const loginCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const provider = new URL(login.headers.get('location')!);
  alter?.(provider.searchParams);
  const grant = await fetch(provider.origin + '/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: provider.searchParams.toString(), subject }),
  });
  return {
    loginCookie,
    cookie: [
      loginCookie,
      ...(oldCookie
        ?.split(';')
        .map((value) => value.trim())
        .filter((value) => !value.startsWith('__Host-haip-login=')) ?? []),
    ].join('; '),
    callback: grant.headers.get('location')!,
  };
}
const fetchCallback = (flow: { cookie: string; callback: string }) =>
  fetch(flow.callback, {
    redirect: 'manual',
    headers: { Cookie: flow.cookie },
  });

async function holdExchange(
  env: Awaited<ReturnType<typeof environment>>,
  flow: { cookie: string; callback: string },
  run: (finish: () => Promise<Response>) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const code = new URL(flow.callback).searchParams.get('code');
  let pending: Promise<Response> | undefined;
  const timer = setTimeout(() => reached.reject(new Error('Token exchange was not reached')), 5000);
  timer.unref();
  try {
    globalThis.fetch = async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      const response = await originalFetch(input, options);
      if (
        url === env.service.config.oidc.issuer + '/token' &&
        new URLSearchParams(String(options?.body)).get('code') === code
      ) {
        reached.resolve();
        await release.promise;
      }
      return response;
    };
    pending = fetchCallback(flow);
    await reached.promise;
    clearTimeout(timer);
    await run(async () => {
      release.resolve();
      return pending!;
    });
  } finally {
    clearTimeout(timer);
    release.resolve();
    globalThis.fetch = originalFetch;
    await pending?.catch(() => undefined);
  }
}

test('new pending login generations prevent delayed anonymous and expired-session callbacks replacing a newer sign-in', async () => {
  const env = await environment();
  try {
    for (const expired of [false, true]) {
      let initialCookie: string | undefined;
      if (expired) {
        initialCookie = (await env.login()).cookie;
        await env.store.pool.query(
          "UPDATE haip_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
          [digestBytes(initialCookie.slice('__Host-haip='.length))],
        );
      }
      const slow = await begin(env, initialCookie);
      await holdExchange(env, slow, async (finish) => {
        const fresh = await begin(env, slow.cookie, undefined, 'reviewer2');
        assert.equal(
          fresh.loginCookie,
          slow.loginCookie,
          'the same browser retains its pending flow handle',
        );
        assert.notEqual(
          new URL(fresh.callback).searchParams.get('state'),
          new URL(slow.callback).searchParams.get('state'),
        );
        assert.equal(
          (await fetchCallback(slow)).status,
          401,
          'an old state cannot consume the new generation',
        );
        const accepted = await fetchCallback(fresh);
        assert.equal(accepted.status, 302);
        const currentCookie = accepted.headers
          .getSetCookie()
          .find((value) => value.startsWith('__Host-haip='))!
          .split(';')[0]!;
        const stale = await finish();
        assert.equal(
          stale.status,
          401,
          'the delayed callback must recheck its generation after OIDC I/O',
        );
        assert.equal(
          stale.headers.getSetCookie().length,
          0,
          'the stale response must not alter either browser cookie',
        );
        const current = await fetch(env.origin + '/auth/session', {
          headers: { Cookie: currentCookie },
        });
        assert.equal(current.status, 200);
        assert.equal((await current.json()).subject, 'reviewer2');
      });
    }
  } finally {
    await env.close();
  }
});

test('a refused newer login does not revive an older claimed generation or retire the existing session', async () => {
  const env = await environment();
  try {
    const existing = await env.login();
    const slow = await begin(env, existing.cookie);
    await holdExchange(env, slow, async (finish) => {
      const refused = await begin(env, slow.cookie, undefined, 'not-in-the-directory');
      assert.equal((await fetchCallback(refused)).status, 403);
      assert.equal((await finish()).status, 401);
      assert.equal(
        (await fetch(env.origin + '/auth/session', { headers: { Cookie: existing.cookie } }))
          .status,
        200,
      );
    });
  } finally {
    await env.close();
  }
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
    const unclaimed = await env.store.pool.query(
      "SELECT data->'login' ? 'claimed' AS claimed FROM haip_sessions WHERE token_hash=$1",
      [digestBytes(invalidState.loginCookie.slice('__Host-haip-login='.length))],
    );
    assert.equal(
      unclaimed.rows[0].claimed,
      false,
      'a stale or unrelated state cannot claim the current generation',
    );
    assert.equal(await sessionStatus(), 200, 'wrong state preserves the existing session');
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
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: valid.loginCookie } }))
        .status,
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

test('callback requires the same authenticated-cookie state that initiated login, before token exchange', async () => {
  const env = await environment();
  try {
    const existing = await env.login(),
      other = await env.login('reviewer2');
    for (const item of [
      { label: 'missing authenticated cookie', before: existing.cookie, current: undefined },
      { label: 'different authenticated cookie', before: existing.cookie, current: other.cookie },
      {
        label: 'anonymous login transplanted into an authenticated browser',
        before: undefined,
        current: existing.cookie,
      },
    ]) {
      const flow = await begin(env, item.before);
      const loginToken = flow.loginCookie.slice('__Host-haip-login='.length);
      const stored = (
        await env.store.pool.query('SELECT data FROM haip_sessions WHERE token_hash=$1', [
          digestBytes(loginToken),
        ])
      ).rows[0].data.login;
      const rejected = await fetchCallback({
        ...flow,
        cookie: [flow.loginCookie, item.current].filter(Boolean).join('; '),
      });
      assert.equal(rejected.status, 401, item.label);
      assert.equal(
        rejected.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-haip=')),
        false,
      );
      assert.equal(
        (await fetchCallback(flow)).status,
        401,
        'binding failure consumes the one-use login state',
      );
      // The fixture code is still usable: refusal happened before any token exchange.
      const token = await fetch(env.service.config.oidc.issuer + '/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: new URL(flow.callback).searchParams.get('code')!,
          client_id: 'haip-test',
          client_secret: 'test-secret',
          redirect_uri: env.origin + '/auth/callback',
          code_verifier: stored.verifier,
        }),
      });
      assert.equal(
        token.status,
        200,
        'the refused callback must not redeem the identity-provider code',
      );
      for (const human of [existing, other])
        assert.equal(
          (await fetch(env.origin + '/auth/session', { headers: { Cookie: human.cookie } })).status,
          200,
        );
    }
  } finally {
    await env.close();
  }
});

test('callback finishing after another login retires its initiating session cannot overwrite the replacement', async () => {
  const env = await environment();
  const originalFetch = globalThis.fetch;
  const tokenReceived = Promise.withResolvers<void>(),
    releaseToken = Promise.withResolvers<void>();
  let delayed: Promise<Response> | undefined;
  try {
    const existing = await env.login();
    const slow = await begin(env, existing.cookie);
    const code = new URL(slow.callback).searchParams.get('code');
    globalThis.fetch = async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      const response = await originalFetch(input, options);
      if (
        url === env.service.config.oidc.issuer + '/token' &&
        new URLSearchParams(String(options?.body)).get('code') === code
      ) {
        tokenReceived.resolve();
        await releaseToken.promise;
      }
      return response;
    };
    delayed = fetchCallback(slow);
    await Promise.race([
      tokenReceived.promise,
      new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The first callback never reached token exchange')),
          5000,
        );
        timer.unref();
        tokenReceived.promise.then(() => clearTimeout(timer));
      }),
    ]);
    const replacement = await fetchCallback(
      await begin(env, existing.cookie, undefined, 'reviewer2'),
    );
    assert.equal(replacement.status, 302);
    const replacementCookie = replacement.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Host-haip='))!
      .split(';')[0]!;
    releaseToken.resolve();
    const stale = await delayed;
    assert.equal(
      stale.status,
      401,
      'a callback whose original cookie was valid at arrival must recheck retirement atomically',
    );
    assert.equal(
      stale.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-haip=')),
      false,
    );
    const current = await fetch(env.origin + '/auth/session', {
      headers: { Cookie: replacementCookie },
    });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).subject, 'reviewer2');
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: existing.cookie } })).status,
      401,
    );
    assert.equal((await fetchCallback(slow)).status, 401);
  } finally {
    releaseToken.resolve();
    globalThis.fetch = originalFetch;
    await delayed?.catch(() => undefined);
    await env.close();
  }
});

test('logout invalidates a pending rotation while a fresh login can recover from an already expired cookie', async () => {
  const env = await environment();
  try {
    const human = await env.login(),
      pending = await begin(env, human.cookie);
    const logout = await fetch(env.origin + '/auth/logout', {
      method: 'POST',
      headers: { Cookie: human.cookie, Origin: env.origin, 'X-CSRF-Token': human.csrf },
    });
    assert.equal(logout.status, 204);
    assert.equal(
      (await fetchCallback(pending)).status,
      401,
      'a pending callback cannot undo a completed logout',
    );
    const expired = await env.login();
    await env.store.pool.query(
      "UPDATE haip_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
      [digestBytes(expired.cookie.slice('__Host-haip='.length))],
    );
    const fresh = await fetchCallback(await begin(env, expired.cookie));
    assert.equal(fresh.status, 302, 'an expired cookie must not prevent starting a fresh sign-in');
    const cookie = fresh.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-haip='))!
      .split(';')[0]!;
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: cookie } })).status,
      200,
    );
    const malformed = await fetch(env.origin + '/auth/callback', {
      redirect: 'manual',
      headers: {
        Cookie: '__Host-haip-login=' + cookie.slice('__Host-haip='.length) + '; ' + cookie,
      },
    });
    assert.equal(malformed.status, 401);
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: cookie } })).status,
      200,
      'only login records may be consumed as callback state',
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
