import { canonicalise, parseJson } from '@haip/protocol/json';
import {
  AGENT_UI_LIFECYCLE,
  AGENT_UI_LIMITS,
  AGENT_UI_PROFILE,
  isAgentUiOrigin,
  PROTOCOL_REVISION,
} from '@haip/protocol';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let csrf = '';
const requestId = location.pathname.split('/')[2];
type ProposalSource = Readonly<{
  kind: 'native_form' | 'producer_app';
  publisher?: string;
  bundle_id?: string;
  bundle_digest?: string;
}>;
type AppBinding = Readonly<{
  id: string;
  publisher: string;
  digest: string;
  created_at: string;
}>;
type CandidateBinding = Readonly<{
  requestId: string;
  requestDigest: string;
  purpose: 'review' | 'authorise_execution';
  authorisationRevision: number;
  reviewer: string;
  responseBytes: number;
}>;
type FrozenResponse = Readonly<{
  candidate: Readonly<Record<string, unknown>>;
  candidateId: string;
  digest: string;
  source: ProposalSource;
}>;
let frozenResponse: FrozenResponse | undefined,
  preparingSource: ProposalSource | undefined,
  phase: 'ready' | 'preparing' | 'reviewing' | 'confirming' | 'dismissed' | 'complete' = 'ready',
  proposalAttempt = 0,
  pending = true,
  appAvailable = false;
let allFields: string[] = [],
  filtered: string[] = [],
  page = 0,
  listOffset = 0;
const showError = (e: unknown) => {
  el('error').textContent = e instanceof Error ? e.message : String(e);
};
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers:
      body === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': crypto.randomUUID(),
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? 'Request failed');
  return json;
}
const sha256 = async (bytes: BufferSource) =>
  'sha256:' +
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const hash = async (value: unknown) => sha256(new TextEncoder().encode(canonicalise(value)));
const hashBytes = async (value: string) => sha256(new TextEncoder().encode(value));
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9_.:@/-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const empty = (value: unknown) => exact(value, []);
const identifier = (value: unknown) =>
  typeof value === 'string' && value.length >= 1 && value.length <= 160 && IDENTIFIER.test(value);
