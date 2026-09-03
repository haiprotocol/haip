import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { environment } from './environment.js';
import { digest } from '@haip/protocol/crypto';
import { AGENT_UI_LIFECYCLE, AGENT_UI_LIMITS } from '@haip/protocol';
import { invalidAgentUiOrigins, validAgentUiOrigins } from './agent-ui-origin-vectors.js';

const PROFILE = 'org.haiprotocol.agent-ui/2';
async function validator() {
  const schema = JSON.parse(await readFile('protocol/draft-2.0.0-3/schema.json', 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  (addFormats as any)(ajv);
  ajv.addSchema(schema);
  return (name: string) => ajv.getSchema(schema.$id + '#/$defs/' + name)!;
}

test('Agent UI message definitions accept the wire and reject foreign shapes', async () => {
  const get = await validator();
  const ok = (name: string, value: unknown) => {
    const v = get(name);
    assert.ok(v(value), name + ': ' + JSON.stringify(v.errors));
  };
  const bad = (name: string, value: unknown) => assert.equal(get(name)(value), false, name);
  ok('AgentUiCompatibility', { agent_ui: '2' });
  bad('AgentUiCompatibility', { agent_ui: '1' });
  ok('AgentUiLimits', AGENT_UI_LIMITS);
  bad('AgentUiLimits', { ...AGENT_UI_LIMITS, proposals_per_view: 33 });
  ok('AgentUiLifecycle', AGENT_UI_LIFECYCLE);
  bad('AgentUiLifecycle', { ...AGENT_UI_LIFECYCLE, teardown: 'reusable' });
  const source = (origin: string) => ({
    tenant: 'tenant',
    producer: 'producer',
    requester: { subject: 'owner', source: 'operator_directory' },
    origin,
  });
  for (const origin of validAgentUiOrigins) ok('AgentUiSource', source(origin));
  for (const origin of invalidAgentUiOrigins) bad('AgentUiSource', source(origin));
  ok('AgentUiInitializeParams', {
    protocolVersion: PROFILE,
    capabilities: { localProposal: true },
    viewInfo: { name: 'Choice review', version: '1.0.0' },
  });
  bad('AgentUiInitializeParams', {
    protocolVersion: 'mcp-apps/2026-01-26',
    capabilities: { localProposal: true },
  });
  bad('AgentUiInitializeParams', {
    protocolVersion: PROFILE,
    capabilities: { localProposal: true, serverTools: {} },
  });
  ok('AgentUiInitializeParams', {
    protocolVersion: PROFILE,
    capabilities: { localProposal: true },
    viewInfo: { name: '😀'.repeat(120), version: '1' },
  });
  bad('AgentUiInitializeParams', {
    protocolVersion: PROFILE,
    capabilities: { localProposal: true },
    viewInfo: { name: '😀'.repeat(121), version: '1' },
  });
  ok('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 1,
    method: 'haip/ui.initialize',
    params: { protocolVersion: PROFILE, capabilities: { localProposal: true } },
  });
  ok('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 2,
    method: 'haip/ui.propose',
    params: { decision: 'answer', response: { choice: 'accept' } },
  });
  ok('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 3,
    method: 'haip/ui.propose',
    params: { decision: 'answer', response: ['accept', 1, true, null] },
  });
  ok('AgentUiMessage', { jsonrpc: '2.0', method: 'haip/ui.initialized', params: {} });
  ok('AgentUiMessage', {
    jsonrpc: '2.0',
    method: 'haip/ui.input',
    params: { request_id: '8fd7d8b9-8e62-4422-9e40-15d2d745f35b', purpose: 'review' },
  });
  ok('AgentUiMessage', {
    jsonrpc: '2.0',
    method: 'haip/ui.result',
    params: { content: [], structuredContent: { payload: null } },
  });
  ok('AgentUiMessage', { jsonrpc: '2.0', id: 'a', result: { closed: true } });
  ok('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32601, message: 'Forbidden host operation' },
  });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 1, method: 'haip/ui.initialize', params: {} });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 1,
    method: 'haip/ui.initialize',
    params: { protocolVersion: PROFILE, capabilities: { localProposal: true } },
    extra: true,
  });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 2, method: 'haip/ui.propose', params: {} });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 2,
    method: 'haip/ui.propose',
    params: { decision: 'answer', response: null },
    extra: true,
  });
  bad('AgentUiMessage', { jsonrpc: '2.0', method: 'haip/ui.initialized' });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    method: 'haip/ui.initialized',
    params: { extra: true },
  });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    method: 'haip/ui.input',
    params: { request_id: 'x', purpose: 'review' },
  });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    method: 'haip/ui.input',
    params: { request_id: '00000000-0000-0000-0000-000000000000', purpose: 'review' },
  });
  bad('AgentUiMessage', { jsonrpc: '2.0', method: 'haip/ui.result', params: { content: [] } });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 'a', result: null });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 'a', result: { closed: false } });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    id: Number.MAX_SAFE_INTEGER + 1,
    method: 'haip/ui.propose',
    params: { decision: 'answer', response: null },
  });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    id: '',
    method: 'haip/ui.propose',
    params: { decision: 'answer', response: null },
  });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 1.5,
    method: 'haip/ui.propose',
    params: { decision: 'answer', response: null },
  });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 4,
    result: {},
    error: { code: -32000, message: 'both' },
  });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 5, error: { code: -1, message: 'unknown code' } });
  bad('AgentUiMessage', {
    jsonrpc: '2.0',
    id: 5,
    error: { code: -32603, message: 'unsupported code' },
  });
  ok('AgentUiTeardownResult', { closed: true });
  bad('AgentUiTeardownResult', { closed: false });
});

