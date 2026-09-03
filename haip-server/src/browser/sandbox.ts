import { AGENT_UI_LIMITS, AGENT_UI_PROFILE } from '@haip/protocol';

// The outer frame runs only this trusted proxy. Producer code runs in the opaque inner frame.
const hostOrigin = '__HAIP_HOST_ORIGIN__';
let inner: HTMLIFrameElement | undefined,
  initialiseId: string | number | undefined,
  initialiseAnswered = false,
  initialiseAccepted = false,
  notified = false,
  inputForwarded = false,
  snapshotsForwarded = false,
  proposalsSeen = 0,
  failed = false;
const MAX_MESSAGE_BYTES = AGENT_UI_LIMITS.view_message_bytes;
const MAX_HOST_MESSAGE_BYTES = AGENT_UI_LIMITS.host_message_bytes;
const pendingHostRequests = new Set<string | number>();
const pendingViewRequests = new Set<string | number>();
const usedViewRequestIds = new Set<string | number>();
const requestId = (value: unknown): value is string | number =>
  (typeof value === 'string' &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= AGENT_UI_LIMITS.request_id_codepoints) ||
  (typeof value === 'number' && Number.isSafeInteger(value));
const envelope = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && (value as any).jsonrpc === '2.0';
const exact = (value: unknown, keys: string[]): value is Record<string, any> =>
  envelope(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const exactObject = (value: unknown, keys: string[]): value is Record<string, any> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
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
  const prototype = Object.getPrototypeOf(value);
  const valid =
    (prototype === Object.prototype || prototype === null) &&
    Object.entries(value).every(
      ([key, item]) => wellFormed(key) && jsonValue(item, depth + 1, ancestors),
    );
  ancestors.delete(value);
  return valid;
};
const boundedEnvelope = (
  value: unknown,
  maximum: number = MAX_MESSAGE_BYTES,
): value is Record<string, any> => {
  if (!envelope(value) || !jsonValue(value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
  } catch {
    return false;
  }
};
const encodedBytes = (value: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
function response(message: Record<string, any>) {
  if (
    !requestId(message.id) ||
    Object.keys(message).some((key) => !['jsonrpc', 'id', 'result', 'error'].includes(key))
  )
    return false;
  const result = Object.hasOwn(message, 'result'),
    error = Object.hasOwn(message, 'error');
  return (
    result !== error &&
    ((result && jsonValue(message.result)) ||
      (message.error &&
        exactObject(message.error, ['code', 'message']) &&
        [-32600, -32601, -32602, -32000].includes(message.error.code) &&
        typeof message.error.message === 'string' &&
        Array.from(message.error.message).length <= AGENT_UI_LIMITS.error_message_codepoints))
  );
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function initializeParams(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.hasOwn(value, 'viewInfo')
    ? ['protocolVersion', 'capabilities', 'viewInfo']
    : ['protocolVersion', 'capabilities'];
  if (
    !exactObject(value, keys) ||
    value.protocolVersion !== AGENT_UI_PROFILE ||
    !exactObject(value.capabilities, ['localProposal']) ||
    value.capabilities.localProposal !== true
  )
    return false;
  if (value.viewInfo === undefined) return true;
  return (
    exactObject(value.viewInfo, ['name', 'version']) &&
    typeof value.viewInfo.name === 'string' &&
    Array.from(value.viewInfo.name).length >= 1 &&
    Array.from(value.viewInfo.name).length <= AGENT_UI_LIMITS.view_name_codepoints &&
    typeof value.viewInfo.version === 'string' &&
    Array.from(value.viewInfo.version).length >= 1 &&
    Array.from(value.viewInfo.version).length <= AGENT_UI_LIMITS.view_version_codepoints
  );
}
const proposal = (value: unknown) =>
  exactObject(value, ['decision', 'response']) &&
  typeof value.decision === 'string' &&
  ['answer', 'approve', 'reject', 'authorise', 'refuse'].includes(value.decision) &&
  jsonValue(value.response);
const input = (value: unknown) =>
  exactObject(value, ['request_id', 'purpose']) &&
  typeof value.request_id === 'string' &&
  UUID.test(value.request_id) &&
  ['review', 'authorise_execution'].includes(value.purpose);
const result = (value: unknown) =>
  exactObject(value, ['content', 'structuredContent']) &&
  Array.isArray(value.content) &&
  value.content.every(
    (item: unknown) =>
      exactObject(item, ['type', 'text']) && item.type === 'text' && typeof item.text === 'string',
  ) &&
  exactObject(value.structuredContent, ['payload']) &&
  jsonValue(value.structuredContent.payload);
function hostMethod(message: Record<string, any>) {
  switch (message.method) {
    case 'haip/ui.resourceReady':
      return (
        exact(message, ['jsonrpc', 'method', 'params']) &&
        exactObject(message.params, ['html', 'sandbox']) &&
        typeof message.params.html === 'string' &&
        message.params.sandbox === 'allow-scripts'
      );
    case 'haip/ui.input':
      return exact(message, ['jsonrpc', 'method', 'params']) && input(message.params);
    case 'haip/ui.result':
      return exact(message, ['jsonrpc', 'method', 'params']) && result(message.params);
    case 'haip/ui.teardown':
      return (
        exact(message, ['jsonrpc', 'id', 'method', 'params']) &&
        requestId(message.id) &&
        exactObject(message.params, [])
      );
    default:
      return false;
  }
}
function send(data: unknown) {
  parent.postMessage(data, hostOrigin);
}
function failView(reason: string) {
  if (failed) return;
  failed = true;
  initialiseId = undefined;
  initialiseAnswered = false;
  initialiseAccepted = false;
  notified = false;
  inputForwarded = false;
  snapshotsForwarded = false;
  proposalsSeen = 0;
  pendingHostRequests.clear();
  pendingViewRequests.clear();
  usedViewRequestIds.clear();
  inner?.remove();
  inner = undefined;
  send({
    jsonrpc: '2.0',
    method: 'haip/ui.viewFailed',
    params: {
      reason: Array.from(reason).slice(0, AGENT_UI_LIMITS.failure_reason_codepoints).join(''),
    },
  });
}
function viewError(id: string | number, code: -32600 | -32601 | -32602, message: string) {
  inner?.contentWindow?.postMessage({ jsonrpc: '2.0', id, error: { code, message } }, '*');
}
function reserveViewRequest(id: string | number) {
  if (usedViewRequestIds.has(id)) {
    viewError(id, -32600, 'Replay or duplicate request id');
    return false;
  }
  usedViewRequestIds.add(id);
  if (usedViewRequestIds.size > AGENT_UI_LIMITS.tracked_view_request_ids) {
    failView('request id budget exhausted');
    return false;
  }
  return true;
}
function rejectLifecycleRequest(message: Record<string, any>, reason: string) {
  if (!requestId(message.id) || !reserveViewRequest(message.id)) return;
  if (message.method === 'haip/ui.propose') {
    if (++proposalsSeen > AGENT_UI_LIMITS.proposals_per_view) {
      failView('proposal budget exhausted');
      return;
    }
  }
  viewError(message.id, -32600, reason);
}
const VIEW_TO_HOST = new Set(['haip/ui.initialize', 'haip/ui.initialized', 'haip/ui.propose']);
window.addEventListener('message', (event) => {
  if (event.source === parent && event.origin === hostOrigin) {
    const message = event.data;
    if (!boundedEnvelope(message, MAX_HOST_MESSAGE_BYTES)) {
      if (inner) failView('invalid host message');
      return;
    }
    if (message?.method === 'haip/ui.resourceReady') {
      if (!hostMethod(message)) {
        failView('invalid resource message');
        return;
      }
      if (inner || failed) return;
      inner = document.createElement('iframe');
      inner.setAttribute('sandbox', 'allow-scripts');
      inner.setAttribute('referrerpolicy', 'no-referrer');
      let loads = 0;
      inner.addEventListener('load', () => {
        if (++loads > 1) failView('renderer navigated or reloaded');
      });
      inner.addEventListener('error', () => failView('renderer failed'));
      inner.srcdoc = message.params.html;
      document.body.appendChild(inner);
      return;
    }
    if (!inner) return;
    const isResponse = response(message);
    if (!isResponse && !hostMethod(message)) {
      failView('invalid host message');
      return;
    }
    if (isResponse) {
      if (message.id === initialiseId && !initialiseAnswered) {
        initialiseAnswered = true;
        initialiseAccepted = Object.hasOwn(message, 'result');
      } else if (!pendingViewRequests.delete(message.id)) {
        failView('uncorrelated host response');
        return;
      }
    } else if (message.method === 'haip/ui.input') {
      if (!initialiseAccepted || !notified || inputForwarded) {
        failView('invalid input lifecycle');
        return;
      }
      inputForwarded = true;
    } else if (message.method === 'haip/ui.result') {
      if (!inputForwarded || snapshotsForwarded) {
        failView('invalid result lifecycle');
        return;
      }
      snapshotsForwarded = true;
    }
    if (message.method === 'haip/ui.teardown' && requestId(message.id))
      pendingHostRequests.add(message.id);
    inner.contentWindow?.postMessage(message, '*');
  } else if (inner && event.source === inner.contentWindow && event.origin === 'null') {
    const message = event.data;
    if (!envelope(message) || !jsonValue(message)) {
      failView('invalid renderer message');
      return;
    }
    if (encodedBytes(message) > MAX_MESSAGE_BYTES) {
      failView('oversized renderer message');
      return;
    }
    if (!Object.hasOwn(message, 'method')) {
      // JSON-RPC responses have no method. Only a matching, still-outstanding host request
      // permits one response; unsolicited, malformed and replayed replies never reach the host.
      if (!requestId(message.id) || !pendingHostRequests.has(message.id)) return;
      if (
        !response(message) ||
        (Object.hasOwn(message, 'result') &&
          (!exactObject(message.result, ['closed']) || message.result.closed !== true))
      ) {
        failView('invalid teardown acknowledgement');
        return;
      }
      pendingHostRequests.delete(message.id);
      send(message);
      return;
    }
    if (
      typeof message.method !== 'string' ||
      !message.method ||
      Object.hasOwn(message, 'result') ||
      Object.hasOwn(message, 'error')
    ) {
      rejectLifecycleRequest(message, 'Invalid Agent UI request');
      return;
    }
    if (message.method === 'haip/ui.initialize') {
      if (!requestId(message.id)) return;
      if (initialiseId !== undefined) {
        if (reserveViewRequest(message.id)) failView('duplicate initialisation');
        return;
      }
      if (
        !exact(message, ['jsonrpc', 'id', 'method', 'params']) ||
        !initializeParams(message.params)
      ) {
        if (reserveViewRequest(message.id)) failView('unsupported Agent UI profile');
        return;
      }
      if (!reserveViewRequest(message.id)) return;
      initialiseId = message.id;
      send(message);
      return;
    }
    if (!initialiseAccepted) {
      rejectLifecycleRequest(message, 'Initialisation incomplete');
      return;
    }
    if (message.method === 'haip/ui.initialized') {
      if (
        notified ||
        !exact(message, ['jsonrpc', 'method', 'params']) ||
        !exactObject(message.params, [])
      )
        return;
      notified = true;
      send(message);
      return;
    }
    if (!notified) {
      rejectLifecycleRequest(message, 'Initialisation incomplete');
      return;
    }
    if (!VIEW_TO_HOST.has(message.method)) {
      if (requestId(message.id) && reserveViewRequest(message.id))
        viewError(message.id, -32601, 'Forbidden host operation');
      return;
    }
    if (message.method === 'haip/ui.propose') {
      if (!requestId(message.id) || !reserveViewRequest(message.id)) return;
      if (++proposalsSeen > AGENT_UI_LIMITS.proposals_per_view) {
        failView('proposal budget exhausted');
        return;
      }
      if (
        !snapshotsForwarded ||
        !exact(message, ['jsonrpc', 'id', 'method', 'params']) ||
        !proposal(message.params)
      ) {
        viewError(message.id, -32602, 'Invalid proposal');
        return;
      }
      pendingViewRequests.add(message.id);
    }
    send(message);
  }
});
window.addEventListener(
  'DOMContentLoaded',
  () => send({ jsonrpc: '2.0', method: 'haip/ui.proxyReady', params: {} }),
  { once: true },
);
