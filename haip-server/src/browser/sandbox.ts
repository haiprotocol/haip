// The outer frame runs only this trusted proxy. Producer code runs in the opaque inner frame.
const hostOrigin = '__HAIP_HOST_ORIGIN__';
let inner: HTMLIFrameElement | undefined,
  initialiseId: string | number | undefined,
  initialiseAccepted = false,
  notified = false,
  failed = false;
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_HOST_MESSAGE_BYTES = 6 * 1_048_576;
const pendingHostRequests = new Set<string | number>();
const requestId = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
const envelope = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && (value as any).jsonrpc === '2.0';
const jsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => jsonValue(item, depth + 1))
  );
};
const boundedEnvelope = (
  value: unknown,
  maximum = MAX_MESSAGE_BYTES,
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
        typeof message.error === 'object' &&
        !Array.isArray(message.error) &&
        Number.isSafeInteger(message.error.code) &&
        typeof message.error.message === 'string'))
  );
}
function send(data: unknown) {
  parent.postMessage(data, hostOrigin);
}
function failView(reason: string) {
  if (failed) return;
  failed = true;
  initialiseId = undefined;
  initialiseAccepted = false;
  notified = false;
  pendingHostRequests.clear();
  inner?.remove();
  inner = undefined;
  send({
    jsonrpc: '2.0',
    method: 'haip/ui.viewFailed',
    params: { reason: reason.slice(0, 160) },
  });
}
const VIEW_TO_HOST = new Set([
  'haip/ui.initialize',
  'haip/ui.initialized',
  'haip/ui.propose',
]);
const HOST_TO_VIEW = new Set([
  'haip/ui.resourceReady',
  'haip/ui.input',
  'haip/ui.result',
  'haip/ui.teardown',
]);
window.addEventListener('message', (event) => {
  if (event.source === parent && event.origin === hostOrigin) {
    const message = event.data;
    if (!boundedEnvelope(message, MAX_HOST_MESSAGE_BYTES)) {
      if (inner) failView('invalid host message');
      return;
    }
    if (message?.method === 'haip/ui.resourceReady') {
      if (inner || failed || typeof message.params?.html !== 'string') return;
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
    if (response(message) && message.id === initialiseId)
      initialiseAccepted = Object.hasOwn(message, 'result');
    // Only forward normative host→view methods and JSON-RPC responses.
    if (message.method !== undefined && !HOST_TO_VIEW.has(message.method) && !response(message))
      return;
    if (typeof message.method === 'string' && requestId(message.id))
      pendingHostRequests.add(message.id);
    inner.contentWindow?.postMessage(message, '*');
  } else if (inner && event.source === inner.contentWindow && event.origin === 'null') {
    const message = event.data;
    if (!envelope(message) || !jsonValue(message)) return;
    if (encodedBytes(message) > MAX_MESSAGE_BYTES) {
      failView('oversized renderer message');
      return;
    }
    if (!Object.hasOwn(message, 'method')) {
      // JSON-RPC responses have no method. Only a matching, still-outstanding host request
      // permits one response; unsolicited, malformed and replayed replies never reach the host.
      if (!response(message) || !pendingHostRequests.delete(message.id)) return;
      send(message);
      return;
    }
    if (
      typeof message.method !== 'string' ||
      !message.method ||
      Object.hasOwn(message, 'result') ||
      Object.hasOwn(message, 'error')
    )
      return;
    if (message.method === 'haip/ui.initialize') {
      if (initialiseId !== undefined || !requestId(message.id)) return;
      initialiseId = message.id;
      send(message);
      return;
    }
    if (!initialiseAccepted) return;
    if (message.method === 'haip/ui.initialized') {
      if (notified || Object.hasOwn(message, 'id')) return;
      notified = true;
      send(message);
      return;
    }
    if (!notified) return;
    if (!VIEW_TO_HOST.has(message.method)) {
      if (requestId(message.id))
        inner.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Forbidden host operation' },
          },
          '*',
        );
      return;
    }
    if (message.method === 'haip/ui.propose' && !requestId(message.id)) return;
    send(message);
  }
});
window.addEventListener(
  'DOMContentLoaded',
  () => send({ jsonrpc: '2.0', method: 'haip/ui.proxyReady', params: {} }),
  { once: true },
);
