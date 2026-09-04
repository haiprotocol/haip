import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { createBackup } from '../haip-server/src/backup.js';
import { principalRateKey, requestRateLimit } from '../haip-server/src/rate-limit.js';

test('database backup keeps credentials out of child arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haip-backup-security-'));
  const originalDatabase = process.env.HAIP_DATABASE_URL;
  const originalPgDatabase = process.env.PGDATABASE;
  const originalPassword = process.env.PGPASSWORD;
  const originalService = process.env.PGSERVICE;
  const originalServiceFile = process.env.PGSERVICEFILE;
  const originalSysconfDir = process.env.PGSYSCONFDIR;
  const originalSslPassword = process.env.PGSSLPASSWORD;
  const originalRecord = process.env.HAIP_BACKUP_SECURITY_RECORD;
  const originalExpected = process.env.HAIP_BACKUP_SECURITY_PASSFILE_HASH;
  const recordPath = join(directory, 'record.json');
  const secret = 'fixture-secret:%25:with\\slash';
  const sslSecret = 'fixture-ssl-secret';
  const escaped = secret.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  const expectedPassfileHash = createHash('sha256')
    .update(`database.example:5432:haip:backup-user:${escaped}\n`)
    .digest('hex');
  const database = new URL('postgresql://backup-user@database.example/haip');
  database.searchParams.set('password', secret);
  database.searchParams.set('sslmode', 'verify-full');
  database.searchParams.set('sslpassword', sslSecret);
  database.searchParams.set('application_name', 'haip-backup-test');
  const fixture = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const passfile = process.env.PGPASSFILE;
