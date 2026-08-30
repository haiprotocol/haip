import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { digest } from '@haip/protocol/crypto';
import { environment } from './environment.js';
import { TestSafetyStore } from './fixtures/safety.js';
import { RecoveryGuard, recoverTenant } from '../haip-server/src/recovery.js';

test('recovery retires a matching prefix with a lost unanchored tail, clears credentials/private copies and preserves permanent fences', async () => {
  const env = await environment();
  const directory = await mkdtemp(join(tmpdir(), 'haip-recovery-'));
  try {
    const safety = new TestSafetyStore(join(directory, 'independent'));
    env.service.recovery = new RecoveryGuard(env.service, safety);
    await env.worker.reconcile();
    const input = env.request(true),
      created = await env.api('/v2/requests', input),
      id = created.body.request.id;
    assert.equal(created.status, 201);
    const human = await env.login();
    const candidate = await human.call(`/v2/requests/${id}/candidates`, {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    await env.flush();
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    const database = env.store.pool.options.connectionString!;
    const snapshot = join(directory, 'before-consumption.dump');
    execFileSync(join(bin, 'pg_dump'), ['--dbname', database, '-Fc', '-f', snapshot], {
      stdio: 'pipe',
    });
    const claimInput = {
      execution_identity: 'permanent-instance',
      execution_binding_digest: digest(input.execution),
    };
    const claim = await env.api(`/v2/requests/${id}/claims`, claimInput);
    assert.equal(claim.status, 201);
    await env.api(`/v2/requests/${id}/discard`, {});
    // Deliberately do not publish the claim/deletion checkpoints: retained prefix still matches.
    execFileSync(
      join(bin, 'pg_restore'),
      ['--dbname', database, '--clean', '--if-exists', '--exit-on-error', snapshot],
      { stdio: 'pipe' },
    );
    await env.worker.reconcile();
    assert.equal(
      (await env.api(`/v2/requests/${id}/claims`, claimInput)).body.error,
      'admission_fenced',
    );
    const newToken = randomBytes(32).toString('base64url');
    const recovered = await recoverTenant(
      env.service,
      env.anchor,
      env.service.recovery!,
      'test-tenant',
      'recovery-operator',
      newToken,
    );
    assert.equal(recovered.history_state, 'matching_retained_prefix');
    assert.notEqual(recovered.generation, created.body.request.authority_namespace);
    assert.equal((await env.api(`/v2/requests/${id}`)).status, 401);
    assert.equal((await human.call(`/v2/requests/${id}`)).status, 401);
    const restored = (
      await env.store.pool.query(
        'SELECT data,material FROM haip_requests WHERE tenant=$1 AND id=$2',
        ['test-tenant', id],
      )
    ).rows[0];
    assert.equal(restored.material, null);
    assert.equal(restored.data.candidate, undefined);
    assert.equal(restored.data.execution_state, 'uncertain');
    assert.equal(restored.data.invalidated, 'namespace_retired');
    assert.equal(
      (
        await env.store.pool.query(
          'SELECT count(*) FROM haip_idempotency WHERE tenant=$1 AND result IS NOT NULL',
          ['test-tenant'],
        )
      ).rows[0].count,
      '0',
    );
    await env.worker.reconcile();
    await assert.rejects(
      env.service.recovery!.assertActive('test-tenant', created.body.request.authority_namespace),
      /namespace_retired/,
    );
    await assert.rejects(
      env.service.recovery!.reserve(
        'test-tenant',
        'producer',
        input.execution!.action_occurrence_id,
        recovered.generation,
      ),
      /recovery_fence_conflict/,
    );
    await assert.rejects(
      env.service.recovery!.assertUnconsumed(
        'test-tenant',
        'producer',
        input.execution!.action_occurrence_id,
      ),
      /occurrence_consumed/,
    );
    assert.equal(
      (await env.store.pool.query('SELECT fenced FROM haip_tenants WHERE id=$1', ['test-tenant']))
        .rows[0].fenced,
      false,
    );
    // Re-provision through public operator endpoints; old request authority stays revoked.
    await env.principal(
      'publisher',
      'publisher',
      { enabled: true },
      env.credentials.publisher,
      newToken,
    );
    await env.principal(
      'requester',
      'human',
      {
        enabled: true,
        identity_certain: true,
        oidc_issuer: env.service.config.oidc.issuer,
        oidc_subject: 'requester',
      },
      undefined,
      newToken,
    );
    await env.principal(
      'reviewer',
      'human',
      {
        enabled: true,
        identity_certain: true,
        oidc_issuer: env.service.config.oidc.issuer,
        oidc_subject: 'reviewer',
      },
      undefined,
      newToken,
    );
    await env.principal(
      'producer',
      'producer',
      { enabled: true, publisher: 'publisher', owner: 'requester', routes: ['review'] },
      env.credentials.producer,
      newToken,
    );
    await env.put('/v2/admin/routes/review', env.route, newToken);
    assert.equal(
      (await env.api(`/v2/requests/${id}/claims`, claimInput)).body.error,
      'namespace_retired',
    );
    assert.equal((await env.api('/v2/requests', input)).status, 409);
    const fresh = await env.api('/v2/requests', env.request(true));
    assert.equal(fresh.status, 201);
    const reviewer = await env.login();
    const c = await reviewer.call(`/v2/requests/${fresh.body.request.id}/candidates`, {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
    await reviewer.call(`/v2/requests/${fresh.body.request.id}/confirm`, {
      candidate_id: c.body.id,
      candidate_digest: digest(c.body),
    });
    await env.flush();
    const f = fresh.body.request;
    assert.equal(
      (
        await env.api(`/v2/requests/${f.id}/claims`, {
          execution_identity: 'fresh-instance',
          execution_binding_digest: digest(f.execution),
        })
      ).status,
      201,
    );
    safety.unavailable = true;
    assert.equal(
      (
        await env.api(`/v2/requests/${f.id}/claims`, {
          execution_identity: 'fresh-instance',
          execution_binding_digest: digest(f.execution),
        })
      ).status,
      503,
    );
  } finally {
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration checksums reject altered or newer schema history without renewing existing objects', async () => {
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request());
    const original = digest(created.body.request);
    await Promise.all([env.store.migrate(), env.store.migrate()]);
    assert.equal(
      digest((await env.api(`/v2/requests/${created.body.request.id}`)).body.request),
      original,
    );
    await env.store.pool.query(
      "INSERT INTO haip_migrations(name,sha256) VALUES('999_future.sql','unrecognised')",
    );
    await assert.rejects(env.store.migrate(), /schema_downgrade_refused/);
    await env.store.pool.query("DELETE FROM haip_migrations WHERE name='999_future.sql'");
    await env.store.pool.query(
      "UPDATE haip_migrations SET sha256='tampered' WHERE name='001_review.sql'",
    );
    await assert.rejects(env.store.migrate(), /migration_checksum_changed/);
  } finally {
    await env.close();
  }
});

test('upgrading from request-derived quotas blocks new creation for the UTC day but preserves confirmation', async () => {
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request()),
      id = created.body.request.id;
    // Reproduce the preceding draft schema, where already deleted rows are unknowable.
    await env.store.pool.query('DROP TABLE haip_creation_windows');
    await env.store.pool.query("DELETE FROM haip_migrations WHERE name='003_creation_windows.sql'");
    await env.store.migrate();
    assert.equal((await env.api('/v2/requests', env.request())).body.error, 'daily_quota');
    const human = await env.login(),
      candidate = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'answer',
        response: { choice: 'accept' },
      });
    assert.equal(candidate.status, 201);
    assert.equal(
      (
        await human.call(`/v2/requests/${id}/confirm`, {
          candidate_id: candidate.body.id,
          candidate_digest: digest(candidate.body),
        })
      ).status,
      200,
    );
    // A later UTC day starts a new window; advancing the fixture's stored date
    // does not change any captured request deadline or signed object.
    await env.store.pool.query('UPDATE haip_creation_windows SET day=day-1');
    assert.equal((await env.api('/v2/requests', env.request())).status, 201);
  } finally {
    await env.close();
  }
});

