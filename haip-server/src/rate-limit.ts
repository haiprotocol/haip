import { rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';

export interface RateLimitOptions {
  limit: number;
  identifier: string;
  key?: (request: Request) => string;
}

export function principalRateKey(request: Request): string {
  return JSON.stringify([request.principal.tenant, request.principal.id]);
}

export function requestRateLimit(options: RateLimitOptions): RequestHandler {
  const seen = new WeakSet<Request>();
  return rateLimit({
    windowMs: 60000,
    message: { error: 'rate_limited' },
    legacyHeaders: false,
    standardHeaders: 'draft-8' as const,
    passOnStoreError: false,
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
