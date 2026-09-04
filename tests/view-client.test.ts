import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_UI_LIFECYCLE,
  AGENT_UI_LIMITS,
  AGENT_UI_PROFILE,
  PROTOCOL_REVISION,
  connectView,
} from '../haip-view/src/index.js';
import { invalidAgentUiOrigins, validAgentUiOrigins } from './agent-ui-origin-vectors.js';

const SANDBOX_ORIGIN = 'https://sandbox.example';

function envelope(revision = PROTOCOL_REVISION, origin = SANDBOX_ORIGIN) {
  return {
    profile: AGENT_UI_PROFILE,
    protocol_revision: revision,
    request: {
      id: '8fd7d8b9-8e62-4422-9e40-15d2d745f35b',
      digest: 'sha256:' + '1'.repeat(64),
      purpose: 'review',
      authorisation_revision: 1,
      supersedes: null,
    },
    bundle: {
      id: 'bundle:choice',
      publisher: 'publisher',
      digest: 'sha256:' + '2'.repeat(64),
      created_at: '2026-09-03T00:00:00.000Z',
    },
    source: {
      tenant: 'tenant',
      producer: 'producer',
      requester: { subject: 'owner', source: 'operator_directory' },
      origin,
    },
    snapshots: {
      input_digest: 'sha256:' + '3'.repeat(64),
      result_digest: 'sha256:' + '4'.repeat(64),
    },
    binding_digest: 'sha256:' + '5'.repeat(64),
  };
}

function harness() {
  const messages: any[] = [];
  const targets: string[] = [];
  const listeners = new Set<(event: any) => void>();
  const parent = {
    postMessage: (message: unknown, targetOrigin: string) => {
      messages.push(message);
      targets.push(targetOrigin);
    },
  };
  const fakeWindow = {
    parent,
    addEventListener: (type: string, listener: (event: any) => void) => {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      if (type === 'message') listeners.delete(listener);
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  return {
    messages,
    targets,
    listeners,
    deliver(data: unknown, source: unknown = parent, origin = SANDBOX_ORIGIN) {
      for (const listener of [...listeners]) listener({ source, origin, data });
    },
    restore() {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete (globalThis as any).window;
    },
  };
}

function initialise(h: ReturnType<typeof harness>, value = envelope()) {
  const connected = connectView({ name: 'Choice', version: '1.0.0' });
  const request = h.messages.shift();
  assert.equal(request.method, 'haip/ui.initialize');
  h.deliver(
    {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: AGENT_UI_PROFILE,
        capabilities: { localProposal: true },
        hostInfo: { name: 'HAIP review host', version: PROTOCOL_REVISION },
        envelope: value,
        limits: AGENT_UI_LIMITS,
        lifecycle: AGENT_UI_LIFECYCLE,
      },
    },
    undefined,
    value.source.origin,
  );
  return connected;
}

function nested(levels: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < levels; index++) value = { value };
  return value;
}

async function readyView(h: ReturnType<typeof harness>) {
  const view = await initialise(h);
  h.messages.length = 0;
  h.targets.length = 0;
  h.deliver({
    jsonrpc: '2.0',
    method: 'haip/ui.input',
    params: { request_id: view.envelope.request.id, purpose: 'review' },
  });
  h.deliver({
    jsonrpc: '2.0',
    method: 'haip/ui.result',
    params: { content: [], structuredContent: { payload: null } },
  });
  return view;
}

