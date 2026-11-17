import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, digestBytes } from '@haip/protocol/crypto';
import { RecoveryGuard } from '../haip-server/src/recovery.js';
import { environment } from './environment.js';
import { TestSafetyStore } from './fixtures/safety.js';

test('OAuth metadata discovery and Basic client authentication support provider configuration without a browser SDK', async () => {
  const env = await environment();
  try {
    env.service.config.oidc.discovery = 'oauth2';
    env.service.config.oidc.clientAuth = 'client_secret_basic';
    const created = await env.api('/v2/requests', env.request());
    const reviewer = await env.login();
    assert.equal((await reviewer.call(`/v2/requests/${created.body.request.id}`)).status, 200);
  } finally {
    await env.close();
  }
});

test('logout stops an authenticated confirmation waiting for its transaction', async () => {
  const env = await environment({ singleTenant: true });
  try {
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const path = '/v2/requests/' + created.body.request.id;
    const human = await env.login();
    const candidate = await human.call(path + '/candidates', {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201);
    const input = { candidate_id: candidate.body.id, candidate_digest: digest(candidate.body) };
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const confirm = env.service.confirm.bind(env.service);
    env.service.confirm = async (...args) => {
      ready.resolve();
      await resume.promise;
      return confirm(...args);
    };
    const pending = human.call(path + '/confirm', input);
    try {
      await Promise.race([
        ready.promise,
        pending.then(({ status }) => {
          throw new Error(`Confirmation returned ${status} before entering the service`);
        }),
      ]);
      const logout = await fetch(env.origin + '/auth/logout', {
        method: 'POST',
        headers: { Cookie: human.cookie, Origin: env.origin, 'X-CSRF-Token': human.csrf },
      });
      assert.equal(logout.status, 204);
    } finally {
      resume.resolve();
      try {
        await pending;
      } finally {
        env.service.confirm = confirm;
      }
    }
    const refused = await pending;
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error, 'unauthenticated');
    assert.equal((await env.api(path)).body.receipt, null);
    const fresh = await env.login();
    assert.equal((await fresh.call(path + '/confirm', input)).status, 200);
  } finally {
    await env.close();
  }
});