test('lost independent consumption acknowledgement cannot substitute identity or reopen an occurrence', async () => {
  const env = await environment(),
    directory = await mkdtemp(join(tmpdir(), 'haip-claim-crash-'));
  try {
    const safety = new TestSafetyStore(directory);
    env.service.recovery = new RecoveryGuard(env.service, safety);
    await env.worker.reconcile();
    const input = env.request(true),
      created = await env.api('/v2/requests', input),
      id = created.body.request.id;
    const human = await env.login();
    const c = await human.call(`/v2/requests/${id}/candidates`, {
      decision: 'authorise',
      response: { choice: 'accept' },
    });
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: c.body.id,
      candidate_digest: digest(c.body),
    });
    await env.flush();
    const write = safety.create.bind(safety);
    let writes = 0;
    safety.create = async (key, record) => {
      const accepted = await write(key, record);
      if (++writes === 2) throw new Error('lost_after_independent_commit');
      return accepted;
    };
    const claimInput = {
      execution_identity: 'original-execution',
      execution_binding_digest: digest(input.execution),
    };
    assert.equal((await env.api(`/v2/requests/${id}/claims`, claimInput)).status, 503);
    assert.equal((await env.api(`/v2/requests/${id}`)).body.execution_state, 'unclaimed');
    assert.equal(
      (
        await env.api(`/v2/requests/${id}/claims`, {
          ...claimInput,
          execution_identity: 'replacement',
        })
      ).status,
      409,
    );
    assert.equal((await env.api(`/v2/requests/${id}/supersede`, input)).status, 409);
    const original = await env.api(`/v2/requests/${id}/claims`, claimInput);
    assert.equal(original.status, 201);
    assert.equal(original.body.payload.execution_identity, 'original-execution');
    // A second process cannot acquire the same generation even against the current database.
    await env.worker.reconcile();
    assert.equal(
      (
        await env.api(`/v2/requests/${id}/admission`, {
          claim_id: original.body.payload.id,
          execution_identity: claimInput.execution_identity,
          nonce: 'fresh_nonce_after_restart',
        })
      ).body.error,
      'admission_fenced',
    );
  } finally {
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});
