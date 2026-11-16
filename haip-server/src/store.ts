import pg, { type PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export type Tx = PoolClient;
export type DispatchOutbox = (ids: readonly string[], signal: AbortSignal) => Promise<void>;

const directory = new URL('../migrations/', import.meta.url);
async function migrations() {
  const files = (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('schema_migrations_unavailable');
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(new URL(name, directory), 'utf8');
      return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function checkedMigrations(
  tx: Pick<Tx, 'query'>,
  files: Awaited<ReturnType<typeof migrations>>,
) {
  const { rows } = await tx.query<{ name: string; sha256: string }>(
    'SELECT name,sha256 FROM haip_migrations ORDER BY name',
  );
  const expected = new Map(files.map(({ name, sha256 }) => [name, sha256]));
  if (rows.some(({ name }) => !expected.has(name))) throw new Error('schema_downgrade_refused');
  for (const row of rows) {
    if (expected.get(row.name) !== row.sha256) throw new Error('migration_checksum_changed');
  }
  const applied = new Set(rows.map(({ name }) => name));
  return files.filter(({ name }) => !applied.has(name));
}

export class Store {
  readonly pool: pg.Pool;
  private readonly outbox = new WeakMap<Tx, Set<string>>();
  constructor(
    url: string,
    options: pg.PoolConfig = {},
    private readonly dispatchOutbox?: DispatchOutbox,
  ) {
    this.pool = new pg.Pool({ max: 12, ...options, connectionString: url });
    this.pool.on('error', () => console.error('HAIP idle database connection lost'));
  }
  noteOutboxJob(tx: Tx, id: string) {
    if (!this.dispatchOutbox) return;
    const pending = this.outbox.get(tx);
    if (!pending) throw new Error('outbox_transaction_required');
    if (pending.size < 64) pending.add(id);
  }

  private async dispatchCommitted(ids: Set<string>) {
    if (!this.dispatchOutbox || !ids.size) return;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('outbox_dispatch_timeout'));
      }, 2000);
    });
    try {
      await Promise.race([this.dispatchOutbox([...ids], controller.signal), deadline]);
    } catch {
      console.error('HAIP outbox dispatch failed. Reconciliation will inspect persisted work.');
    } finally {
      clearTimeout(timer);
    }
  }
  async requireSchema(): Promise<void> {
    const pending = await checkedMigrations(this.pool, await migrations()).catch((error) => {
      if (error.code === '42P01') throw new Error('schema_migration_required');
      throw error;
    });
    if (pending.length) throw new Error('schema_migration_required');
  }
  async migrate(): Promise<void> {
    const files = await migrations();
    await this.inTransaction('BEGIN', async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('haip.schema',0))");
      await tx.query(
        'CREATE TABLE IF NOT EXISTS haip_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
      );
      for (const { name, sql, sha256 } of await checkedMigrations(tx, files)) {
        await tx.query(sql);
        await tx.query('INSERT INTO haip_migrations(name,sha256) VALUES($1,$2)', [name, sha256]);
      }
    });
  }
  private async inTransaction<T>(begin: string, run: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    let discard = false;
    try {
      await tx.query(begin);
      const result = await run(tx);
      const commit = await tx.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new Error('database_commit_refused');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      tx.release(discard);
    }
  }
  async write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.inTransaction('BEGIN', async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '10s'");
      await tx.query("SET LOCAL statement_timeout = '30s'");
      return fn(tx);
    });
  }
  async transaction<T>(tenant: string, fn: (tx: Tx, now: Date) => Promise<T>): Promise<T> {
    const ids = new Set<string>();
    const result = await this.write(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);
      const { rows } = await tx.query('SELECT clock_timestamp() AS now');
      if (this.dispatchOutbox) this.outbox.set(tx, ids);
      try {
        return await fn(tx, rows[0].now);
      } finally {
        this.outbox.delete(tx);
      }
    });
    await this.dispatchCommitted(ids);
    return result;
  }
  /** Admission preflights and paginated reads never wait for the tenant's write lock. */
  async read<T>(fn: (tx: Tx, now: Date) => Promise<T>): Promise<T> {
    return this.inTransaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '5s'");
      const { rows } = await tx.query('SELECT clock_timestamp() AS now');
      return fn(tx, rows[0].now);
    });
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