test('a session that expires during recovery verification cannot confirm an execution', async (t) => {
  const env = await environment({ singleTenant: true });
  const directory = await mkdtemp(join(tmpdir(), 'haip-expiring-reviewer-'));
  try {
    const safety = new TestSafetyStore(directory);
    env.service.recovery = new RecoveryGuard(env.service, safety);
    await env.worker.reconcile();
    const created = await env.api('/v2/requests', env.request(true));
    assert.equal(created.status, 201);
    const path = '/v2/requests/' + created.body.request.id;
    const human = await env.login();
    const candidate = await human.call(path + '/candidates', {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201);
    const input = { candidate_id: candidate.body.id, candidate_digest: digest(candidate.body) };
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const read = safety.read.bind(safety);
    t.mock.method(safety, 'read', async (key: string) => {
      ready.resolve();
      await resume.promise;
      return read(key);
    });
    const pending = human.call(path + '/confirm', input);
    try {
      await Promise.race([
        ready.promise,
        pending.then(({ status }) => {
          throw new Error(`Confirmation returned ${status} before checking recovery`);
        }),
      ]);
      const token = human.cookie.slice('__Host-haip='.length);
      const expired = await env.store.pool.query(
        'UPDATE haip_sessions SET expires_at=clock_timestamp() WHERE token_hash=$1',
        [digestBytes(token)],
      );
      assert.equal(expired.rowCount, 1);
    } finally {
      resume.resolve();
      await pending;
    }
    const refused = await pending;
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error, 'unauthenticated');
    assert.equal((await env.api(path)).body.receipt, null);
    const fresh = await env.login();
    assert.equal((await fresh.call(path + '/confirm', input)).status, 200);
  } finally {
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('re-enabling a reviewer requires a new session', async () => {
  const env = await environment({ singleTenant: true });
  try {
    const reviewer = await env.login();
    const other = await env.login('reviewer2');
    const config = {
      oidc_issuer: env.service.config.oidc.issuer,
      oidc_subject: 'reviewer',
      identity_certain: true,
    };
    await env.principal('reviewer', 'human', { ...config, enabled: false });
    assert.equal((await reviewer.call('/auth/session')).status, 401);
    await env.principal('reviewer', 'human', { ...config, enabled: true });
    assert.equal((await reviewer.call('/auth/session')).status, 401);
    const mixed = await fetch(env.origin + '/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.credentials.producer, Cookie: other.cookie },
    });
    assert.equal(mixed.status, 403);
    assert.equal((await other.call('/auth/session')).status, 200);
    assert.equal((await (await env.login()).call('/auth/session')).status, 200);
  } finally {
    await env.close();
  }
});

test('reassignment and reviewer removal do not reset proposal limits or deadlines', async () => {
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request()),
      id = created.body.request.id;
    const human = await env.login(),
      other = await env.login('reviewer2');
    assert.equal((await human.call(`/v2/requests/${id}/assignment`, {})).status, 200);
    assert.equal((await other.call(`/v2/requests/${id}/assignment`, {})).status, 409);
    for (let i = 0; i < 31; i++)
      assert.equal(
        (
          await human.call(`/v2/requests/${id}/candidates`, {
            decision: 'answer',
            response: { choice: 'accept' },
          })
        ).status,
        201,
      );
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      reviewers: ['reviewer2', 'requester'],
    });
    assert.equal((await other.call(`/v2/requests/${id}/assignment`, {})).status, 200);
    const last = await other.call(`/v2/requests/${id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(last.status, 201);
    assert.equal(last.body.revision, 32);
    assert.equal(
      (
        await other.call(`/v2/requests/${id}/candidates`, {
          decision: 'answer',
          response: { choice: 'decline' },
        })
      ).body.error,
      'proposal_revision_limit',
    );
    assert.equal(
      (
        await other.call(`/v2/requests/${id}/confirm`, {
          candidate_id: last.body.id,
          candidate_digest: digest(last.body),
        })
      ).status,
      200,
    );
    assert.equal(
      (await env.api(`/v2/requests/${id}`)).body.request.review_deadline,
      created.body.request.review_deadline,
    );
  } finally {
    await env.close();
  }
});

test('owner removal and producer deauthorisation are permanent, while unrelated route additions preserve grants', async () => {
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request(true)),
      id = created.body.request.id;
    const human = await env.login();
    const proposal = await human.call(`/v2/requests/${id}/candidates`, {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: proposal.body.id,
      candidate_digest: digest(proposal.body),
    });
    await env.flush();
    await env.principal(
      'producer',
      'producer',
      {
        enabled: true,
        publisher: 'publisher',
        owner: 'requester',
        routes: ['review', 'unrelated'],
      },
      env.credentials.producer,
    );
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      allowed_producers: [...env.route.allowed_producers, 'unrelated-producer'],
    });
    assert.equal((await env.api(`/v2/requests/${id}`)).body.grant_state, 'available');
    const owner = {
      enabled: false,
      identity_certain: true,
      oidc_issuer: env.service.config.oidc.issuer,
      oidc_subject: 'requester',
    };
    await env.principal('requester', 'human', owner);
    await env.principal('requester', 'human', { ...owner, enabled: true });
    assert.equal((await env.api(`/v2/requests/${id}`)).body.grant_state, 'revoked');
    assert.equal(
      (
        await env.api(`/v2/requests/${id}/claims`, {
          execution_identity: 'cannot-revive',
          execution_binding_digest: digest(created.body.request.execution),
        })
      ).status,
      409,
    );
  } finally {
    await env.close();
  }
});

test('response fields may use schema keyword names without enabling remote references or patterns', async () => {
  const env = await environment();
  try {
    const input = env.request(false, {
      response_schema: {
        type: 'object',
        properties: {
          format: { type: 'string' },
          pattern: { type: 'string' },
          $ref: { type: 'string' },
        },
        required: ['format'],
        additionalProperties: false,
      },
    });
    const created = await env.api('/v2/requests', input);
    assert.equal(created.status, 201);
    const human = await env.login();
    assert.equal(
      (
        await human.call(`/v2/requests/${created.body.request.id}/candidates`, {
          decision: 'answer',
          response: { format: 'literal', pattern: 'not executable' },
        })
      ).status,
      201,
    );
  } finally {
    await env.close();
  }
});

test('directory aliases of the same OIDC identity cannot satisfy separation of duties', async () => {
  const env = await environment();
  try {
    const reviewer = await env.login();
    await env.principal('requester-alias', 'human', {
      enabled: true,
      identity_certain: true,
      oidc_issuer: env.service.config.oidc.issuer,
      oidc_subject: 'reviewer',
    });
    await env.principal(
      'producer',
      'producer',
      { enabled: true, publisher: 'publisher', owner: 'requester-alias', routes: ['review'] },
      env.credentials.producer,
    );
    const created = await env.api('/v2/requests', env.request(true));
    assert.equal(created.status, 201);
    const candidate = await reviewer.call(`/v2/requests/${created.body.request.id}/candidates`, {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 403);
    assert.equal(candidate.body.error, 'separation_of_duties');
    assert.equal((await env.api(`/v2/requests/${created.body.request.id}`)).body.receipt, null);
  } finally {
    await env.close();
  }
});
