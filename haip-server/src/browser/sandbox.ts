// The outer frame runs only this trusted proxy. Producer code runs in the opaque inner frame.
const hostOrigin = '__HAIP_HOST_ORIGIN__';
let inner: HTMLIFrameElement | undefined,
  initialised = false,
  notified = false;
function send(data: unknown) {
  parent.postMessage(data, hostOrigin);
}
window.addEventListener('message', (event) => {
  if (event.source === parent && event.origin === hostOrigin) {
    const message = event.data;
    if (message?.method === 'ui/notifications/sandbox-resource-ready') {
      if (inner || typeof message.params?.html !== 'string') return;
      inner = document.createElement('iframe');
      inner.setAttribute('sandbox', 'allow-scripts');
      inner.setAttribute('referrerpolicy', 'no-referrer');
      inner.srcdoc = message.params.html;
      document.body.appendChild(inner);
      return;
    }
    if (inner) inner.contentWindow?.postMessage(message, '*');
  } else if (inner && event.source === inner.contentWindow && event.origin === 'null') {
    const message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    if (message.method === 'ui/initialize') {
      if (initialised) return;
      initialised = true;
    }
    if (!initialised) return;
    if (message.method === 'ui/notifications/initialized') {
      if (notified) return;
      notified = true;
    }
    const allowed = new Set([
      'ui/initialize',
      'ui/notifications/initialized',
      'ui/notifications/size-changed',
      'tools/call',
    ]);
    if (message.method && !allowed.has(message.method)) {
      if (message.id !== undefined)
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
    if (message.method === 'tools/call' && message.params?.name !== 'haip_propose_decision') {
      inner.contentWindow?.postMessage(
        { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Forbidden tool' } },
        '*',
      );
      return;
    }
    send(message);
  }
});
window.addEventListener(
  'DOMContentLoaded',
  () => send({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }),
  { once: true },
);
