import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';

const magic = Buffer.from('HAIPBAK1');
const headerLength = 28; // version magic, UTC creation milliseconds, unique 96-bit GCM IV
const retention = 30 * 86400000;
function child(command: string, args: string[], database: string) {
  const process = spawn(command, args, {
    env: { ...globalThis.process.env, PGDATABASE: database },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Do not emit database URLs or private dump bytes in diagnostics.
  process.stderr.resume();
  const done = new Promise<void>((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('backup_database_command_failed')),
    );
  });
  return { process, done };
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
    const dump = child(
      join(bin, 'pg_dump'),
      ['--dbname', database, '--format=custom', '--no-owner', '--no-acl'],
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
    const restore = child(
      join(bin, 'pg_restore'),
      [
        '--dbname',
        database,
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        dumpPath,
      ],
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
