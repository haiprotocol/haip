import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@haip/protocol/crypto';
import { environment } from './environment.js';

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
