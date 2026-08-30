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
    const bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    await createBackup(database, file, key, bin);
    assert.equal((await readFile(file)).includes(Buffer.from('A stored support message')), false);
    await assert.rejects(
      restoreBackup(database, file, key, bin),
      /restore_requires_empty_database/,
    );
    await env.store.pool.query('CREATE DATABASE backup_target');
    const target = new URL(database);
    target.pathname = '/backup_target';
    await assert.rejects(restoreBackup(target.href, file, randomBytes(32), bin));
    const tampered = Buffer.from(await readFile(file));
    tampered[40] ^= 1;
    const invalid = join(directory, 'tampered.haipbak');
    await writeFile(invalid, tampered);
    await assert.rejects(restoreBackup(target.href, invalid, key, bin));
    assert.equal((await restoreBackup(target.href, file, key, bin)).admission, 'fenced');
    const restored = new Store(target.href);
    try {
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