test('Agent UI directional unions separate public View and private Proxy messages', async () => {
  const get = await validator();
  const ok = (name: string, value: unknown) => {
    const validate = get(name);
    assert.ok(validate(value), name + ': ' + JSON.stringify(validate.errors));
  };
  const bad = (name: string, value: unknown) => assert.equal(get(name)(value), false, name);
  const envelope = {
    profile: PROFILE,
    protocol_revision: '2.0.0-draft.3',
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
      origin: 'https://sandbox.example',
    },
    snapshots: {
      input_digest: 'sha256:' + '3'.repeat(64),
      result_digest: 'sha256:' + '4'.repeat(64),
    },
    binding_digest: 'sha256:' + '5'.repeat(64),
  };
  const initializeRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'haip/ui.initialize',
    params: { protocolVersion: PROFILE, capabilities: { localProposal: true } },
  };
  const initialized = { jsonrpc: '2.0', method: 'haip/ui.initialized', params: {} };
  const proposeRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'haip/ui.propose',
    params: { decision: 'answer', response: { choice: 'accept' } },
  };
  const teardownRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'haip/ui.teardown',
    params: {},
  };
  const teardownSuccess = { jsonrpc: '2.0', id: 3, result: { closed: true } };
  const initializeSuccess = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: PROFILE,
      capabilities: { localProposal: true },
      hostInfo: { name: 'HAIP review host', version: '2.0.0-draft.3' },
      envelope,
      limits: AGENT_UI_LIMITS,
      lifecycle: AGENT_UI_LIFECYCLE,
    },
  };
  const input = {
    jsonrpc: '2.0',
    method: 'haip/ui.input',
    params: { request_id: envelope.request.id, purpose: 'review' },
  };
  const result = {
    jsonrpc: '2.0',
    method: 'haip/ui.result',
    params: { content: [], structuredContent: { payload: null } },
  };
  const proposeSuccess = {
    jsonrpc: '2.0',
    id: 2,
    result: { candidate_id: 'candidate', status: 'awaiting_human_confirmation' },
  };
  const error = {
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32601, message: 'Forbidden host operation' },
  };
  const proxyReady = { jsonrpc: '2.0', method: 'haip/ui.proxyReady', params: {} };
  const resourceReady = {
    jsonrpc: '2.0',
    method: 'haip/ui.resourceReady',
    params: { html: '<!doctype html>', sandbox: 'allow-scripts' },
  };
  const viewFailed = {
    jsonrpc: '2.0',
    method: 'haip/ui.viewFailed',
    params: { reason: 'resource rejected' },
  };

  for (const message of [initializeRequest, initialized, proposeRequest, teardownSuccess, error])
    ok('AgentUiViewToHostMessage', message);
  for (const message of [initializeSuccess, input, result, proposeSuccess, teardownRequest, error])
    ok('AgentUiHostToViewMessage', message);
  bad('AgentUiViewToHostMessage', teardownRequest);
  bad('AgentUiViewToHostMessage', proxyReady);
  bad('AgentUiHostToViewMessage', initializeRequest);
  for (const message of [proxyReady, resourceReady, viewFailed]) bad('AgentUiMessage', message);
  ok('AgentUiProxyToHostNotification', proxyReady);
  ok('AgentUiProxyToHostNotification', viewFailed);
  ok('AgentUiHostToProxyNotification', resourceReady);
  for (const message of [proxyReady, resourceReady, viewFailed])
    ok('AgentUiPrivateProxyNotification', message);

  ok('AgentUiBundleIdentity', envelope.bundle);
  bad('AgentUiBundleIdentity', {
    ...envelope.bundle,
    created_at: '2026-12-31T23:59:60.000Z',
  });
  const storedApp = {
    ...envelope,
    html: '<!doctype html>',
    origin: envelope.source.origin,
    scope: '0'.repeat(64),
    input: input.params,
    result: result.params,
  };
  ok('StoredApp', storedApp);
  bad('StoredApp', { ...storedApp, scope: '0'.repeat(63) });
});

