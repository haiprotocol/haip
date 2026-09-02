// Native HAIP Agent UI View — no MCP Apps client.
document.body.innerHTML = `
  <style>body{font:16px/1.5 system-ui;padding:24px;color:#172b39;background:#fff}label{display:block;margin:20px 0}select,button{font:inherit;padding:10px}button{background:#f6d279;border:1px solid #aab9bf;border-radius:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
  <h1>Choose a support response</h1>
  <p>This app proposes your choice. Confirm it separately in the trusted HAIP host.</p>
  <details><summary>Stored review payload</summary><pre id="stored">Waiting for the host…</pre></details>
  <div><label>Your choice <select id="choice">
    <option value="">Choose a response</option><option value="accept">Accept</option><option value="decline">Decline</option>
  </select></label><button type="button" id="propose">Propose choice</button></div>
  <p id="feedback" role="status"></p>`;

const probe = window.__HAIP_TEST_PROBE__
  ? (window.probe = { inputs: 0, results: 0, storage: false, forbidden: false })
  : undefined;

let nextId = 1;
const pending = new Map();
let inputSeen = false;
let resultSeen = false;

function post(message) {
  parent.postMessage(message, '*');
}
function request(method, params) {
  const id = nextId++;
  const wait = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  post({ jsonrpc: '2.0', id, method, params });
  return wait;
}
function notify(method, params) {
  post({ jsonrpc: '2.0', method, params });
}

window.addEventListener('message', (event) => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  const message = event.data;
  if (message.jsonrpc !== '2.0') return;
  if (!('method' in message) || message.method === undefined) {
    if (message.id === undefined || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === 'haip/ui.input') {
    if (inputSeen) return;
    inputSeen = true;
    if (probe) probe.inputs++;
    return;
  }
  if (message.method === 'haip/ui.result') {
    if (resultSeen || !inputSeen) return;
    resultSeen = true;
    if (probe) probe.results++;
    document.querySelector('#stored').textContent = JSON.stringify(
      message.params?.structuredContent?.payload ?? message.params?.content ?? message.params,
      null,
      2,
    );
    return;
  }
  if (message.method === 'haip/ui.teardown') {
    if (message.id !== undefined)
      post({ jsonrpc: '2.0', id: message.id, result: { closed: true } });
  }
});

const init = await request('haip/ui.initialize', {
  protocolVersion: 'org.haiprotocol.agent-ui/1',
  capabilities: { localProposal: true },
  viewInfo: { name: 'Independent choice review', version: '1.0.0' },
});
if (!init?.capabilities?.localProposal) throw new Error('Host refused localProposal');
notify('haip/ui.initialized', {});

document.querySelector('#propose').onclick = async () => {
  const choice = document.querySelector('#choice').value;
  if (!['accept', 'decline'].includes(choice)) {
    document.querySelector('#feedback').textContent = 'Choose a response first.';
    return;
  }
  try {
    await request('haip/ui.propose', {
      decision: 'answer',
      response: { choice },
    });
    document.querySelector('#feedback').textContent =
      'Choice proposed. Check and confirm it in the trusted host.';
  } catch {
    document.querySelector('#feedback').textContent =
      'Proposal unavailable. Check the request status in the trusted host.';
  }
};

if (probe) {
  try {
    localStorage.setItem('secret', 'x');
    probe.storage = true;
  } catch {}
  // Forbidden residual tool-call shape must not succeed.
  probe.forbidden = await request('tools/call', { // foreign method must fail
    name: 'unavailable_tool',
    arguments: {},
  }).then(
    () => false,
    () => true,
  );
}