test('@haip/view validates the envelope, proposal result and terminal teardown', async (t) => {
  const h = harness();
  t.after(() => h.restore());
  let inputs = 0;
  let results = 0;
  let teardowns = 0;
  const connected = connectView({
    name: 'Choice',
    version: '1.0.0',
    onInput: (input) => {
      inputs++;
      assert.ok(Object.isFrozen(input));
    },
    onResult: (result) => {
      results++;
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.content));
      assert.ok(Object.isFrozen(result.structuredContent));
    },
    onTeardown: () => teardowns++,
  });
  const init = h.messages.shift();
  assert.equal(h.targets.shift(), '*');
  h.deliver({
    jsonrpc: '2.0',
    id: init.id,
    result: {
      protocolVersion: AGENT_UI_PROFILE,
      capabilities: { localProposal: true },
      hostInfo: { name: 'HAIP review host', version: PROTOCOL_REVISION },
      envelope: envelope(),
      limits: AGENT_UI_LIMITS,
      lifecycle: AGENT_UI_LIFECYCLE,
    },
  });
  const view = await connected;
  assert.deepEqual(h.messages.shift(), {
    jsonrpc: '2.0',
    method: 'haip/ui.initialized',
    params: {},
  });
  assert.equal(h.targets.shift(), SANDBOX_ORIGIN);
  assert.ok(Object.isFrozen(view.envelope));
  assert.ok(Object.isFrozen(view.envelope.request));
  assert.throws(() => ((view.envelope.request as any).id = 'changed'), TypeError);
  h.deliver({ jsonrpc: '2.0', id: 'unknown', method: 'haip/ui.unknown', params: {} });
  assert.deepEqual(h.messages.shift(), {
    jsonrpc: '2.0',
    id: 'unknown',
    error: { code: -32601, message: 'Forbidden host operation' },
  });
  h.deliver({
    jsonrpc: '2.0',
    method: 'haip/ui.input',
    params: { request_id: view.envelope.request.id, purpose: 'review' },
  });
  await assert.rejects(
    view.propose({ decision: 'answer', response: { choice: 'early' } }),
    /Snapshots not ready/,
  );
  h.deliver({
    jsonrpc: '2.0',
    method: 'haip/ui.result',
    params: { content: [], structuredContent: { payload: null } },
  });
  assert.equal(inputs, 1);
  assert.equal(results, 1);

  const proposed = view.propose({ decision: 'answer', response: { choice: 'accept' } });
  const proposal = h.messages.shift();
  h.deliver({
    jsonrpc: '2.0',
    id: proposal.id,
    result: { candidate_id: 'candidate', status: 'awaiting_human_confirmation' },
  });
  assert.deepEqual(await proposed, {
    candidate_id: 'candidate',
    status: 'awaiting_human_confirmation',
  });

  const pending = view.propose({ decision: 'answer', response: { choice: 'decline' } });
  h.messages.shift();
  h.deliver({ jsonrpc: '2.0', id: 'close', method: 'haip/ui.teardown', params: {} });
  assert.deepEqual(h.messages.shift(), { jsonrpc: '2.0', id: 'close', result: { closed: true } });
  await assert.rejects(pending, /Host closed/);
  await assert.rejects(view.propose({ decision: 'answer', response: null }), /View closed/);
  assert.equal(teardowns, 1);
  assert.equal(h.listeners.size, 0);
});

test('@haip/view rejects the wrong protocol revision and invalid proposals', async (t) => {
  const wrong = harness();
  t.after(() => wrong.restore());
  await assert.rejects(initialise(wrong, envelope('2.0.0-draft.1') as any), /Host refused/);
  assert.equal(wrong.listeners.size, 0);

  wrong.restore();
  const h = harness();
  t.after(() => h.restore());
  const view = await initialise(h);
  h.messages.shift();
  h.deliver({
    jsonrpc: '2.0',
    method: 'haip/ui.input',
    params: { request_id: view.envelope.request.id, purpose: 'review' },
  });
  h.deliver({
    jsonrpc: '2.0',
    method: 'haip/ui.result',
    params: { content: [], structuredContent: { payload: null } },
  });
  const before = h.messages.length;
  await assert.rejects(
    (view as any).propose({ decision: 'launch', response: null }),
    /Invalid proposal/,
  );
  const cyclic: any = { decision: 'answer', response: {} };
  cyclic.response.self = cyclic.response;
  await assert.rejects((view as any).propose(cyclic), /Invalid proposal/);
  assert.equal(h.messages.length, before);
  const arrayProposal = view.propose({
    decision: 'answer',
    response: ['accept', 1, true, null],
  });
  const arrayMessage = h.messages.shift();
  h.deliver({
    jsonrpc: '2.0',
    id: arrayMessage.id,
    result: { candidate_id: 'array-candidate', status: 'awaiting_human_confirmation' },
  });
  assert.equal((await arrayProposal).candidate_id, 'array-candidate');
  h.deliver({ jsonrpc: '2.0', id: 'close', method: 'haip/ui.teardown', params: {} });
});

test('@haip/view pins the parent origin from the verified envelope', async (t) => {
  const wrong = harness();
  t.after(() => wrong.restore());
  const connected = connectView({ name: 'Choice', version: '1.0.0' });
  const init = wrong.messages.shift();
  wrong.deliver(
    {
      jsonrpc: '2.0',
      id: init.id,
      result: {
        protocolVersion: AGENT_UI_PROFILE,
        capabilities: { localProposal: true },
        hostInfo: { name: 'HAIP review host', version: PROTOCOL_REVISION },
        envelope: envelope(),
        limits: AGENT_UI_LIMITS,
        lifecycle: AGENT_UI_LIFECYCLE,
      },
    },
    undefined,
    'https://other.example',
  );
  await assert.rejects(connected, /Host origin does not match/);
  assert.equal(wrong.listeners.size, 0);
});

