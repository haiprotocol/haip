import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { environment } from './environment.js';
import { digest } from '@haip/protocol/crypto';

test('an isolated PostgreSQL backup missing independently anchored history cannot admit execution', async () => {
  const env = await environment(),
    directory = await mkdtemp(join(tmpdir(), 'haip-backup-'));
  try {
    const input = env.request(true),
      created = await env.api('/v2/requests', input),
      id = created.body.request.id;
    await env.flush();
    const bin =
      process.env.HAIP_TEST_PG_BIN ??
      execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    const database = env.store.pool.options.connectionString!;
    execFileSync(
      join(bin, 'pg_dump'),
      ['--dbname', database, '--format=custom', '--file', join(directory, 'before-decision.dump')],
      { stdio: 'pipe' },
    );
    const human = await env.login(),
      candidate = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'authorise',
        response: { choice: 'accept' },
      });
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    await env.flush();
    const claimInput = {
      execution_identity: 'restore-test',
      execution_binding_digest: digest(input.execution),
    };
    assert.equal((await env.api(`/v2/requests/${id}/claims`, claimInput)).status, 201);
    await env.flush();
    // Only this throwaway database is restored; the independent fixture directory stays newer.
    execFileSync(
      join(bin, 'pg_restore'),
      [
        '--dbname',
        database,
        '--clean',
        '--if-exists',
        '--exit-on-error',
        join(directory, 'before-decision.dump'),
      ],
      { stdio: 'pipe' },
    );
    await env.worker.reconcile();
    assert.equal(
      (await env.api(`/v2/requests/${id}/claims`, claimInput)).body.error,
      'admission_fenced',
    );
  } finally {
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('production cannot admit using a development fixture without independent recovery storage', async () => {
  const env = await environment();
  try {
    const input = env.request(true),
      created = await env.api('/v2/requests', input),
      id = created.body.request.id;
    const human = await env.login(),
      candidate = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'authorise',
        response: { choice: 'accept' },
      });
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    await env.flush();
    env.service.config.mode = 'production';
    assert.equal(
      (
        await env.api(`/v2/requests/${id}/claims`, {
          execution_identity: 'production-refused',
          execution_binding_digest: digest(input.execution),
        })
      ).body.error,
      'independent_recovery_required',
    );
  } finally {
    await env.close();
  }
});
