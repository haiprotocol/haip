import { canonicalise, parseJson } from '@haip/protocol/json';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let csrf = '',
  requestId = location.pathname.split('/')[2],
  candidate: Record<string, unknown> | undefined;
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
async function propose(body: unknown) {
  candidate = await api(`/v2/requests/${requestId}/candidates`, body);
  write('exact', {
    request_id: requestId,
    request_digest: candidate!.request_digest,
    decision: candidate!.decision,
    response: candidate!.response,
  });
  el('confirmation').hidden = false;
  el<HTMLButtonElement>('confirm').disabled = false;
  el('confirmation').scrollIntoView({ behavior: 'smooth' });
  return { candidate_id: candidate!.id, status: 'awaiting_human_confirmation' };
}
async function status() {
  const s = await api(`/v2/requests/${requestId}`);
  write(
    'status',
    `Decision: ${s.decision_state} · Audit: ${s.audit_state} · Grant: ${s.grant_state} · Execution: ${s.execution_state}`,
  );
  write('receipt', s.receipt ?? 'No confirmed decision.');
  el('proposal').hidden = s.decision_state !== 'pending';
  el('assign').hidden = s.decision_state !== 'pending';
  if (s.decision_state !== 'pending') el('confirmation').hidden = true;
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
async function app() {
  const stored = await api(`/v2/requests/${requestId}/app`);
  const frame = document.createElement('iframe');
  frame.title = 'Producer app — cannot confirm decisions';
  frame.sandbox.add('allow-scripts', 'allow-same-origin');
  frame.src = stored.origin + '/sandbox/' + stored.scope + '?instance=' + crypto.randomUUID();
  el('app').append(frame);
  const origin = new URL(stored.origin).origin;
  let started = false,
    sent = false,
    loaded = false;
  const transport: Transport = {
    start: async () => {
      if (started) throw new Error('Bridge already started');
      started = true;
      window.addEventListener('message', receive);
    },
    send: async (message) => {
      frame.contentWindow!.postMessage(message, origin);
    },
    close: async () => {
      window.removeEventListener('message', receive);
      frame.remove();
    },
  };
  function receive(event: MessageEvent) {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      !event.data ||
      typeof event.data !== 'object'
    )
      return;
    transport.onmessage?.(event.data);
  }
  const bridge = new AppBridge(
    null,
    { name: 'HAIP review host', version: '2.0.0-draft.1' },
    { serverTools: {} },
  );
  bridge.onsandboxready = async () => {
    if (loaded) return;
    loaded = true;
    await bridge.sendSandboxResourceReady({ html: stored.html, sandbox: 'allow-scripts' });
  };
  bridge.oninitialized = async () => {
    if (sent) throw new Error('Duplicate app initialisation');
    sent = true;
    await bridge.sendToolInput({ arguments: stored.input });
    await bridge.sendToolResult(stored.result);
    write(
      'app-state',
      'Stored input and result delivered once. Use the trusted host below to confirm.',
    );
  };
  bridge.oncalltool = async (params) => {
    if (params.name !== 'haip_propose_decision' || !sent)
      throw new Error('Forbidden host operation');
    const result = await propose(params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };
  bridge.onreadresource = async () => {
    throw new Error('No live resources');
  };
  bridge.onopenlink = async () => {
    throw new Error('App navigation is forbidden');
  };
  bridge.onerror = () => write('app-state', 'App unavailable. Use the trusted host response form.');
  await bridge.connect(transport);
  window.addEventListener('pagehide', () => void bridge.close(), { once: true });
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
  el('proposal').onsubmit = (e) => {
    e.preventDefault();
    void Promise.resolve()
      .then(() =>
        propose({
          decision: select.value,
          response: parseJson(el<HTMLTextAreaElement>('response').value),
        }),
      )
      .catch(showError);
  };
  el('confirm').onclick = () => {
    void (async () => {
      if (!candidate) return;
      el<HTMLButtonElement>('confirm').disabled = true;
      await api(`/v2/requests/${requestId}/confirm`, {
        candidate_id: candidate.id,
        candidate_digest: await hash(candidate),
      });
      el('confirmation').hidden = true;
      await status();
    })().catch(showError);
  };
  el('assign').onclick = () => {
    void api(`/v2/requests/${requestId}/assignment`, {})
      .then(() => write('status', 'Assigned to you for up to five minutes.'))
      .catch(showError);
  };
  await status();
  if (r.review.bundle)
    void app().catch(() =>
      write('app-state', 'App unavailable. Use the trusted host response form.'),
    );
})().catch((error) => {
  if (error.message === 'unauthenticated')
    location.href = '/auth/login?return_to=' + encodeURIComponent(location.pathname);
  else showError(error);
});