test('the stored app carries a complete envelope whose binding digest the host can recompute', async () => {
  const env = await environment();
  try {
    const get = await validator();
    const bundle = await env.api(
      '/v2/bundles',
      {
        html: '<!doctype html><body><p>View</p></body>',
        compatibility: { agent_ui: '2' },
        author: 'Contract fixture',
        licence: 'MIT',
      },
      env.credentials.publisher,
    );
    assert.equal(bundle.status, 201);
    const created = await env.api(
      '/v2/requests',
      env.request(false, { bundle_id: bundle.body.id, profiles: { 'haip.agent-ui': '2' } }),
    );
    assert.equal(created.status, 201);
    const human = await env.login();
    const stored = await human.call(`/v2/requests/${created.body.request.id}/app`);
    assert.equal(stored.status, 200);
    const app = stored.body;
    const validate = get('StoredApp');
    assert.ok(validate(app), JSON.stringify(validate.errors));
    // The identity subset is exactly what the host and the View bind to.
    const identity = {
      profile: app.profile,
      protocol_revision: app.protocol_revision,
      request: app.request,
      bundle: app.bundle,
      source: app.source,
      snapshots: app.snapshots,
    };
    assert.equal(digest(identity), app.binding_digest);
    assert.equal(digest(app.input), app.snapshots.input_digest);
    assert.equal(digest(app.result), app.snapshots.result_digest);
    assert.equal(app.request.id, created.body.request.id);
    assert.equal(app.request.digest, created.body.request_digest);
    assert.equal(app.bundle.id, bundle.body.id);
    assert.equal(app.bundle.digest, bundle.body.digest);
    assert.equal(app.bundle.created_at, bundle.body.created_at);
    assert.equal(created.body.request.review.bundle.created_at, bundle.body.created_at);
    assert.equal(new URL(app.origin).origin, app.source.origin);
    assert.ok(get('AgentUiEnvelope')({ ...identity, binding_digest: app.binding_digest }));
    assert.ok(
      get('AgentUiInitializeResult')({
        protocolVersion: PROFILE,
        capabilities: { localProposal: true },
        hostInfo: { name: 'HAIP review host', version: '2.0.0-draft.3' },
        envelope: { ...identity, binding_digest: app.binding_digest },
        limits: AGENT_UI_LIMITS,
        lifecycle: AGENT_UI_LIFECYCLE,
      }),
    );
    // Altering any bound value invalidates the digest the View will be shown.
    assert.notEqual(
      digest({ ...identity, bundle: { ...app.bundle, digest: 'sha256:' + '0'.repeat(64) } }),
      app.binding_digest,
    );
  } finally {
    await env.close();
  }
});
