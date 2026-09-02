import { canonicalise, parseJson } from '@haip/protocol/json';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let csrf = '';
const requestId = location.pathname.split('/')[2];
type ProposalSource = Readonly<{
  kind: 'native_form' | 'producer_app';
  publisher?: string;
  bundle_id?: string;
  bundle_digest?: string;
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
const hash = async (v: unknown) =>
  'sha256:' +
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalise(v))),
    ),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
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
async function propose(body: unknown, source: ProposalSource) {
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
    if (candidate.request_id !== requestId || typeof candidate.id !== 'string')
      throw new Error('The candidate does not match this request.');
    const digest = await hash(candidate);
    if (attempt !== proposalAttempt || phase !== 'preparing' || !pending)
      throw new Error('This response is no longer available for review.');
    frozenResponse = freeze({
      candidate,
      candidateId: candidate.id,
      digest,
      source: { ...source },
    });
    preparingSource = undefined;
    write('exact', frozenResponse.candidate);
    write('candidate-digest', frozenResponse.digest);
    write(
      'proposal-source',
      source.kind === 'native_form'
        ? 'Source: trusted host response form.'
        : `Source: producer app. Publisher: ${source.publisher}. Bundle: ${source.bundle_id}. Bundle digest: ${source.bundle_digest}. App content cannot confirm decisions.`,
    );
    phase = 'reviewing';
    responseControls();
    el('confirmation').scrollIntoView({ behavior: 'smooth' });
    return { candidate_id: frozenResponse.candidateId, status: 'awaiting_human_confirmation' };
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
async function app(source: ProposalSource) {
  const stored = await api(`/v2/requests/${requestId}/app`);
  const frame = document.createElement('iframe');
  frame.title = 'Producer app — cannot confirm decisions';
  frame.sandbox.add('allow-scripts', 'allow-same-origin');
  frame.src = stored.origin + '/sandbox/' + stored.scope + '?instance=' + crypto.randomUUID();
  el('app').append(frame);
  const origin = new URL(stored.origin).origin;
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
  const MAX_MESSAGE_BYTES = 1_048_576;
  const MAX_TRACKED_IDS = 512;
  const MAX_PROPOSALS = 32;
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
    post({ jsonrpc: '2.0', id, error: { code, message } });
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

    if (!('method' in message) || message.method === undefined) {
      if (message.id === undefined || !pending.has(message.id)) return;
      const waiter = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }

    const method = message.method;
    const id = message.id;

    if (method === 'haip/ui.proxyReady') {
      if (resourceSent) {
        violation('renderer reloaded');
        return;
      }
      resourceSent = true;
      notify('haip/ui.resourceReady', { html: stored.html, sandbox: 'allow-scripts' });
      return;
    }

    if (method === 'haip/ui.viewFailed') {
      const reason =
        typeof (message.params as { reason?: unknown } | undefined)?.reason === 'string'
          ? String((message.params as { reason: string }).reason).slice(0, 160)
          : 'renderer failed';
      violation(reason);
      return;
    }

    if (method === 'haip/ui.initialize') {
      if (id === undefined || completed.has(id) || outstanding.has(id)) return;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      if (!track(id)) return;
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
          (viewInfo as { name: string }).name.length <= 160 &&
          typeof (viewInfo as { version?: unknown }).version === 'string' &&
          (viewInfo as { version: string }).version.length <= 80);
      if (
        !params ||
        Object.keys(params).some(
          (key) => !['protocolVersion', 'capabilities', 'viewInfo'].includes(key),
        ) ||
        params.protocolVersion !== 'org.haiprotocol.agent-ui/1' ||
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
        protocolVersion: 'org.haiprotocol.agent-ui/1',
        capabilities: { localProposal: true },
        hostInfo: { name: 'HAIP review host', version: '2.0.0-draft.1' },
        envelope: {
          requestId,
          requestDigest: stored.request_digest,
        },
      });
      return;
    }

    if (method === 'haip/ui.initialized') {
      if (!initialised || id !== undefined || snapshotsSent) return;
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
      if (!snapshotsSent || id === undefined) return;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      if (completed.has(id) || outstanding.has(id)) {
        fail(id, -32600, 'Replay or duplicate request id');
        return;
      }
      if (++proposals > MAX_PROPOSALS) {
        fail(id, -32000, 'Proposal budget exhausted');
        violation('proposal budget exhausted');
        return;
      }
      outstanding.add(id);
      if (outstanding.size + completed.size > MAX_TRACKED_IDS) {
        violation('request id budget exhausted');
        return;
      }
      void Promise.resolve()
        .then(() => propose(message.params, source))
        .then((result) => reply(id, result))
        .catch((error) =>
          fail(id, -32000, error instanceof Error ? error.message : String(error)),
        )
        .finally(() => {
          outstanding.delete(id);
          completed.add(id);
        });
      return;
    }

    if (id !== undefined && (typeof id === 'string' || typeof id === 'number'))
      fail(id, -32601, 'Forbidden host operation');
  }

  async function close(graceful = true) {
    if (closing) return;
    closing = true;
    window.clearTimeout(initialisationTimer);
    try {
      if (graceful && snapshotsSent)
        await Promise.race([
          request('haip/ui.teardown', {}),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('teardown timeout')), 250),
          ),
        ]);
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
    5000,
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
    void app({
      kind: 'producer_app',
      publisher: r.review.bundle.publisher,
      bundle_id: r.review.bundle.id,
      bundle_digest: r.review.bundle.digest,
    }).catch(() => {
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
