import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { environment } from './environment.js';
import { createBackup, restoreBackup, pruneBackups } from '../haip-server/src/backup.js';
import { Store } from '../haip-server/src/store.js';
test('authenticated encrypted backups restore only to an empty database, fence admission and expire after 30 days', async () => {
  const env = await environment(),
    directory = await mkdtemp(join(tmpdir(), 'haip-encrypted-backup-'));
  try {
    const request = await env.api('/v2/requests', env.request());
    const file = join(directory, 'snapshot.haipbak'),
      key = randomBytes(32);
    const database = env.store.pool.options.connectionString!;
    const bin = postgresBin();
    await createBackup(database, file, key, bin);
    assert.equal((await readFile(file)).includes(Buffer.from('A stored support message')), false);
    await assert.rejects(
      restoreBackup(database, file, key, bin),
      /restore_requires_empty_database/,
    );
    await env.store.pool.query('CREATE DATABASE backup_target');
    await env.store.pool.query('CREATE DATABASE restore_path_only');
    const target = new URL(database);
    target.pathname = '/backup_target';
    await assert.rejects(restoreBackup(target.href, file, randomBytes(32), bin));
    const tampered = Buffer.from(await readFile(file));
    tampered[40] ^= 1;
    const invalid = join(directory, 'tampered.haipbak');
    await writeFile(invalid, tampered);
    await assert.rejects(restoreBackup(target.href, invalid, key, bin));
    const restored = new Store(target.href);
    try {
      await restored.pool.query('CREATE TABLE unrelated_data (value integer)');
      const selectedTarget = new URL(target.href);
      selectedTarget.pathname = '/restore_path_only';
      selectedTarget.searchParams.set('dbname', 'backup_target');
      await assert.rejects(
        restoreBackup(selectedTarget.href, file, key, bin),
        /restore_requires_empty_database/,
      );
      assert.equal(
        (await restored.pool.query("SELECT to_regclass('public.haip_tenants') AS relation")).rows[0]
          .relation,
        null,
      );
      await restored.pool.query('DROP TABLE unrelated_data');
      const attempts = await Promise.allSettled(
        Array.from({ length: 2 }, () => restoreBackup(selectedTarget.href, file, key, bin)),
      );
      const passed = attempts.filter((attempt) => attempt.status === 'fulfilled');
      const refused = attempts.filter((attempt) => attempt.status === 'rejected');
      assert.deepEqual(
        passed.map((attempt) => attempt.value.admission),
        ['fenced'],
      );
      assert.deepEqual(
        refused.map((attempt) => attempt.reason.message),
        ['restore_requires_empty_database'],
      );
      assert.equal(
        (await restored.pool.query('SELECT count(*) FROM haip_tenants WHERE fenced=false')).rows[0]
          .count,
        '0',
      );
      assert.equal(
        (
          await restored.pool.query('SELECT data FROM haip_requests WHERE id=$1', [
            request.body.request.id,
          ])
        ).rows[0].data.request.private_delete_at,
        request.body.request.private_delete_at,
      );
      await restored.migrate();
    } finally {
      await restored.close();
    }
    const old = Buffer.from(await readFile(file));
    old.writeBigUInt64BE(BigInt(Date.now() - 31 * 86400000), 8);
    await writeFile(join(directory, 'expired.haipbak'), old);
    assert.equal((await pruneBackups(directory)).removed, 1);
    assert.ok(await readFile(file));
  } finally {
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore rolls back the import if it cannot fence every tenant', async () => {
  const env = await environment(),
    directory = await mkdtemp(join(tmpdir(), 'haip-backup-fence-'));
  const database = env.store.pool.options.connectionString!;
  const target = new URL(database);
  target.pathname = '/backup_fence_target';
  const restored = new Store(target.href);
  try {
    await env.store.pool.query(`
      CREATE FUNCTION fixture_refuse_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fixture refused admission fence';
      END
      $$;
      CREATE TRIGGER fixture_refuse_fence BEFORE UPDATE OF fenced ON haip_tenants
        FOR EACH ROW EXECUTE FUNCTION fixture_refuse_fence();
    `);
    const file = join(directory, 'snapshot.haipbak');
    const key = randomBytes(32);
    const bin = postgresBin();
    await createBackup(database, file, key, bin);
    await env.store.pool.query('CREATE DATABASE backup_fence_target');
    await assert.rejects(restoreBackup(target.href, file, key, bin));
    assert.equal(
      (await restored.pool.query("SELECT to_regclass('public.haip_tenants') AS relation")).rows[0]
        .relation,
      null,
    );
  } finally {
    await restored.close();
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function postgresBin() {
  return (
    process.env.HAIP_TEST_PG_BIN ??
    execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
  );
}
