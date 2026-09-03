/**
 * Client for producer Views on the HAIP Agent UI wire.
 *
 * A View runs inside HAIP's opaque sandbox frame with scripts only. It can present the stored input and result snapshots and propose a response. It cannot confirm, authorise or execute anything. This client implements the `haip/ui.*` handshake, correlated requests and single proposal channel.
 */
export const AGENT_UI_PROFILE = 'org.haiprotocol.agent-ui/2';
export const PROTOCOL_REVISION = '2.0.0-draft.3';
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

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface AgentUiEnvelope {
  readonly profile: typeof AGENT_UI_PROFILE;
  readonly protocol_revision: typeof PROTOCOL_REVISION;
  readonly request: {
    readonly id: string;
    readonly digest: string;
    readonly purpose: 'review' | 'authorise_execution';
    readonly authorisation_revision: number;
    readonly supersedes: string | null;
  };
  readonly bundle: {
    readonly id: string;
    readonly publisher: string;
    readonly digest: string;
    readonly created_at: string;
  };
  readonly source: {
    readonly tenant: string;
    readonly producer: string;
    readonly requester: { readonly subject: string; readonly source: string };
    readonly origin: string;
  };
  readonly snapshots: { readonly input_digest: string; readonly result_digest: string };
  readonly binding_digest: string;
}

export interface ViewOptions {
  /** Informative only. This value confers no identity or authority. */
  name: string;
  version: string;
  /** Called exactly once with the complete immutable input snapshot. */
  onInput?: (input: AgentUiInput) => void;
  /** Called exactly once, after input, with the complete immutable result snapshot. */
  onResult?: (result: AgentUiResult) => void;
  /** Called after the client acknowledges teardown and enters its terminal state. */
  onTeardown?: () => void;
}

export type Decision = 'answer' | 'approve' | 'reject' | 'authorise' | 'refuse';

export interface Proposal {
  decision: Decision;
  response: JsonValue;
}

export interface AgentUiInput {
  readonly request_id: string;
  readonly purpose: 'review' | 'authorise_execution';
}

export interface AgentUiResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent: { readonly payload: JsonValue };
}

export interface ProposalResult {
  candidate_id: string;
  status: 'awaiting_human_confirmation';
}

export interface View {
  /** The identity verified by the host and bound to this View. */
  readonly envelope: AgentUiEnvelope;
  /** Submit a schema-valid candidate. Confirmation stays with the trusted host. */
  propose(candidate: Proposal): Promise<ProposalResult>;
}

type JsonRpc = {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9_.:@/-]+$/;
const DECISIONS = new Set<Decision>(['answer', 'approve', 'reject', 'authorise', 'refuse']);
const ERROR_CODES = new Set([-32600, -32601, -32602, -32000]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORIGIN_OCTET = '(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
const ORIGIN_HOST = `(?:localhost|(?:${ORIGIN_OCTET})(?:\\.(?:${ORIGIN_OCTET})){3}|(?=[a-z0-9.-]*[a-z])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)`;
const ORIGIN_PORT =
  '(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';
const ORIGIN_PATTERNS = [
  new RegExp(`^http://${ORIGIN_HOST}(?::(?!80$)${ORIGIN_PORT})?$`),
  new RegExp(`^https://${ORIGIN_HOST}(?::(?!443$)${ORIGIN_PORT})?$`),
];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const identifier = (value: unknown) =>
  typeof value === 'string' && value.length >= 1 && value.length <= 160 && IDENTIFIER.test(value);
const digest = (value: unknown) => typeof value === 'string' && DIGEST.test(value);
const dateTime = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d\.\d{3}Z$/.test(value))
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};
const origin = (value: unknown) => {
  return typeof value === 'string' && ORIGIN_PATTERNS.some((pattern) => pattern.test(value));
};
const requestId = (value: unknown): value is string | number =>
  (typeof value === 'string' &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= AGENT_UI_LIMITS.request_id_codepoints) ||
  (typeof value === 'number' && Number.isSafeInteger(value));

