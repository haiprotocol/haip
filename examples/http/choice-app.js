import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Independent choice review', version: '1.0.0' }, {});
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
  ? (window.probe = { inputs: 0, results: 0, storage: false })
  : undefined;
app.ontoolinput = () => {
  if (probe) probe.inputs++;
};
app.ontoolresult = (result) => {
  if (probe) probe.results++;
  document.querySelector('#stored').textContent = JSON.stringify(
    result.structuredContent?.payload ?? result.content,
    null,
    2,
  );
};
await app.connect();
document.querySelector('#propose').onclick = async () => {
  const choice = document.querySelector('#choice').value;
  if (!['accept', 'decline'].includes(choice)) {
    document.querySelector('#feedback').textContent = 'Choose a response first.';
    return;
  }
  try {
    await app.callServerTool({
      name: 'haip_propose_decision',
      arguments: {
      decision: 'answer',
      response: { choice },
      },
    });
    document.querySelector('#feedback').textContent =
      'Choice proposed. Check and confirm it in the trusted host.';
  } catch {
    document.querySelector('#feedback').textContent =
      'Proposal unavailable. Check the request status in the trusted host.';
  }
};
// Only the browser acceptance fixture enables adversarial probes.
if (probe) {
  try {
    localStorage.setItem('secret', 'x');
    probe.storage = true;
  } catch {}
  probe.forbidden = await app.callServerTool({ name: 'unavailable_tool', arguments: {} }).then(
    () => false,
    () => true,
  );
}
