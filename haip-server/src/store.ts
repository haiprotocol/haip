import pg, { type PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export type Tx = PoolClient;
export class Store {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 12 });
  }
  async migrate(): Promise<void> {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('haip.schema',0))");
      await tx.query(
        'CREATE TABLE IF NOT EXISTS haip_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
      );
      const directory = new URL('../migrations/', import.meta.url);
      const files = (await readdir(directory))
        .filter((name) => /^\d{3}_.+\.sql$/.test(name))
        .sort();
      const applied = (await tx.query('SELECT name,sha256 FROM haip_migrations ORDER BY name'))
        .rows;
      if (applied.some((r) => !files.includes(r.name))) throw new Error('schema_downgrade_refused');
      for (const name of files) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        const hash = createHash('sha256').update(sql).digest('hex');
        const previous = applied.find((r) => r.name === name);
        if (previous && previous.sha256 !== hash) throw new Error('migration_checksum_changed');
        if (previous) continue;
        await tx.query(sql);
        await tx.query('INSERT INTO haip_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
      }
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }
  async transaction<T>(tenant: string, fn: (tx: Tx, now: Date) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SET LOCAL lock_timeout = '10s'");
      await tx.query("SET LOCAL statement_timeout = '30s'");
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);
      const { rows } = await tx.query('SELECT clock_timestamp() AS now');
      const result = await fn(tx, rows[0].now);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