test('@haip/view permits no second wildcard message before origin pinning', async (t) => {
  const h = harness();
  t.after(() => h.restore());
  const connected = connectView({ name: 'Choice', version: '1.0.0' });
  const init = h.messages[0];
  assert.equal(init.method, 'haip/ui.initialize');
  assert.deepEqual(h.targets, ['*']);
  h.deliver({ jsonrpc: '2.0', id: 'early-close', method: 'haip/ui.teardown', params: {} });
  h.deliver({ jsonrpc: '2.0', id: 'early-unknown', method: 'haip/ui.unknown', params: {} });
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.targets, ['*']);
  h.deliver({
    jsonrpc: '2.0',
    id: init.id,
    result: {
      protocolVersion: AGENT_UI_PROFILE,
      capabilities: { localProposal: true },
      hostInfo: { name: 'HAIP review host', version: PROTOCOL_REVISION },
      envelope: envelope(),
      limits: AGENT_UI_LIMITS,
      lifecycle: AGENT_UI_LIFECYCLE,
    },
  });
  await connected;
  assert.equal(h.messages[1].method, 'haip/ui.initialized');
  assert.deepEqual(h.targets, ['*', SANDBOX_ORIGIN]);
});

test('@haip/view enforces JSON values and root-relative message depth', async (t) => {
  const h = harness();
  t.after(() => h.restore());
  const view = await readyView(h);
  const sparse: any[] = [];
  sparse.length = 1;
  const extended: any[] = [];
  (extended as any).extra = true;
  for (const response of [
    Number.MAX_SAFE_INTEGER + 1,
    '\ud800',
    { ['\ud800']: true },
    sparse,
    extended,
  ])
    await assert.rejects(
      (view as any).propose({ decision: 'answer', response }),
      /Invalid proposal/,
    );
  assert.equal(h.messages.length, 0);

  const accepted = view.propose({ decision: 'answer', response: nested(62) as any });
  const proposal = h.messages.shift();
  h.deliver({
    jsonrpc: '2.0',
    id: proposal.id,
    result: { candidate_id: 'depth-64', status: 'awaiting_human_confirmation' },
  });
  assert.equal((await accepted).candidate_id, 'depth-64');
  await assert.rejects(
    view.propose({ decision: 'answer', response: nested(63) as any }),
    /View message exceeds Agent UI limits/,
  );
  assert.equal(h.messages.length, 0);
  assert.equal(h.listeners.size, 0);
});

test('@haip/view enforces both message byte budgets', async (t) => {
  const inbound = harness();
  t.after(() => inbound.restore());
  const connected = connectView({ name: 'Choice', version: '1.0.0' });
  const init = inbound.messages[0];
  inbound.deliver({
    jsonrpc: '2.0',
    id: init.id,
    result: {
      protocolVersion: AGENT_UI_PROFILE,
      capabilities: { localProposal: true },
      hostInfo: {
        name: 'x'.repeat(AGENT_UI_LIMITS.host_message_bytes),
        version: PROTOCOL_REVISION,
      },
      envelope: envelope(),
      limits: AGENT_UI_LIMITS,
      lifecycle: AGENT_UI_LIFECYCLE,
    },
  });
  await assert.rejects(connected, /Host message exceeds Agent UI limits/);
  assert.deepEqual(inbound.targets, ['*']);
  assert.equal(inbound.listeners.size, 0);

  inbound.restore();
  const outbound = harness();
  t.after(() => outbound.restore());
  const view = await readyView(outbound);
  await assert.rejects(
    view.propose({
      decision: 'answer',
      response: 'x'.repeat(AGENT_UI_LIMITS.view_message_bytes),
    }),
    /View message exceeds Agent UI limits/,
  );
  assert.equal(outbound.messages.length, 0);
  assert.equal(outbound.listeners.size, 0);
});

test('@haip/view uses the protocol canonical-origin grammar', async () => {
  for (const origin of validAgentUiOrigins) {
    const h = harness();
    const view = await initialise(h, envelope(PROTOCOL_REVISION, origin));
    assert.equal(view.envelope.source.origin, origin);
    assert.deepEqual(h.targets, ['*', origin]);
    h.restore();
  }
  for (const origin of invalidAgentUiOrigins) {
    const h = harness();
    await assert.rejects(initialise(h, envelope(PROTOCOL_REVISION, origin) as any), /Host refused/);
    assert.equal(h.listeners.size, 0);
    h.restore();
  }
});