const wellFormed = (value: string) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

function jsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): boolean {
  if (depth > AGENT_UI_LIMITS.json_depth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return wellFormed(value);
  if (typeof value === 'number')
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (!value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const keys = Object.keys(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      ancestors.delete(value);
      return false;
    }
    const valid = value.every((item) => jsonValue(item, depth + 1, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (!record(value)) {
    ancestors.delete(value);
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  const valid =
    (prototype === Object.prototype || prototype === null) &&
    Object.entries(value).every(
      ([key, item]) => wellFormed(key) && jsonValue(item, depth + 1, ancestors),
    );
  ancestors.delete(value);
  return valid;
}

function boundedMessage(value: unknown, maximum: number): value is Record<string, unknown> {
  if (!record(value) || !jsonValue(value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
  } catch {
    return false;
  }
}

function immutable<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function validEnvelope(value: unknown): value is AgentUiEnvelope {
  if (
    !record(value) ||
    !exact(value, [
      'profile',
      'protocol_revision',
      'request',
      'bundle',
      'source',
      'snapshots',
      'binding_digest',
    ])
  )
    return false;
  const request = value.request;
  const bundle = value.bundle;
  const source = value.source;
  const snapshots = value.snapshots;
  if (
    !record(request) ||
    !exact(request, ['id', 'digest', 'purpose', 'authorisation_revision', 'supersedes'])
  )
    return false;
  if (!record(bundle) || !exact(bundle, ['id', 'publisher', 'digest', 'created_at'])) return false;
  if (!record(source) || !exact(source, ['tenant', 'producer', 'requester', 'origin']))
    return false;
  if (!record(snapshots) || !exact(snapshots, ['input_digest', 'result_digest'])) return false;
  const requester = source.requester;
  if (!record(requester) || !exact(requester, ['subject', 'source'])) return false;
  return (
    value.profile === AGENT_UI_PROFILE &&
    value.protocol_revision === PROTOCOL_REVISION &&
    typeof request.id === 'string' &&
    UUID.test(request.id) &&
    digest(request.digest) &&
    (request.purpose === 'review' || request.purpose === 'authorise_execution') &&
    typeof request.authorisation_revision === 'number' &&
    Number.isSafeInteger(request.authorisation_revision) &&
    request.authorisation_revision >= 0 &&
    (request.supersedes === null || identifier(request.supersedes)) &&
    identifier(bundle.id) &&
    identifier(bundle.publisher) &&
    digest(bundle.digest) &&
    dateTime(bundle.created_at) &&
    identifier(source.tenant) &&
    identifier(source.producer) &&
    identifier(requester.subject) &&
    identifier(requester.source) &&
    origin(source.origin) &&
    digest(snapshots.input_digest) &&
    digest(snapshots.result_digest) &&
    digest(value.binding_digest)
  );
}

function validInitialiseResult(value: unknown): value is { envelope: AgentUiEnvelope } {
  if (
    !record(value) ||
    !exact(value, [
      'protocolVersion',
      'capabilities',
      'hostInfo',
      'envelope',
      'limits',
      'lifecycle',
    ])
  )
    return false;
  const capabilities = value.capabilities;
  const hostInfo = value.hostInfo;
  const limits = value.limits;
  const lifecycle = value.lifecycle;
  return (
    value.protocolVersion === AGENT_UI_PROFILE &&
    record(capabilities) &&
    exact(capabilities, ['localProposal']) &&
    capabilities.localProposal === true &&
    record(hostInfo) &&
    exact(hostInfo, ['name', 'version']) &&
    typeof hostInfo.name === 'string' &&
    typeof hostInfo.version === 'string' &&
    record(limits) &&
    exact(limits, Object.keys(AGENT_UI_LIMITS)) &&
    Object.entries(AGENT_UI_LIMITS).every(([name, limit]) => limits[name] === limit) &&
    record(lifecycle) &&
    exact(lifecycle, Object.keys(AGENT_UI_LIFECYCLE)) &&
    Object.entries(AGENT_UI_LIFECYCLE).every(([name, stage]) => lifecycle[name] === stage) &&
    validEnvelope(value.envelope)
  );
}

function validProposal(value: unknown): value is Proposal {
  return (
    record(value) &&
    exact(value, ['decision', 'response']) &&
    typeof value.decision === 'string' &&
    DECISIONS.has(value.decision as Decision) &&
    jsonValue(value.response)
  );
}

function validProposalResult(value: unknown): value is ProposalResult {
  return (
    record(value) &&
    exact(value, ['candidate_id', 'status']) &&
    typeof value.candidate_id === 'string' &&
    value.status === 'awaiting_human_confirmation'
  );
}

function validInput(value: unknown): value is AgentUiInput {
  return (
    record(value) &&
    exact(value, ['request_id', 'purpose']) &&
    typeof value.request_id === 'string' &&
    UUID.test(value.request_id) &&
    (value.purpose === 'review' || value.purpose === 'authorise_execution')
  );
}

function validResult(value: unknown): value is AgentUiResult {
  if (
    !record(value) ||
    !exact(value, ['content', 'structuredContent']) ||
    !Array.isArray(value.content) ||
    !record(value.structuredContent) ||
    !exact(value.structuredContent, ['payload']) ||
    !jsonValue(value.structuredContent.payload)
  )
    return false;
  return value.content.every(
    (item) =>
      record(item) &&
      exact(item, ['type', 'text']) &&
      item.type === 'text' &&
      typeof item.text === 'string',
  );
}

/** Connect this View to the HAIP host. The promise resolves after initialisation succeeds and the client has requested its immutable snapshots. */
export function connectView(options: ViewOptions): Promise<View> {
  const target = window.parent;
  let targetOrigin = '*';
  let nextId = 1;
  const pending = new Map<string | number, Pending>();
  let inputSeen = false;
  let resultSeen = false;
  let closed = false;
  let activeEnvelope: AgentUiEnvelope | undefined;

  const close = (error: Error) => {
    if (closed) return;
    closed = true;
    window.removeEventListener('message', receive);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  // The opaque View cannot know its parent's origin until the verified initialise response. That first request uses the exact parent WindowProxy, then every message pins the returned sandbox origin.
  const post = (message: JsonRpc) => {
    if (!boundedMessage(message, AGENT_UI_LIMITS.view_message_bytes)) {
      close(new Error('View message exceeds Agent UI limits'));
      return false;
    }
    target.postMessage(message, targetOrigin);
    return true;
  };
  const request = (method: string, params: unknown) => {
    if (closed) return Promise.reject(new Error('View closed'));
    const id = nextId++;
    const wait = new Promise<unknown>((resolve, reject) =>
      pending.set(id, { method, resolve, reject }),
    );
    post({ jsonrpc: '2.0', id, method, params });
    return wait;
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: '2.0', method, params });

  const receive = (event: MessageEvent) => {
    if (closed || event.source !== target || !record(event.data) || event.data.jsonrpc !== '2.0')
      return;
    if (
      !activeEnvelope &&
      (Object.hasOwn(event.data, 'method') ||
        !requestId(event.data.id) ||
        pending.get(event.data.id)?.method !== 'haip/ui.initialize')
    )
      return;
    if (!boundedMessage(event.data, AGENT_UI_LIMITS.host_message_bytes)) {
      close(new Error('Host message exceeds Agent UI limits'));
      return;
    }
    if (activeEnvelope && event.origin !== activeEnvelope.source.origin) {
      close(new Error('Host origin changed'));
      return;
    }
    const message = event.data as JsonRpc;
    if (message.method === undefined) {
      if (!requestId(message.id) || !pending.has(message.id)) return;
      const waiter = pending.get(message.id)!;
      pending.delete(message.id);
      const hasResult = Object.hasOwn(message, 'result');
      const hasError = Object.hasOwn(message, 'error');
      const expected = hasResult ? ['jsonrpc', 'id', 'result'] : ['jsonrpc', 'id', 'error'];
      if (hasResult === hasError || !exact(event.data, expected)) {
        waiter.reject(new Error('Invalid host response'));
        close(new Error('Invalid host response'));
      } else if (hasResult && waiter.method === 'haip/ui.initialize') {
        if (!validInitialiseResult(message.result)) {
          waiter.reject(new Error('Host refused the Agent UI profile'));
          close(new Error('Host refused the Agent UI profile'));
        } else if (event.origin !== message.result.envelope.source.origin) {
          waiter.reject(new Error('Host origin does not match the Agent UI envelope'));
          close(new Error('Host origin does not match the Agent UI envelope'));
        } else {
          targetOrigin = event.origin;
          waiter.resolve(message.result);
        }
      } else if (hasError) {
        const error = message.error;
        if (
          !record(error) ||
          !exact(error, ['code', 'message']) ||
          typeof error.code !== 'number' ||
          !ERROR_CODES.has(error.code) ||
          typeof error.message !== 'string' ||
          Array.from(error.message).length > AGENT_UI_LIMITS.error_message_codepoints
        ) {
          waiter.reject(new Error('Invalid host error'));
          close(new Error('Invalid host error'));
        } else waiter.reject(new Error(error.message));
      } else waiter.resolve(message.result);
      return;
    }
    switch (message.method) {
      case 'haip/ui.input':
        if (
          inputSeen ||
          !exact(event.data, ['jsonrpc', 'method', 'params']) ||
          !validInput(message.params) ||
          !activeEnvelope ||
          message.params.request_id !== activeEnvelope.request.id ||
          message.params.purpose !== activeEnvelope.request.purpose
        )
          return;
        inputSeen = true;
        options.onInput?.(immutable(message.params));
        return;
      case 'haip/ui.result':
        if (
          resultSeen ||
          !inputSeen ||
          !exact(event.data, ['jsonrpc', 'method', 'params']) ||
          !validResult(message.params)
        )
          return;
        resultSeen = true;
        options.onResult?.(immutable(message.params));
        return;
      case 'haip/ui.teardown':
        if (
          !exact(event.data, ['jsonrpc', 'id', 'method', 'params']) ||
          !requestId(message.id) ||
          !record(message.params) ||
          Object.keys(message.params).length !== 0
        )
          return;
        post({ jsonrpc: '2.0', id: message.id, result: { closed: true } });
        close(new Error('Host closed'));
        options.onTeardown?.();
        return;
      default:
        if (requestId(message.id))
          post({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Forbidden host operation' },
          });
        return;
    }
  };
  window.addEventListener('message', receive);

  const name = Array.from(String(options.name))
    .slice(0, AGENT_UI_LIMITS.view_name_codepoints)
    .join('');
  const version = Array.from(String(options.version))
    .slice(0, AGENT_UI_LIMITS.view_version_codepoints)
    .join('');
  if (!name || !version) {
    const error = new Error('View name and version are required');
    close(error);
    return Promise.reject(error);
  }
  return request('haip/ui.initialize', {
    protocolVersion: AGENT_UI_PROFILE,
    capabilities: { localProposal: true },
    viewInfo: { name, version },
  })
    .then((result) => {
      if (!validInitialiseResult(result)) throw new Error('Host refused the Agent UI profile');
      const envelope = immutable(result.envelope);
      activeEnvelope = envelope;
      notify('haip/ui.initialized', {});
      return {
        envelope,
        propose: async (candidate: Proposal) => {
          if (!resultSeen) throw new Error('Snapshots not ready');
          if (!validProposal(candidate)) throw new Error('Invalid proposal');
          const proposal = await request('haip/ui.propose', candidate);
          if (!validProposalResult(proposal)) throw new Error('Invalid proposal response');
          return proposal;
        },
      };
    })
    .catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      close(failure);
      throw failure;
    });
}
