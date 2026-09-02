// The outer frame runs only this trusted proxy. Producer code runs in the opaque inner frame.
const hostOrigin = '__HAIP_HOST_ORIGIN__';
let inner: HTMLIFrameElement | undefined,
  initialiseId: string | number | undefined,
  initialiseAccepted = false,
  notified = false;
const pendingHostRequests = new Set<string | number>();
const requestId = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
const envelope = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && (value as any).jsonrpc === '2.0';
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
    ((result &&
      message.result &&
      typeof message.result === 'object' &&
      !Array.isArray(message.result)) ||
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
    if (!envelope(message)) return;
    if (message?.method === 'haip/ui.resourceReady') {
      if (inner || typeof message.params?.html !== 'string') return;
      inner = document.createElement('iframe');
      inner.setAttribute('sandbox', 'allow-scripts');
      inner.setAttribute('referrerpolicy', 'no-referrer');
      inner.srcdoc = message.params.html;
      document.body.appendChild(inner);
      return;
    }
    if (!inner) return;
    if (typeof message.method === 'string' && requestId(message.id))
      pendingHostRequests.add(message.id);
    if (response(message) && message.id === initialiseId)
      initialiseAccepted = Object.hasOwn(message, 'result');
    // Only forward normative host→view methods and JSON-RPC responses.
    if (message.method !== undefined && !HOST_TO_VIEW.has(message.method) && !response(message))
      return;
    inner.contentWindow?.postMessage(message, '*');
  } else if (inner && event.source === inner.contentWindow && event.origin === 'null') {
    const message = event.data;
    if (!envelope(message)) return;
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
