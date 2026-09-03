export * from './generated.js';
export const PROTOCOL_REVISION = '2.0.0-draft.3' as const;
export const EXECUTION_PROFILE = 'haip.execution';
export const EXECUTION_VERSION = '1-draft.1';
export const AGENT_UI_PROFILE = 'org.haiprotocol.agent-ui/2' as const;
export const RENDERER = { agent_ui: '2' } as const;
export const AGENT_UI_LIMITS = Object.freeze({
  view_message_bytes: 1_048_576,
  host_message_bytes: 6_291_456,
  tracked_view_request_ids: 512,
  proposals_per_view: 32,
  initialise_timeout_ms: 5_000,
  teardown_grace_ms: 250,
  json_depth: 64,
  request_id_codepoints: 200,
  error_message_codepoints: 400,
  view_name_codepoints: 120,
  view_version_codepoints: 40,
  failure_reason_codepoints: 160,
});
export const AGENT_UI_LIFECYCLE = Object.freeze({
  initialise: 'haip/ui.initialize -> haip/ui.initialized',
  snapshots: 'haip/ui.input -> haip/ui.result',
  proposal_after: 'haip/ui.result',
  teardown: 'terminal',
});
const AGENT_UI_ORIGIN_OCTET = '(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
const AGENT_UI_ORIGIN_HOST = `(?:localhost|(?:${AGENT_UI_ORIGIN_OCTET})(?:\\.(?:${AGENT_UI_ORIGIN_OCTET})){3}|(?=[a-z0-9.-]*[a-z])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)`;
const AGENT_UI_ORIGIN_PORT =
  '(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';
const AGENT_UI_ORIGIN_PATTERNS = [
  new RegExp(`^http://${AGENT_UI_ORIGIN_HOST}(?::(?!80$)${AGENT_UI_ORIGIN_PORT})?$`),
  new RegExp(`^https://${AGENT_UI_ORIGIN_HOST}(?::(?!443$)${AGENT_UI_ORIGIN_PORT})?$`),
];
export const isAgentUiOrigin = (value: unknown): value is AgentUiOrigin =>
  typeof value === 'string' && AGENT_UI_ORIGIN_PATTERNS.some((pattern) => pattern.test(value));
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

import type { AgentUiOrigin, SignedRecord } from './generated.js';
type Assert<T extends true> = T;
type AgentUiOriginAcceptsString = Assert<string extends AgentUiOrigin ? true : false>;
export type Signed<T> = Omit<SignedRecord, 'payload'> & { payload: T };