const digestValue = (value: unknown) => typeof value === 'string' && DIGEST.test(value);
const canonicalDateTime = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d\.\d{3}Z$/.test(value))
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};
const date = /^(\d{4})-(\d{2})-(\d{2})$/;
const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2})(?::?(\d{2}))?)$/i;
const schemaDateTime = (value: unknown) => {
  if (typeof value !== 'string') return false;
  const parts = value.split(/t|\s/i);
  if (parts.length !== 2) return false;
  const dateParts = date.exec(parts[0]!);
  const timeParts = time.exec(parts[1]!);
  if (!dateParts || !timeParts) return false;
  const year = Number(dateParts[1]);
  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month]!) return false;
  const hour = Number(timeParts[1]);
  const minute = Number(timeParts[2]);
  const second = Number(timeParts[3]);
  const sign = timeParts[5] === '-' ? -1 : 1;
  const offsetHour = Number(timeParts[6] ?? 0);
  const offsetMinute = Number(timeParts[7] ?? 0);
  if (offsetHour > 23 || offsetMinute > 59) return false;
  if (hour <= 23 && minute <= 59 && second < 60) return true;
  const utcMinute = minute - offsetMinute * sign;
  const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0);
  return (
    (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61
  );
};
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
const jsonValue = (value: unknown, depth = 0, ancestors = new Set<object>()): boolean => {
  if (depth > AGENT_UI_LIMITS.json_depth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return wellFormed(value);
  if (typeof value === 'number')
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false;
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
};
const decisions = ['answer', 'approve', 'reject', 'authorise', 'refuse'] as const;
type DecisionProposalValue = Readonly<{
  decision: (typeof decisions)[number];
  response: unknown;
}>;
const validDecisionProposal = (value: unknown): value is DecisionProposalValue =>
  exact(value, ['decision', 'response']) &&
  typeof value.decision === 'string' &&
  decisions.includes(value.decision as (typeof decisions)[number]) &&
  jsonValue(value.response);
async function validDecisionCandidate(
  value: unknown,
  proposal: unknown,
  binding: CandidateBinding,
) {
  if (!validDecisionProposal(proposal)) return false;
  if (
    !exact(value, [
      'id',
      'request_id',
      'request_digest',
      'reviewer',
      'revision',
      'response',
      'response_canonical',
      'response_digest',
      'decision',
      'created_at',
    ]) ||
    !identifier(value.id) ||
    value.request_id !== binding.requestId ||
    value.request_digest !== binding.requestDigest ||
    value.reviewer !== binding.reviewer ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !jsonValue(value.response) ||
    typeof value.response_canonical !== 'string' ||
    !digestValue(value.response_digest) ||
    value.decision !== proposal.decision ||
    !schemaDateTime(value.created_at)
  )
    return false;
  const allowedDecisions =
    binding.purpose === 'authorise_execution'
      ? (['authorise', 'refuse'] as const)
      : (['answer', 'approve', 'reject'] as const);
  if (!allowedDecisions.some((decision) => decision === value.decision)) return false;
  const responseCanonical = canonicalise(value.response);
  return (
    responseCanonical === value.response_canonical &&
    responseCanonical === canonicalise(proposal.response) &&
    new TextEncoder().encode(responseCanonical).byteLength <= binding.responseBytes &&
    (await hash(value.response)) === value.response_digest
  );
}
function validStoredApp(value: any, expectedRequestId: string | undefined) {
  if (
    !exact(value, [
      'profile',
      'protocol_revision',
      'request',
      'bundle',
      'source',
      'snapshots',
      'binding_digest',
      'html',
      'origin',
      'scope',
      'input',
      'result',
    ])
  )
    return false;
  const stored = value as any;
  if (
    stored.profile !== AGENT_UI_PROFILE ||
    stored.protocol_revision !== PROTOCOL_REVISION ||
    !exact(stored.request, ['id', 'digest', 'purpose', 'authorisation_revision', 'supersedes']) ||
    stored.request.id !== expectedRequestId ||
    typeof stored.request.id !== 'string' ||
    !UUID.test(stored.request.id) ||
    !digestValue(stored.request.digest) ||
    !['review', 'authorise_execution'].includes(stored.request.purpose) ||
    !Number.isSafeInteger(stored.request.authorisation_revision) ||
    stored.request.authorisation_revision < 0 ||
    !(stored.request.supersedes === null || identifier(stored.request.supersedes)) ||
    !exact(stored.bundle, ['id', 'publisher', 'digest', 'created_at']) ||
    !identifier(stored.bundle.id) ||
    !identifier(stored.bundle.publisher) ||
    !digestValue(stored.bundle.digest) ||
    !canonicalDateTime(stored.bundle.created_at) ||
    !exact(stored.source, ['tenant', 'producer', 'requester', 'origin']) ||
    !identifier(stored.source.tenant) ||
    !identifier(stored.source.producer) ||
    !exact(stored.source.requester, ['subject', 'source']) ||
    !identifier(stored.source.requester.subject) ||
    !identifier(stored.source.requester.source) ||
    !isAgentUiOrigin(stored.source.origin) ||
    !exact(stored.snapshots, ['input_digest', 'result_digest']) ||
    !digestValue(stored.snapshots.input_digest) ||
    !digestValue(stored.snapshots.result_digest) ||
    !digestValue(stored.binding_digest) ||
    typeof stored.html !== 'string' ||
    stored.origin !== stored.source.origin ||
    typeof stored.scope !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stored.scope) ||
    !exact(stored.input, ['request_id', 'purpose']) ||
    stored.input.request_id !== stored.request.id ||
    stored.input.purpose !== stored.request.purpose ||
    !exact(stored.result, ['content', 'structuredContent']) ||
    !Array.isArray(stored.result.content) ||
    !stored.result.content.every(
      (item: unknown) =>
        exact(item, ['type', 'text']) && item.type === 'text' && typeof item.text === 'string',
    ) ||
    !exact(stored.result.structuredContent, ['payload']) ||
    !jsonValue(stored.result, 1)
  )
    return false;
  return true;
}
const write = (id: string, v: unknown) => {
  el(id).textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function trustedGesture(event: Event) {
  if (event.isTrusted && navigator.userActivation.isActive) return true;
  showError('Use the trusted host controls to start or confirm a response.');
  return false;
}
function responseControls() {
  const locked = ['preparing', 'reviewing', 'confirming'].includes(phase);
  el<HTMLFieldSetElement>('proposal-fields').disabled = locked || !pending;
  el('proposal').hidden = !pending;
  el('assign').hidden = !pending;
  el('confirmation').hidden = !['reviewing', 'confirming'].includes(phase);
  el<HTMLButtonElement>('confirm').disabled = phase !== 'reviewing' || !pending;
  el<HTMLButtonElement>('dismiss-response').disabled = phase !== 'reviewing' || !pending;
  el('allow-app-proposal').hidden = !appAvailable || !pending;
  el<HTMLButtonElement>('allow-app-proposal').disabled = phase !== 'dismissed';
  write(
    'proposal-state',
    {
      ready: 'Ready for one response proposal. A separate host confirmation is always required.',
      preparing: 'Preparing one response. Further app and form proposals are blocked.',
      reviewing: 'This response is frozen. Dismiss it before reviewing another response.',
      confirming: 'Recording this exact frozen response. Further proposals are blocked.',
      dismissed:
        'Response dismissed. Submit the host form again, or explicitly allow one new app proposal.',
      complete: 'This request no longer accepts response proposals.',
    }[phase],
  );
}
function fields(v: unknown, path = '$') {
  if (v && typeof v === 'object' && Object.keys(v).length)
    for (const [k, x] of Object.entries(v)) fields(x, path + '[' + JSON.stringify(k) + ']');
  else allFields.push(path + ' = ' + JSON.stringify(v));
}
function renderPage() {
  write('payload', filtered.slice(page * 40, (page + 1) * 40).join('\n'));
  write(
    'page-state',
    `${filtered.length} fields · page ${page + 1} of ${Math.max(1, Math.ceil(filtered.length / 40))}`,
  );
  el<HTMLButtonElement>('previous').disabled = page === 0;
  el<HTMLButtonElement>('next').disabled = (page + 1) * 40 >= filtered.length;
}
async function propose(body: unknown, source: ProposalSource, binding: CandidateBinding) {
  if (!pending || !['ready', 'dismissed'].includes(phase))
    throw new Error(
      'A response is already frozen or being prepared. Use the trusted host to dismiss it.',
    );
  if (source.kind === 'producer_app' && phase !== 'ready')
    throw new Error('Use the trusted host to allow one new app proposal after dismissal.');
  // Reserve the slot before any asynchronous work so a second proposal cannot overtake it.
  const attempt = ++proposalAttempt;
  preparingSource = source;
  phase = 'preparing';
  responseControls();
  try {
    const candidate = freeze(
      parseJson(canonicalise(await api(`/v2/requests/${requestId}/candidates`, body))) as Record<
        string,
        unknown
      >,
    );
    if (!(await validDecisionCandidate(candidate, body, binding)))
      throw new Error('The candidate does not match the verified request and proposal.');
    const digest = await hash(candidate);
    if (attempt !== proposalAttempt || phase !== 'preparing' || !pending)
      throw new Error('This response is no longer available for review.');
    const frozen = freeze({
      candidate,
      candidateId: candidate.id as string,
      digest,
      source: { ...source },
    });
    frozenResponse = frozen;
    preparingSource = undefined;
    write('exact', frozen.candidate);
    write('candidate-digest', frozen.digest);
    write(
      'proposal-source',
      source.kind === 'native_form'
        ? 'Source: trusted host response form.'
        : `Source: producer app. Publisher: ${source.publisher}. Bundle: ${source.bundle_id}. Bundle digest: ${source.bundle_digest}. App content cannot confirm decisions.`,
    );
    phase = 'reviewing';
    responseControls();
    el('confirmation').scrollIntoView({ behavior: 'smooth' });
    return { candidate_id: frozen.candidateId, status: 'awaiting_human_confirmation' };
  } catch (error) {
    if (attempt === proposalAttempt && phase === 'preparing') {
      preparingSource = undefined;
      phase = 'dismissed';
      responseControls();
    }
    throw error;
  }
}
async function status() {
  const s = await api(`/v2/requests/${requestId}`);
  write(
    'status',
    `Decision: ${s.decision_state} · Audit: ${s.audit_state} · Grant: ${s.grant_state} · Execution: ${s.execution_state}`,
  );
  write('receipt', s.receipt ?? 'No confirmed decision.');
  if (s.decision_state !== 'pending') {
    pending = false;
    phase = 'complete';
    frozenResponse = undefined;
    preparingSource = undefined;
    proposalAttempt++;
  }
  responseControls();
  const deadline = s.receipt?.payload?.grant_deadline ?? s.request.review_deadline;
  const remaining = Math.max(0, Math.floor((Date.parse(deadline) - Date.now()) / 1000));
  write(
    'remaining',
    `${remaining}s until ${deadline}. Server time decides validity; refresh never extends it.`,
  );
  write(
    'delivery',
    s.delivery?.length ? s.delivery : 'No delivery configured or queued. Check the inbox directly.',
  );
  return s;
}
async function inbox() {
  const result = await api(
    '/v2/requests?offset=' +
      listOffset +
      '&state=' +
      encodeURIComponent(el<HTMLSelectElement>('filter').value),
  );
  el('requests').replaceChildren();
  for (const r of result.items) {
    const row = document.createElement('article');
    row.className = 'request';
    const link = document.createElement('a');
    link.href = '/review/' + encodeURIComponent(r.id);
    link.textContent = r.summary;
    const details = document.createElement('p');
    details.textContent = `${r.decision} · ${r.audit} · ${r.grant} · ${r.deadline}${r.assignment ? ' · Assigned to ' + r.assignment.reviewer : ''}`;
    row.append(link, details);
    el('requests').append(row);
  }
  el<HTMLButtonElement>('more').disabled = result.next_offset === null;
}
async function app(expectedBundle: AppBinding, candidateBinding: CandidateBinding) {
  const stored = await api(`/v2/requests/${requestId}/app`);
  if (
    !validStoredApp(stored, requestId) ||
    stored.bundle.id !== expectedBundle.id ||
    stored.bundle.publisher !== expectedBundle.publisher ||
    stored.bundle.digest !== expectedBundle.digest ||
    stored.bundle.created_at !== expectedBundle.created_at ||
    stored.request.id !== candidateBinding.requestId ||
    stored.request.digest !== candidateBinding.requestDigest ||
    stored.request.purpose !== candidateBinding.purpose ||
    stored.request.authorisation_revision !== candidateBinding.authorisationRevision
  ) {
    selectFallback('envelope binding mismatch');
    return;
  }
  // Verify the complete envelope binding before any producer code is loaded.
  const identity = {
    profile: stored.profile,
    protocol_revision: stored.protocol_revision,
    request: stored.request,
    bundle: stored.bundle,
    source: stored.source,
    snapshots: stored.snapshots,
  };
  if (
    (await hash(identity)) !== stored.binding_digest ||
    (await hash(stored.input)) !== stored.snapshots?.input_digest ||
    (await hash(stored.result)) !== stored.snapshots?.result_digest ||
    (await hashBytes(stored.html)) !== stored.bundle.digest ||
    (
      await hash({
        tenant: stored.source.tenant,
        publisher: stored.bundle.publisher,
        digest: stored.bundle.digest,
      })
    ).slice(7) !== stored.scope
  ) {
    selectFallback('envelope binding mismatch');
    return;
  }
  const envelope = freeze({ ...identity, binding_digest: stored.binding_digest });
  const source: ProposalSource = freeze({
    kind: 'producer_app',
    publisher: stored.bundle.publisher,
    bundle_id: stored.bundle.id,
    bundle_digest: stored.bundle.digest,
  });
  const frame = document.createElement('iframe');
  frame.title = 'Producer app — cannot confirm decisions';
  frame.sandbox.add('allow-scripts', 'allow-same-origin');
  frame.src = stored.origin + '/sandbox/' + stored.scope + '?instance=' + crypto.randomUUID();
  el('app').append(frame);
  const origin = stored.origin;
  type JsonRpc = {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
  };
  let nextId = 1;
  const pending = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const MAX_MESSAGE_BYTES = AGENT_UI_LIMITS.view_message_bytes;
  const MAX_TRACKED_IDS = AGENT_UI_LIMITS.tracked_view_request_ids;
  const MAX_PROPOSALS = AGENT_UI_LIMITS.proposals_per_view;
  let snapshotsSent = false;
  let resourceSent = false;
  let initialised = false;
  let closing = false;
  let closed = false;
  let proposals = 0;
  let outerLoads = 0;
  // View-issued request ids only. Host-issued ids live in `pending` and never share this space.
  const outstanding = new Set<string | number>();
  const completed = new Set<string | number>();
  const messageBytes = (message: unknown) =>
    new TextEncoder().encode(JSON.stringify(message)).byteLength;
  const validRequestId = (value: unknown): value is string | number =>
    (typeof value === 'string' &&
      Array.from(value).length >= 1 &&
      Array.from(value).length <= AGENT_UI_LIMITS.request_id_codepoints) ||
    (typeof value === 'number' && Number.isSafeInteger(value));
  const validError = (value: unknown) =>
    exact(value, ['code', 'message']) &&
    [-32600, -32601, -32602, -32000].includes(value.code as number) &&
    typeof value.message === 'string' &&
    Array.from(value.message).length <= AGENT_UI_LIMITS.error_message_codepoints;
  const validProposal = validDecisionProposal;

  function post(message: JsonRpc) {
    if (closed) return;
    frame.contentWindow!.postMessage(message, origin);
  }
  function request(method: string, params: unknown) {
    const id = nextId++;
    const wait = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    post({ jsonrpc: '2.0', id, method, params });
    return wait;
  }
  function notify(method: string, params: unknown) {
    post({ jsonrpc: '2.0', method, params });
  }
  function reply(id: string | number, result: unknown) {
    post({ jsonrpc: '2.0', id, result });
  }
  function fail(id: string | number, code: number, message: string) {
    post({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: Array.from(message).slice(0, AGENT_UI_LIMITS.error_message_codepoints).join(''),
      },
    });
  }
  function selectFallback(reason: string) {
    appAvailable = false;
    if (
      preparingSource?.kind === 'producer_app' ||
      frozenResponse?.source.kind === 'producer_app'
    ) {
      proposalAttempt++;
      preparingSource = undefined;
      frozenResponse = undefined;
      if (pending) phase = 'dismissed';
      write('exact', '');
      write('candidate-digest', '');
      write('proposal-source', '');
    }
    write('app-state', `App unavailable (${reason}). Use the trusted host response form.`);
    responseControls();
  }
  // Any budget or policy violation destroys the View and selects the native fallback.
  function violation(reason: string) {
    if (closing || closed) return;
    selectFallback(reason);
    void close(false);
  }
  function track(id: string | number) {
    completed.add(id);
    if (completed.size + outstanding.size > MAX_TRACKED_IDS) {
      violation('request id budget exhausted');
      return false;
    }
    return true;
  }

  function receive(event: MessageEvent) {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      !event.data ||
      typeof event.data !== 'object'
    )
      return;
    const message = event.data as JsonRpc;
    if (message.jsonrpc !== '2.0') return;
    if (!jsonValue(event.data)) {
      violation('invalid message');
      return;
    }
    try {
      if (messageBytes(event.data) > MAX_MESSAGE_BYTES) {
        violation('oversized message');
        return;
      }
    } catch {
      violation('unserialisable message');
      return;
    }
    // While closing, only the teardown response is accepted.
    if (closing && message.method !== undefined) return;

    if (!Object.hasOwn(message, 'method')) {
      if (!validRequestId(message.id) || !pending.has(message.id)) return;
      const waiter = pending.get(message.id)!;
      const hasResult = Object.hasOwn(message, 'result');
      const hasError = Object.hasOwn(message, 'error');
      if (
        hasResult === hasError ||
        !exact(message, hasResult ? ['jsonrpc', 'id', 'result'] : ['jsonrpc', 'id', 'error']) ||
        (hasError && !validError(message.error))
      ) {
        violation('invalid renderer response');
        return;
      }
      pending.delete(message.id);
      if (hasError) waiter.reject(new Error((message.error as { message: string }).message));
      else waiter.resolve(message.result);
      return;
    }

    const method = message.method;
    const id = message.id;

    if (method === 'haip/ui.proxyReady') {
      if (!exact(message, ['jsonrpc', 'method', 'params']) || !empty(message.params)) {
        violation('invalid proxy readiness message');
        return;
      }
      if (resourceSent) {
        violation('renderer reloaded');
        return;
      }
      resourceSent = true;
      notify('haip/ui.resourceReady', { html: stored.html, sandbox: 'allow-scripts' });
      return;
    }

    if (method === 'haip/ui.viewFailed') {
      if (
        !exact(message, ['jsonrpc', 'method', 'params']) ||
        !exact(message.params, ['reason']) ||
        typeof message.params.reason !== 'string' ||
        Array.from(message.params.reason).length > AGENT_UI_LIMITS.failure_reason_codepoints
      ) {
        violation('invalid renderer failure message');
        return;
      }
      const reason = message.params.reason;
      violation(reason);
      return;
    }

    if (method === 'haip/ui.initialize') {
      if (!validRequestId(id)) return;
      if (completed.has(id) || outstanding.has(id)) {
        fail(id, -32600, 'Replay or duplicate request id');
        return;
      }
      if (!track(id)) return;
      if (!exact(message, ['jsonrpc', 'id', 'method', 'params'])) {
        fail(id, -32600, 'Invalid Agent UI request');
        queueMicrotask(() => violation('invalid Agent UI request'));
        return;
      }
      if (initialised) {
        fail(id, -32600, 'Already initialised');
        return;
      }
      const params = message.params as
        | {
            protocolVersion?: unknown;
            capabilities?: unknown;
            viewInfo?: unknown;
          }
        | undefined;
      const capabilities = params?.capabilities;
      const viewInfo = params?.viewInfo;
      const validViewInfo =
        viewInfo === undefined ||
        (!!viewInfo &&
          typeof viewInfo === 'object' &&
          !Array.isArray(viewInfo) &&
          Object.keys(viewInfo).every((key) => ['name', 'version'].includes(key)) &&
          typeof (viewInfo as { name?: unknown }).name === 'string' &&
          Array.from((viewInfo as { name: string }).name).length >= 1 &&
          Array.from((viewInfo as { name: string }).name).length <=
            AGENT_UI_LIMITS.view_name_codepoints &&
          typeof (viewInfo as { version?: unknown }).version === 'string' &&
          Array.from((viewInfo as { version: string }).version).length >= 1 &&
          Array.from((viewInfo as { version: string }).version).length <=
            AGENT_UI_LIMITS.view_version_codepoints);
      if (
        !params ||
        Object.keys(params).some(
          (key) => !['protocolVersion', 'capabilities', 'viewInfo'].includes(key),
        ) ||
        params.protocolVersion !== AGENT_UI_PROFILE ||
        !capabilities ||
        typeof capabilities !== 'object' ||
        Array.isArray(capabilities) ||
        Object.keys(capabilities).length !== 1 ||
        (capabilities as { localProposal?: unknown }).localProposal !== true ||
        !validViewInfo
      ) {
        fail(id, -32602, 'Unsupported Agent UI profile');
        queueMicrotask(() => violation('unsupported Agent UI profile'));
        return;
      }
      initialised = true;
      reply(id, {
        protocolVersion: AGENT_UI_PROFILE,
        capabilities: { localProposal: true },
        hostInfo: { name: 'HAIP review host', version: PROTOCOL_REVISION },
        envelope,
        limits: AGENT_UI_LIMITS,
        lifecycle: AGENT_UI_LIFECYCLE,
      });
      return;
    }

    if (method === 'haip/ui.initialized') {
      if (
        !exact(message, ['jsonrpc', 'method', 'params']) ||
        !empty(message.params) ||
        !initialised ||
        snapshotsSent
      ) {
        violation('invalid initialisation completion');
        return;
      }
      snapshotsSent = true;
      window.clearTimeout(initialisationTimer);
      notify('haip/ui.input', stored.input);
      notify('haip/ui.result', stored.result);
      write(
        'app-state',
        'Stored input and result delivered once. Use the trusted host below to confirm.',
      );
      return;
    }

    if (method === 'haip/ui.propose') {
      if (!validRequestId(id)) return;
      if (completed.has(id) || outstanding.has(id)) {
        fail(id, -32600, 'Replay or duplicate request id');
        return;
      }
      if (!snapshotsSent) {
        if (track(id)) fail(id, -32600, 'Snapshots not ready');
        return;
      }
      if (++proposals > MAX_PROPOSALS) {
        if (track(id)) fail(id, -32000, 'Proposal budget exhausted');
        violation('proposal budget exhausted');
        return;
      }
      if (!exact(message, ['jsonrpc', 'id', 'method', 'params'])) {
        if (track(id)) fail(id, -32600, 'Invalid Agent UI request');
        violation('invalid Agent UI request');
        return;
      }
      if (!validProposal(message.params)) {
        if (track(id)) fail(id, -32602, 'Invalid proposal');
        return;
      }
      outstanding.add(id);
      if (outstanding.size + completed.size > MAX_TRACKED_IDS) {
        violation('request id budget exhausted');
        return;
      }
      void Promise.resolve()
        .then(() => propose(message.params, source, candidateBinding))
        .then((result) => reply(id, result))
        .catch((error) => fail(id, -32000, error instanceof Error ? error.message : String(error)))
        .finally(() => {
          outstanding.delete(id);
          completed.add(id);
        });
      return;
    }

    if (validRequestId(id)) {
      if (completed.has(id) || outstanding.has(id))
        fail(id, -32600, 'Replay or duplicate request id');
      else if (track(id)) fail(id, -32601, 'Forbidden host operation');
    }
  }

  async function close(graceful = true) {
    if (closing) return;
    closing = true;
    window.clearTimeout(initialisationTimer);
    try {
      if (graceful && snapshotsSent) {
        const acknowledgement = await Promise.race([
          request('haip/ui.teardown', {}),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('teardown timeout')),
              AGENT_UI_LIMITS.teardown_grace_ms,
            ),
          ),
        ]);
        if (
          !acknowledgement ||
          typeof acknowledgement !== 'object' ||
          Array.isArray(acknowledgement) ||
          Object.keys(acknowledgement).length !== 1 ||
          (acknowledgement as { closed?: unknown }).closed !== true
        )
          throw new Error('invalid teardown acknowledgement');
      }
    } catch {
      // Abrupt teardown remains permitted after a best-effort graceful request.
    }
    closed = true;
    window.removeEventListener('message', receive);
    for (const waiter of pending.values()) waiter.reject(new Error('Host closed'));
    pending.clear();
    outstanding.clear();
    completed.clear();
    frame.remove();
  }

  window.addEventListener('message', receive);
  frame.addEventListener('load', () => {
    if (++outerLoads > 1) violation('renderer reloaded');
  });
  frame.addEventListener('error', () => violation('renderer failed'));
  const initialisationTimer = window.setTimeout(
    () => violation('initialisation timed out'),
    AGENT_UI_LIMITS.initialise_timeout_ms,
  );
  window.addEventListener('pagehide', () => void close(), { once: true });
}
(async () => {
  const session = await api('/auth/session');
  csrf = session.csrf;
  write('identity', session.subject);
  if (!requestId) {
    await inbox();
    el('filter').onchange = () => {
      listOffset = 0;
      void inbox().catch(showError);
    };
    el('more').onclick = () => {
      listOffset += 50;
      void inbox().catch(showError);
    };
    return;
  }
  el('inbox').hidden = true;
  el('review').hidden = false;
  const initial = await status();
  write('summary', initial.request.summary);
  write('binding', initial.request);
  el('refresh-status').onclick = () => void status().catch(showError);
  let material;
  try {
    material = await api(`/v2/requests/${requestId}/material`);
  } catch (error) {
    el('proposal').hidden = true;
    el('assign').hidden = true;
    write(
      'document',
      'Private material is unavailable. Retained signed records remain available below.',
    );
    showError(error);
    return;
  }
  const r = material.request;
  const candidateBinding = freeze({
    requestId: r.id,
    requestDigest: material.request_digest,
    purpose: r.purpose,
    authorisationRevision: r.authorisation_revision,
    reviewer: session.subject,
    responseBytes: r.limits.response_bytes,
  });
  write('summary', r.summary);
  write('binding', r);
  write(
    'deadline',
    `Review before ${r.review_deadline}${r.execution ? ' · Mode: ' + r.execution.mode : ''}`,
  );
  write('document', material.review_document);
  write('schema', material.response_schema);
  fields(material.payload);
  filtered = allFields;
  renderPage();
  el('search').oninput = () => {
    const q = el<HTMLInputElement>('search').value.toLocaleLowerCase();
    filtered = allFields.filter((x) => x.toLocaleLowerCase().includes(q));
    page = 0;
    renderPage();
  };
  el('previous').onclick = () => {
    page--;
    renderPage();
  };
  el('next').onclick = () => {
    page++;
    renderPage();
  };
  const select = el<HTMLSelectElement>('decision');
  for (const choice of r.purpose === 'authorise_execution'
    ? ['refuse', 'authorise']
    : ['answer', 'approve', 'reject']) {
    const option = document.createElement('option');
    option.value = choice;
    option.textContent = choice;
    select.append(option);
  }
  const schema = material.response_schema;
  if (schema.type === 'object' && schema.properties) {
    const seed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties) as [string, any][])
      seed[k] = v.enum?.[0] ?? (v.type === 'number' ? 0 : v.type === 'boolean' ? false : '');
    el<HTMLTextAreaElement>('response').value = JSON.stringify(seed, null, 2);
  }
  el('proposal').onsubmit = (event) => {
    event.preventDefault();
    if (!trustedGesture(event)) return;
    try {
      void propose(
        {
          decision: select.value,
          response: parseJson(el<HTMLTextAreaElement>('response').value),
        },
        { kind: 'native_form' },
        candidateBinding,
      ).catch(showError);
    } catch (error) {
      showError(error);
    }
  };
  el('dismiss-response').onclick = (event) => {
    if (!trustedGesture(event) || phase !== 'reviewing') return;
    frozenResponse = undefined;
    preparingSource = undefined;
    phase = 'dismissed';
    proposalAttempt++;
    write('exact', '');
    write('candidate-digest', '');
    write('proposal-source', '');
    responseControls();
  };
  el('allow-app-proposal').onclick = (event) => {
    if (!trustedGesture(event) || phase !== 'dismissed' || !pending || !appAvailable) return;
    phase = 'ready';
    responseControls();
  };
  el('confirm').onclick = (event) => {
    if (!trustedGesture(event) || phase !== 'reviewing' || !frozenResponse || !pending) return;
    // The displayed record, ID and digest are one immutable snapshot, captured before awaiting I/O.
    const confirmation = frozenResponse;
    phase = 'confirming';
    responseControls();
    void (async () => {
      await api(`/v2/requests/${requestId}/confirm`, {
        candidate_id: confirmation.candidateId,
        candidate_digest: confirmation.digest,
      });
      pending = false;
      frozenResponse = undefined;
      phase = 'complete';
      responseControls();
      await status();
    })().catch((error) => {
      if (frozenResponse === confirmation && phase === 'confirming') {
        phase = 'reviewing';
        responseControls();
      }
      showError(error);
    });
  };
  el('assign').onclick = () => {
    void api(`/v2/requests/${requestId}/assignment`, {})
      .then(() => write('status', 'Assigned to you for up to five minutes.'))
      .catch(showError);
  };
  await status();
  if (r.review.bundle) {
    appAvailable = true;
    responseControls();
    void app(r.review.bundle, candidateBinding).catch(() => {
      appAvailable = false;
      responseControls();
      write('app-state', 'App unavailable. Use the trusted host response form.');
    });
  }
})().catch((error) => {
  if (error.message === 'unauthenticated')
    location.href = '/auth/login?return_to=' + encodeURIComponent(location.pathname);
  else showError(error);
});
