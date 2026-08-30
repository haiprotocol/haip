export * from './generated.js';
export const PROTOCOL_REVISION = '2.0.0-draft.1' as const;
export const EXECUTION_PROFILE = 'haip.execution';
export const EXECUTION_VERSION = '1-draft.1';
export const RENDERER = { ext_apps: '1.7.4', mcp_sdk: '1.29.0' } as const;
export const DEFAULT_LIMITS = Object.freeze({
  bundle_bytes: 5 * 1024 ** 2,
  payload_bytes: 10 * 1024 ** 2,
  response_bytes: 256 * 1024,
  inline_result_bytes: 2 * 1024 ** 2,
  retained_bytes: 1024 ** 3,
  review_seconds: 86400,
  grant_seconds: 86400,
  execution_seconds: 3600,
  reconciliation_seconds: 7 * 86400,
  audit_seconds: 90 * 86400,
});

import type { SignedRecord } from './generated.js';
export type Signed<T> = Omit<SignedRecord, 'payload'> & { payload: T };
