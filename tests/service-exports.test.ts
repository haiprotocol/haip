import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest, digestBytes } from '@haip/protocol/crypto';
import { HAIPClient } from '../haip-sdk/src/index.js';
import { ProtocolError } from '../haip-server/src/errors.js';
import type { Principal } from '../haip-server/src/config.js';
import { environment } from './environment.js';

async function reviewWithBundle(env: Awaited<ReturnType<typeof environment>>) {
  const html = '<!doctype html><p>Stored review fixture</p>';
  const registered = await env.api(
    '/v2/bundles',
    {
      html,
      compatibility: { agent_ui: '1' },
      author: 'Independent test fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(registered.status, 201);
  const created = await env.api(
    '/v2/requests',
    env.request(false, {
      bundle_id: registered.body.id,
      profiles: { 'haip.agent-ui': '1' },
    }),
  );
  assert.equal(created.status, 201);
  return { html, manifest: registered.body, request: created.body.request };
}

test('exports verify bundle bytes, manifest identity and compatibility against the accepted request', async () => {
  const env = await environment();
  try {
    const { html, manifest, request } = await reviewWithBundle(env);
    const client = new HAIPClient(env.origin, env.credentials.producer, true);
    const original = await client.audit(request.id);
    assert.equal(digest(original.material.bundle), digest({ html, manifest }));
    const human = await env.login();
    const path = `/v2/requests/${request.id}/export`;
    const changedHtml = '<!doctype html><script>throw new Error("Changed fixture")</script>';
    const cases = [
      { name: 'changed HTML', html: changedHtml, manifest },
      {
        name: 'HTML and manifest digest changed together',
        html: changedHtml,
        manifest: { ...manifest, digest: digestBytes(changedHtml) },
      },
      { name: 'wrong bundle ID', html, manifest: { ...manifest, id: randomUUID() } },
      { name: 'wrong tenant', html, manifest: { ...manifest, tenant: 'foreign-tenant' } },
      { name: 'wrong publisher', html, manifest: { ...manifest, publisher: 'other-publisher' } },
      { name: 'wrong digest', html, manifest: { ...manifest, digest: digest({ changed: true }) } },
      {
        name: 'changed compatibility',
        html,
        manifest: { ...manifest, compatibility: { ...manifest.compatibility, agent_ui: '0' } },
      },
      {
        name: 'new unbound compatibility field',
        html,
        manifest: { ...manifest, compatibility: { ...manifest.compatibility, extra: true } },
      },
      { name: 'missing compatibility', html, manifest: { ...manifest, compatibility: undefined } },
      { name: 'malformed manifest', html, manifest: null },
    ];
    for (const corrupt of cases) {
      await env.store.pool.query(
        'UPDATE haip_bundles SET html=$1,manifest=$2 WHERE tenant=$3 AND id=$4',
        [corrupt.html, JSON.stringify(corrupt.manifest), 'test-tenant', manifest.id],
      );
      for (const result of [await env.api(path), await human.call(path)]) {
        assert.equal(result.status, 409, corrupt.name);
        assert.deepEqual(result.body, { error: 'bundle_integrity_mismatch' }, corrupt.name);
      }
    }
    // Compatibility is canonical JSON: a different property order changes no commitment.
    const reordered = {
      ...manifest,
      compatibility: {

        agent_ui: manifest.compatibility.agent_ui,
      },
    };
    await env.store.pool.query(
      'UPDATE haip_bundles SET html=$1,manifest=$2 WHERE tenant=$3 AND id=$4',
      [html, JSON.stringify(reordered), 'test-tenant', manifest.id],
    );
    const restored = await client.audit(request.id);
    assert.equal(restored.material.bundle.html, html);
    assert.deepEqual(restored.request, original.request);
    assert.deepEqual(restored.records, original.records);
    assert.deepEqual(restored.audit, original.audit);
    for (const credential of [env.credentials.otherProducer, env.credentials.foreignProducer])
      assert.equal((await env.api(path, undefined, credential)).status, 404);
  } finally {
    await env.close();
  }
});

test('exports refuse deleted required bundles but never revive private material after expiry', async () => {
  const env = await environment();
  try {
    const { manifest, request } = await reviewWithBundle(env);
    const path = `/v2/requests/${request.id}/export`;
    await env.store.pool.query('UPDATE haip_bundles SET html=NULL WHERE tenant=$1 AND id=$2', [
      'test-tenant',
      manifest.id,
    ]);
    const deleted = await env.api(path);
    assert.equal(deleted.status, 410);
    assert.deepEqual(deleted.body, { error: 'bundle_deleted' });
    await env.store.pool.query('DELETE FROM haip_bundles WHERE tenant=$1 AND id=$2', [
      'test-tenant',
      manifest.id,
    ]);
    assert.equal((await env.api(path)).status, 410);
    const deadline = new Date(Date.now() + 60000);
    await env.store.pool.query(
      "UPDATE haip_requests SET data=jsonb_set(data,'{request,private_delete_at}',to_jsonb($1::text)) WHERE tenant=$2 AND id=$3",
      [deadline.toISOString(), 'test-tenant', request.id],
    );
    const read = env.store.read.bind(env.store);
    let now = new Date(deadline.getTime() - 1);
    env.store.read = (run) => read((tx) => run(tx, now));
    try {
      assert.equal(
        (await env.api(path)).status,
        410,
        'required bundle remains checked before expiry',
      );
      now = deadline;
      const expired = await env.api(path);
      assert.equal(expired.status, 200);
      assert.equal(expired.body.material, null, 'material is withheld at the exact deadline');
      assert.equal(expired.body.request.review.bundle.id, manifest.id);
      assert(expired.body.audit.length > 0);
      now = new Date(deadline.getTime() + 1);
      assert.equal((await env.api(path)).body.material, null);
    } finally {
      env.store.read = read;
    }
  } finally {
    await env.close();
  }
});

test('audit refuses a missing tenant without signing or inserting a ledger record', async (t) => {
  const env = await environment();
  try {
    const before = await env.store.pool.query('SELECT count(*) FROM haip_audit');
    const principal = (
      await env.store.pool.query(
        "SELECT * FROM haip_principals WHERE tenant='test-tenant' AND id='operator'",
      )
    ).rows[0] as Principal;
    const signed = t.mock.method(env.service, 'signed');
    await assert.rejects(
      env.store.transaction('missing-tenant', (tx, now) =>
        env.service.audit(tx, { ...principal, tenant: 'missing-tenant' }, now, 'Fixture', {}),
      ),
      (error: unknown) =>
        error instanceof ProtocolError && error.status === 404 && error.code === 'not_found',
    );
    assert.equal(signed.mock.callCount(), 0);
    assert.deepEqual(
      (await env.store.pool.query('SELECT count(*) FROM haip_audit')).rows,
      before.rows,
    );
  } finally {
    await env.close();
  }
});
