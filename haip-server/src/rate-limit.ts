import { rateLimit, type Store as RateLimitStore } from 'express-rate-limit';
import { digestBytes } from '@haip/protocol/crypto';
import type { Pool } from 'pg';
import type { Request, RequestHandler } from 'express';

export interface RateLimitOptions {
  limit: number;
  identifier: string;
  key?: (request: Request) => string;
}

export function principalRateKey(request: Request): string {
  return JSON.stringify([request.principal.tenant, request.principal.id]);
}

type CounterDatabase = Pick<Pool, 'query'>;

class PostgresCounter implements RateLimitStore {
  readonly prefix: string;

  constructor(
    private readonly database: CounterDatabase,
    private readonly bucket: string,
  ) {
    this.prefix = bucket + ':';
  }

  async increment(key: string) {
    const { rows } = await this.database.query<{ hits: number; expires_at: Date }>(
      `INSERT INTO haip_request_admission AS b (bucket,key_digest,hits,expires_at)
       VALUES ($1,$2,1,statement_timestamp()+interval '1 minute')
       ON CONFLICT (bucket,key_digest) DO UPDATE SET
         hits=CASE WHEN b.expires_at<=statement_timestamp() THEN 1 ELSE LEAST(b.hits,2147483646)+1 END,
         expires_at=CASE WHEN b.expires_at<=statement_timestamp()
           THEN statement_timestamp()+interval '1 minute' ELSE b.expires_at END
       RETURNING hits,expires_at`,
      [this.bucket, digestBytes(key)],
    );
    return { totalHits: rows[0]!.hits, resetTime: rows[0]!.expires_at };
  }

  async decrement(key: string) {
    await this.database.query(
      'UPDATE haip_request_admission SET hits=GREATEST(hits-1,0) WHERE bucket=$1 AND key_digest=$2',
      [this.bucket, digestBytes(key)],
    );
  }

  async resetKey(key: string) {
    await this.database.query(
      'DELETE FROM haip_request_admission WHERE bucket=$1 AND key_digest=$2',
      [this.bucket, digestBytes(key)],
    );
  }
}

export async function pruneRequestAdmission(database: CounterDatabase): Promise<boolean> {
  const result = await database.query(
    `WITH expired AS (
       SELECT bucket,key_digest FROM haip_request_admission WHERE expires_at<=statement_timestamp()
       ORDER BY expires_at,bucket,key_digest LIMIT 500 FOR UPDATE SKIP LOCKED
     ) DELETE FROM haip_request_admission b USING expired e
       WHERE b.bucket=e.bucket AND b.key_digest=e.key_digest`,
  );
  return result.rowCount === 500;
}

export type RequestLimiter = (options: RateLimitOptions) => RequestHandler;

export function requestRateLimit(
  options: RateLimitOptions,
  database?: CounterDatabase,
): RequestHandler {
  const seen = new WeakSet<Request>();
  return rateLimit({
    windowMs: 60000,
    message: { error: 'rate_limited' },
    legacyHeaders: false,
    standardHeaders: 'draft-8' as const,
    passOnStoreError: false,
    ...(database ? { store: new PostgresCounter(database, options.identifier) } : {}),
    limit: options.limit,
    identifier: options.identifier,
    skip: (request) => {
      const repeated = seen.has(request);
      seen.add(request);
      return repeated;
    },
    keyGenerator: options.key ?? (() => 'service'),
    validate: {
      keyGeneratorIpFallback: false,
      xForwardedForHeader: false,
      trustProxy: false,
    },
  });
}
