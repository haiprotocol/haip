import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackup, restoreBackup } from '../haip-server/src/backup.js';
import { Store } from '../haip-server/src/store.js';
import { postgres } from './fixtures/postgres.js';

test('dedicated database grants separate runtime writes from migrations, activation and encrypted backups', async () => {
  const pg = await postgres();
  const directory = await mkdtemp(join(tmpdir(), 'haip-neon-role-fixture-'));
  const stores = new Set<Store>();
  const urlFor = (database: string, role?: string) => {
    const url = new URL(pg.url);
    url.pathname = '/' + database;
    if (role) url.username = role;
    return url.href;
  };
  const connect = (url: string) => {
    const store = new Store(url);
    stores.add(store);
    return store;
  };
  const control = connect(pg.url);
  try {
    await control.pool.query('CREATE DATABASE haip_roles');
    await control.pool.query('CREATE DATABASE haip_role_restore');
    await control.pool.query('CREATE ROLE haip_runtime LOGIN; CREATE ROLE haip_backup LOGIN');
    const source = connect(urlFor('haip_roles'));
    const runtime = connect(urlFor('haip_roles', 'haip_runtime'));
    const backupUrl = urlFor('haip_roles', 'haip_backup');
    const reader = connect(backupUrl);
    const applyRoles = await readFile(
      new URL('../deployment/neon/roles.sql', import.meta.url),
      'utf8',
    );
    await source.migrate();
    await source.pool.query(applyRoles);
    await source.pool.query(
      'INSERT INTO haip_tenants (id,ledger_id,generation) VALUES ($1,$2,$3)',
      ['roles-test', randomUUID(), randomUUID()],
    );
    await runtime.requireSchema();
    await runtime.transaction('roles-test', async (tx) => {
      await tx.query("UPDATE haip_tenants SET config='{}',fenced=false WHERE id='roles-test'");
      await tx.query("INSERT INTO haip_incidents (tenant,code) VALUES ('roles-test','test')");
    });
    for (const statement of [
      'CREATE TABLE public.denied (id text)',
      'UPDATE haip_migrations SET sha256=sha256',
      'INSERT INTO haip_managed_head VALUES (true,$$fixture$$,0,gen_random_uuid())',
      'UPDATE haip_managed_head SET binding=binding',
      'UPDATE haip_tenants SET generation=generation',
    ])
      await assert.rejects(runtime.pool.query(statement), /permission denied/);
    await assert.rejects(
      reader.pool.query('UPDATE haip_tenants SET fenced=true'),
      /permission denied/,
    );

    const file = join(directory, 'sealed.haipbak');
    const key = randomBytes(32);
    const bin =
      process.env.HAIP_TEST_PG_BIN ??
      execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    await createBackup(backupUrl, file, key, bin);
    const targetUrl = urlFor('haip_role_restore');
    await restoreBackup(targetUrl, file, key, bin);
    const target = connect(targetUrl);
    const { rows } = await target.pool.query('SELECT id,fenced FROM haip_tenants');
    assert.deepEqual(rows, [{ id: 'roles-test', fenced: true }]);
  } finally {
    await Promise.all([...stores].map((store) => store.close()));
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  }
});
