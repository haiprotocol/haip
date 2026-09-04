import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';

const magic = Buffer.from('HAIPBAK1');
const headerLength = 28; // version magic, UTC creation milliseconds, unique 96-bit GCM IV
const retention = 30 * 86400000;
function decodeCredential(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    return checkCredential(decoded);
  } catch {
    throw new Error('backup_database_credential_invalid');
  }
}
function checkCredential(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('backup_database_credential_invalid');
  return value;
}
function passfilePassword(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}
function oneParameter(connection: URL, name: string): string | undefined {
  const values = connection.searchParams.getAll(name);
  if (values.length > 1) throw new Error('backup_database_parameter_ambiguous');
  return values[0];
}
function passfileField(value: string): string {
  return passfilePassword(checkCredential(value));
}
async function child(command: string, args: string[], database: string) {
  let connection: URL;
  try {
    connection = new URL(database);
  } catch {
    throw new Error('backup_database_url_invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(connection.protocol))
    throw new Error('backup_database_url_invalid');
  const queryPassword = oneParameter(connection, 'password');
  const querySslPassword = oneParameter(connection, 'sslpassword');
  for (const name of ['passfile', 'service', 'servicefile'])
    if (oneParameter(connection, name) !== undefined)
      throw new Error('backup_database_credential_source_forbidden');
  if (connection.password && queryPassword !== undefined)
    throw new Error('backup_database_credential_ambiguous');
  const password =
    queryPassword !== undefined
      ? checkCredential(queryPassword)
      : connection.password
        ? decodeCredential(connection.password)
        : '';
  const sslPassword =
    querySslPassword === undefined ? undefined : checkCredential(querySslPassword);
  const queryHost = oneParameter(connection, 'host');
  const queryHostAddress = oneParameter(connection, 'hostaddr');
  const queryPort = oneParameter(connection, 'port');
  const queryDatabase = oneParameter(connection, 'dbname');
  const queryUser = oneParameter(connection, 'user');
  const authorityHost = connection.hostname.replace(/^\[|\]$/g, '');
  const hostValue = queryHost ?? (authorityHost || queryHostAddress);
  const host = hostValue?.startsWith('/') ? 'localhost' : hostValue;
  const port = queryPort ?? (connection.port || '5432');
  const name = queryDatabase ?? decodeCredential(connection.pathname.replace(/^\//, ''));
  const user = queryUser ?? decodeCredential(connection.username);
  if (!host || !/^\d{1,5}$/.test(port) || Number(port) > 65535 || !name || !user)
    throw new Error('backup_database_identity_incomplete');
  connection.password = '';
  connection.searchParams.delete('password');
  connection.searchParams.delete('sslpassword');
  const directory = await mkdtemp(join(tmpdir(), 'haip-pgpass-'));
  const passfile = join(directory, 'pgpass');
  try {
    await writeFile(
      passfile,
      `${passfileField(host)}:${passfileField(port)}:${passfileField(name)}:${passfileField(user)}:${passfilePassword(password)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const {
      HAIP_DATABASE_URL: _database,
      PGDATABASE: _pgdatabase,
      PGPASSWORD: _password,
      PGPASSFILE: _passfile,
      PGSERVICE: _service,
      PGSERVICEFILE: _servicefile,
      PGSYSCONFDIR: _sysconfdir,
      PGSSLPASSWORD: _sslpassword,
      ...environment
    } = globalThis.process.env;
    const process = spawn(command, ['--dbname', connection.href, ...args], {
      env: {
        ...environment,
        PGPASSFILE: passfile,
        ...(sslPassword === undefined ? {} : { PGSSLPASSWORD: sslPassword }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Do not emit database URLs or private dump bytes in diagnostics.
    process.stderr.resume();
    const done = new Promise<void>((resolve, reject) => {
      process.once('error', reject);
      process.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('backup_database_command_failed')),
      );
    }).finally(() => rm(directory, { recursive: true, force: true }));
    return { process, done };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
function keyCheck(key: Uint8Array) {
  if (key.byteLength !== 32) throw new Error('backup_key_must_be_32_bytes');
}
export async function createBackup(database: string, file: string, key: Uint8Array, bin = '') {
  keyCheck(key);
  const header = Buffer.alloc(headerLength);
  magic.copy(header);
  header.writeBigUInt64BE(BigInt(Date.now()), 8);
  randomBytes(12).copy(header, 16);
  const fd = await open(file, 'wx', 0o600);
  try {
    await fd.write(header);
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(16));
    cipher.setAAD(header);
    const dump = await child(
      join(bin, 'pg_dump'),
      ['--format=custom', '--no-owner', '--no-acl'],
      database,
    );
    try {
      await Promise.all([
        dump.done,
        pipeline(
          dump.process.stdout,
          cipher,
          createWriteStream(file, { fd: fd.fd, autoClose: false, start: headerLength }),
        ),
      ]);
    } finally {
      if (dump.process.exitCode === null) dump.process.kill('SIGTERM');
      await dump.done.catch(() => {});
    }
    await fd.write(cipher.getAuthTag(), 0, 16, (await fd.stat()).size);
    await fd.sync();
    const directory = await open(dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  } finally {
    await fd.close();
  }
  return {
    file,
    encrypted: 'AES-256-GCM',
    expires_at: new Date(Number(header.readBigUInt64BE(8)) + retention).toISOString(),
  };
}

/** Target must be an empty, isolated database. Authenticate the whole file before pg_restore. */
export async function restoreBackup(database: string, file: string, key: Uint8Array, bin = '') {
  keyCheck(key);
  const directory = await mkdtemp(join(tmpdir(), 'haip-restore-'));
  const dumpPath = join(directory, 'authenticated.dump');
  const source = await open(file, 'r');
  try {
    const size = (await source.stat()).size;
    if (size <= headerLength + 16) throw new Error('backup_invalid');
    const header = Buffer.alloc(headerLength),
      tag = Buffer.alloc(16);
    await source.read(header, 0, header.length, 0);
    await source.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 8).equals(magic)) throw new Error('backup_invalid');
    const created = Number(header.readBigUInt64BE(8));
    if (created > Date.now() + 30000 || Date.now() >= created + retention)
      throw new Error('backup_expired');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(16));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(file, {
        fd: source.fd,
        autoClose: false,
        start: headerLength,
        end: size - 17,
      }),
      decipher,
      createWriteStream(dumpPath, { flags: 'wx', mode: 0o600 }),
    );
    const target = new pg.Client({ connectionString: database });
    await target.connect();
    try {
      const tables = await target.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') LIMIT 1",
      );
      if (tables.rowCount) throw new Error('restore_requires_empty_database');
    } finally {
      await target.end();
    }
    const restore = await child(
      join(bin, 'pg_restore'),
      ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', dumpPath],
      database,
    );
    restore.process.stdout.resume();
    await restore.done;
    const restored = new pg.Client({ connectionString: database });
    await restored.connect();
    try {
      await restored.query('UPDATE haip_tenants SET fenced=true');
    } finally {
      await restored.end();
    }
    return { restored: true, admission: 'fenced', recovery_required: true };
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Only recognised encrypted backup files in the explicitly selected directory are removed. */
export async function pruneBackups(directory: string) {
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.haipbak')) continue;
    const path = join(directory, entry.name),
      fd = await open(path, 'r');
    try {
      const header = Buffer.alloc(headerLength);
      await fd.read(header, 0, headerLength, 0);
      if (
        header.subarray(0, 8).equals(magic) &&
        Date.now() >= Number(header.readBigUInt64BE(8)) + retention
      ) {
        await rm(path);
        removed++;
      }
    } finally {
      await fd.close();
    }
  }
  return { removed };
}
