/**
 * @haip/view — client for producer Views on the HAIP Agent UI wire.
 *
 * A View runs inside HAIP's opaque, scripts-only sandbox frame. It can present the
 * stored input and result snapshots and propose a response; it can never confirm,
 * authorise or execute anything. This client implements the `haip/ui.*` handshake,
 * id-correlated requests and the single proposal channel so producers do not hand-roll
 * them.
 */
export const AGENT_UI_PROFILE = 'org.haiprotocol.agent-ui/1';

export interface AgentUiEnvelope {
  profile: typeof AGENT_UI_PROFILE;
  protocol_revision: string;
  request: {
    id: string;
    digest: string;
    purpose: 'review' | 'authorise_execution';
    authorisation_revision: number;
    supersedes: string | null;
  };
  bundle: { id: string; publisher: string; digest: string; created_at: string };
  source: {
    tenant: string;
    producer: string;
    requester: { subject: string; source: string };
    origin: string;
  };
  snapshots: { input_digest: string; result_digest: string };
  binding_digest: string;
}

export interface ViewOptions {
  /** Informative only; confers no identity or authority. */
  name: string;
  version: string;
  /** Called exactly once with the complete immutable input snapshot. */
  onInput?: (input: unknown) => void;
  /** Called exactly once, after input, with the complete immutable result snapshot. */
  onResult?: (result: unknown) => void;
  /** Called when the host requests graceful teardown; the acknowledgement is automatic. */
  onTeardown?: () => void;
}

export interface Proposal {
  decision: string;
  response: unknown;
}

export interface View {
  /** The host-verified envelope identity this View is bound to. */
  readonly envelope: AgentUiEnvelope;
  /** Submit a schema-valid candidate. Confirmation stays with the trusted host. */
  propose(candidate: Proposal): Promise<unknown>;
}

type JsonRpc = {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

/**
 * Connect this View to the HAIP host. Resolves after `haip/ui.initialize` succeeds and
 * `haip/ui.initialized` has been sent; snapshot callbacks fire as they arrive.
 */
export function connectView(options: ViewOptions): Promise<View> {
  const target = window.parent;
  let nextId = 1;
  const pending = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let inputSeen = false;
  let resultSeen = false;

  // The sandbox frame has an opaque origin, so '*' is the only possible target; the
  // exact WindowProxy is checked on every inbound message instead.
  const post = (message: JsonRpc) => target.postMessage(message, '*');
  const request = (method: string, params: unknown) => {
    const id = nextId++;
    const wait = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    post({ jsonrpc: '2.0', id, method, params });
    return wait;
  };
  const notify = (method: string, params: unknown) =>
    post({ jsonrpc: '2.0', method, params });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== target || !event.data || typeof event.data !== 'object') return;
    const message = event.data as JsonRpc;
    if (message.jsonrpc !== '2.0') return;
    if (message.method === undefined) {
      if (message.id === undefined || !pending.has(message.id)) return;
      const waiter = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    switch (message.method) {
      case 'haip/ui.input':
        if (inputSeen) return;
        inputSeen = true;
        options.onInput?.(message.params);
        return;
      case 'haip/ui.result':
        if (resultSeen || !inputSeen) return;
        resultSeen = true;
        options.onResult?.(message.params);
        return;
      case 'haip/ui.teardown':
        if (message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, result: { closed: true } });
        options.onTeardown?.();
        return;
      default:
        // Unknown host methods are ignored; the View never gains capabilities by request.
        return;
    }
  });

  return request('haip/ui.initialize', {
    protocolVersion: AGENT_UI_PROFILE,
    capabilities: { localProposal: true },
    viewInfo: { name: String(options.name).slice(0, 120), version: String(options.version).slice(0, 40) },
  }).then((result) => {
    const init = result as {
      protocolVersion?: unknown;
      capabilities?: { localProposal?: unknown };
      envelope?: AgentUiEnvelope;
    };
    if (
      !init ||
      init.protocolVersion !== AGENT_UI_PROFILE ||
      init.capabilities?.localProposal !== true ||
      !init.envelope ||
      init.envelope.profile !== AGENT_UI_PROFILE
    )
      throw new Error('Host refused the Agent UI profile');
    notify('haip/ui.initialized', {});
    const envelope = Object.freeze(init.envelope);
    return {
      envelope,
      propose: (candidate: Proposal) => request('haip/ui.propose', candidate),
    };
  });
}