const passfileBody = readFileSync(passfile);
const databaseArgument = args[args.indexOf('--dbname') + 1];
writeFileSync(process.env.HAIP_BACKUP_SECURITY_RECORD, JSON.stringify({
  arguments: args,
  databaseArgument,
  credentialInArguments: args.some((value) => value.includes('fixture-secret') || value.includes('fixture-ssl-secret')),
  sslPasswordMatches: process.env.PGSSLPASSWORD === 'fixture-ssl-secret',
  passfile,
  passfileMode: statSync(passfile).mode & 0o777,
  passfileMatches: createHash('sha256').update(passfileBody).digest('hex') === process.env.HAIP_BACKUP_SECURITY_PASSFILE_HASH,
  inheritedDatabaseUrl: Object.hasOwn(process.env, 'HAIP_DATABASE_URL'),
  inheritedPgDatabase: Object.hasOwn(process.env, 'PGDATABASE'),
  inheritedPassword: Object.hasOwn(process.env, 'PGPASSWORD'),
  inheritedService: Object.hasOwn(process.env, 'PGSERVICE'),
  inheritedServiceFile: Object.hasOwn(process.env, 'PGSERVICEFILE'),
  inheritedSysconfDir: Object.hasOwn(process.env, 'PGSYSCONFDIR')
}));
process.stdout.write('fixture dump');
`;
  try {
    await writeFile(join(directory, 'pg_dump'), fixture, { mode: 0o700 });
    for (const parameter of ['passfile', 'service', 'servicefile']) {
      const rejected = new URL(database);
      rejected.searchParams.set(parameter, 'external-credential-source');
      await assert.rejects(
        createBackup(
          rejected.href,
          join(directory, `rejected-${parameter}.haipbak`),
          randomBytes(32),
          directory,
        ),
        /backup_database_credential_source_forbidden/,
      );
    }
    process.env.HAIP_DATABASE_URL = 'postgresql://inherited:fixture-secret@elsewhere/other';
    process.env.PGDATABASE = 'postgresql://inherited:fixture-secret@elsewhere/other';
    process.env.PGPASSWORD = 'fixture-secret';
    process.env.PGSERVICE = 'inherited-service';
    process.env.PGSERVICEFILE = '/private/inherited-service.conf';
    process.env.PGSYSCONFDIR = '/private/inherited-sysconf';
    process.env.PGSSLPASSWORD = 'fixture-secret';
    process.env.HAIP_BACKUP_SECURITY_RECORD = recordPath;
    process.env.HAIP_BACKUP_SECURITY_PASSFILE_HASH = expectedPassfileHash;
    await createBackup(
      database.href,
      join(directory, 'snapshot.haipbak'),
      randomBytes(32),
      directory,
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    const launched = new URL(record.databaseArgument);
    assert.equal(launched.password, '');
    assert.equal(launched.searchParams.has('password'), false);
    assert.equal(launched.searchParams.get('sslmode'), 'verify-full');
    assert.equal(launched.searchParams.has('sslpassword'), false);
    assert.equal(launched.searchParams.get('application_name'), 'haip-backup-test');
    assert.equal(record.credentialInArguments, false);
    assert.equal(record.arguments.includes('--dbname'), true);
    assert.equal(record.sslPasswordMatches, true);
    assert.equal(record.passfileMode, 0o600);
    assert.equal(record.passfileMatches, true);
    assert.equal(record.inheritedDatabaseUrl, false);
    assert.equal(record.inheritedPgDatabase, false);
    assert.equal(record.inheritedPassword, false);
    assert.equal(record.inheritedService, false);
    assert.equal(record.inheritedServiceFile, false);
    assert.equal(record.inheritedSysconfDir, false);
    await assert.rejects(access(record.passfile), { code: 'ENOENT' });
    await assert.rejects(access(dirname(record.passfile)), { code: 'ENOENT' });
  } finally {
    if (originalDatabase === undefined) delete process.env.HAIP_DATABASE_URL;
    else process.env.HAIP_DATABASE_URL = originalDatabase;
    if (originalPgDatabase === undefined) delete process.env.PGDATABASE;
    else process.env.PGDATABASE = originalPgDatabase;
    if (originalPassword === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = originalPassword;
    if (originalService === undefined) delete process.env.PGSERVICE;
    else process.env.PGSERVICE = originalService;
    if (originalServiceFile === undefined) delete process.env.PGSERVICEFILE;
    else process.env.PGSERVICEFILE = originalServiceFile;
    if (originalSysconfDir === undefined) delete process.env.PGSYSCONFDIR;
    else process.env.PGSYSCONFDIR = originalSysconfDir;
    if (originalSslPassword === undefined) delete process.env.PGSSLPASSWORD;
    else process.env.PGSSLPASSWORD = originalSslPassword;
    if (originalRecord === undefined) delete process.env.HAIP_BACKUP_SECURITY_RECORD;
    else process.env.HAIP_BACKUP_SECURITY_RECORD = originalRecord;
    if (originalExpected === undefined) delete process.env.HAIP_BACKUP_SECURITY_PASSFILE_HASH;
    else process.env.HAIP_BACKUP_SECURITY_PASSFILE_HASH = originalExpected;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a repeated limiter mount counts each request once and rejects excess traffic', async () => {
  const app = express();
  let accepted = 0;
  const admission = requestRateLimit({ limit: 1, identifier: 'test-service' });
  app.use('/limited', admission);
  app.get('/limited', admission, (_req, res) => {
    accepted++;
    res.json({ accepted });
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(origin + '/limited')).status, 200);
    const rejected = await fetch(origin + '/limited');
    assert.equal(rejected.status, 429);
    assert.match(rejected.headers.get('retry-after')!, /^\d+$/);
    assert.deepEqual(await rejected.json(), { error: 'rate_limited' });
    assert.equal(accepted, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('principal limiter keys preserve tenant and identity boundaries', () => {
  const request = { principal: { tenant: 'tenant:one', id: 'principal' } } as any;
  const other = { principal: { tenant: 'tenant', id: 'one:principal' } } as any;
  assert.notEqual(principalRateKey(request), principalRateKey(other));
  assert.equal(principalRateKey(request), '["tenant:one","principal"]');
});
