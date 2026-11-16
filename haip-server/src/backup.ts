import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('HAIPBAK1');
const headerLength = 28; // version magic, UTC creation milliseconds, unique 96-bit GCM IV
const retention = 30 * 86400000;
const occupiedDatabase = 'HAP01';
const requireEmptyDatabase = `
DO $restore$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '${occupiedDatabase}';
  END IF;
END
$restore$;`;
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

function launch(command: string, args: string[], env: NodeJS.ProcessEnv, restore = false) {
  const process = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  // Keep database URLs and private dump content out of reports.
  process.stderr.on('data', (chunk: Buffer) => {
    if (restore && diagnostic.length < 4096)
      diagnostic += chunk.toString('utf8', 0, 4096 - diagnostic.length);
  });
  const done = new Promise<void>((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) resolve();
      else if (restore && diagnostic.trimEnd().endsWith(occupiedDatabase))
        reject(new Error('restore_requires_empty_database'));
      else reject(new Error('backup_database_command_failed'));
    });
  });
  return { process, done };
}

async function child(command: string, args: string[], database: string, restore = false) {
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
    const started = launch(
      command,
      ['--no-password', '--dbname', connection.href, ...args],
      {
        ...environment,
        PGPASSFILE: passfile,
        ...(sslPassword === undefined ? {} : { PGSSLPASSWORD: sslPassword }),
      },
      restore,
    );
    return {
      process: started.process,
      done: started.done.finally(() => rm(directory, { recursive: true, force: true })),
    };
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
  const source = await open(file, 'r');
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'haip-restore-'));
    const dumpPath = join(directory, 'authenticated.dump');
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
    const sqlPath = join(directory, 'restore.sql');
    await writeFile(sqlPath, '', { flag: 'wx', mode: 0o600 });
    const script = launch(
      join(bin, 'pg_restore'),
      ['--no-owner', '--no-acl', '--file', sqlPath, dumpPath],
      { PATH: process.env.PATH },
    );
    script.process.stdout.resume();
    await script.done;
    await rm(dumpPath);
    const restore = await child(
      join(bin, 'psql'),
      [
        '--no-psqlrc',
        '--single-transaction',
        '--set=ON_ERROR_STOP=1',
        '--set=VERBOSITY=sqlstate',
        '--command=SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
        "--command=SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('haip.schema',0))",
        '--command',
        requireEmptyDatabase,
        "--command=SELECT pg_catalog.set_config('haip.restore_search_path', pg_catalog.current_setting('search_path'), true)",
        '--file',
        sqlPath,
        "--command=SELECT pg_catalog.set_config('search_path', pg_catalog.current_setting('haip.restore_search_path'), true); UPDATE haip_tenants SET fenced=true",
      ],
      database,
      true,
    );
    restore.process.stdout.resume();
    await restore.done;
    return { restored: true, admission: 'fenced', recovery_required: true };
  } finally {
    await source.close();
    if (directory) await rm(directory, { recursive: true, force: true });
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
