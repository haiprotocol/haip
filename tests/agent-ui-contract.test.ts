import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { environment } from './environment.js';
import { digest } from '@haip/protocol/crypto';

const PROFILE = 'org.haiprotocol.agent-ui/1';
async function validator() {
  const schema = JSON.parse(await readFile('protocol/draft-2.0.0-2/schema.json', 'utf8'));
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
  ok('AgentUiInitializeParams', {
    protocolVersion: PROFILE,
    capabilities: { localProposal: true },
    viewInfo: { name: 'Choice review', version: '1.0.0' },
  });
  bad('AgentUiInitializeParams', { protocolVersion: 'mcp-apps/2026-01-26', capabilities: { localProposal: true } });
  bad('AgentUiInitializeParams', { protocolVersion: PROFILE, capabilities: { localProposal: true, serverTools: {} } });
  ok('AgentUiMessage', { jsonrpc: '2.0', id: 1, method: 'haip/ui.initialize', params: {} });
  ok('AgentUiMessage', { jsonrpc: '2.0', method: 'haip/ui.input', params: { request_id: 'x', purpose: 'review' } });
  ok('AgentUiMessage', { jsonrpc: '2.0', id: 'a', result: { closed: true } });
  ok('AgentUiMessage', { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Forbidden host operation' } });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 4, result: {}, error: { code: -32000, message: 'both' } });
  bad('AgentUiMessage', { jsonrpc: '2.0', method: 'haip/ui.propose', params: {} });
  bad('AgentUiMessage', { jsonrpc: '2.0', id: 5, error: { code: -1, message: 'unknown code' } });
  ok('AgentUiTeardownResult', { closed: true });
  bad('AgentUiTeardownResult', { closed: false });
});

test('the stored app carries a complete envelope whose binding digest the host can recompute', async () => {
  const env = await environment();
  try {
    const get = await validator();
    const bundle = await env.api(
      '/v2/bundles',
      {
        html: '<!doctype html><body><p>View</p></body>',
        compatibility: { agent_ui: '1' },
        author: 'Contract fixture',
        licence: 'MIT',
      },
      env.credentials.publisher,
    );
    assert.equal(bundle.status, 201);
    const created = await env.api(
      '/v2/requests',
      env.request(false, { bundle_id: bundle.body.id, profiles: { 'haip.agent-ui': '1' } }),
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
    assert.equal(new URL(app.origin).origin, app.source.origin);
    assert.ok(get('AgentUiEnvelope')({ ...identity, binding_digest: app.binding_digest }));
    // Altering any bound value invalidates the digest the View will be shown.
    assert.notEqual(digest({ ...identity, bundle: { ...app.bundle, digest: 'sha256:' + '0'.repeat(64) } }), app.binding_digest);
  } finally {
    await env.close();
  }
});
