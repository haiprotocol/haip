// Native HAIP Agent UI View using the @haip/view client. No MCP Apps client.
import { connectView } from '@haip/view';

document.body.innerHTML = `
  <style>body{font:16px/1.5 system-ui;padding:24px;color:#172b39;background:#fff}label{display:block;margin:20px 0}select,button{font:inherit;padding:10px}button{background:#f6d279;border:1px solid #aab9bf;border-radius:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
  <h1>Choose a support response</h1>
  <p>This app proposes your choice. Confirm it separately in the trusted HAIP host.</p>
  <details><summary>Stored review payload</summary><pre id="stored">Waiting for the host…</pre></details>
  <p id="envelope"></p>
  <div><label>Your choice <select id="choice">
    <option value="">Choose a response</option><option value="accept">Accept</option><option value="decline">Decline</option>
  </select></label><button type="button" id="propose">Propose choice</button></div>
  <p id="feedback" role="status"></p>`;

const probe = window.__HAIP_TEST_PROBE__
  ? (window.probe = { inputs: 0, results: 0, storage: false, forbidden: false })
  : undefined;

const view = await connectView({
  name: 'Independent choice review',
  version: '1.0.0',
  onInput: () => {
    if (probe) probe.inputs++;
  },
  onResult: (result) => {
    if (probe) probe.results++;
    document.querySelector('#stored').textContent = JSON.stringify(
      result?.structuredContent?.payload ?? result?.content ?? result,
      null,
      2,
    );
  },
});
document.querySelector('#envelope').textContent =
  `Request ${view.envelope.request.id} · bundle ${view.envelope.bundle.digest.slice(0, 19)}… · binding ${view.envelope.binding_digest.slice(0, 19)}…`;

document.querySelector('#propose').onclick = async () => {
  const choice = document.querySelector('#choice').value;
  if (!['accept', 'decline'].includes(choice)) {
    document.querySelector('#feedback').textContent = 'Choose a response first.';
    return;
  }
  try {
    await view.propose({ decision: 'answer', response: { choice } });
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
  // A foreign tool-call shape must be refused by the host; the client offers no such call.
  probe.forbidden = await new Promise((resolve) => {
    const id = 'probe-forbidden';
    const onMessage = (event) => {
      if (event.source !== parent || event.data?.id !== id) return;
      window.removeEventListener('message', onMessage);
      resolve(Boolean(event.data.error));
    };
    window.addEventListener('message', onMessage);
    parent.postMessage(
      {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'unavailable_tool', arguments: {} },
      },
      '*',
    );
    setTimeout(() => resolve(false), 5000);
  });
}
