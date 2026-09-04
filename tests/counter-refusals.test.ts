import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HAIPClient } from '@haip/sdk';
import { digest, canonicalise } from '@haip/protocol/crypto';
import { runCounter } from '../examples/http/counter.js';
import { environment } from './environment.js';

test('invalid counter authority produces no effect; a crash after fencing is uncertain and never relaunched', async () => {
  const env = await environment(),
    root = await mkdtemp(join(tmpdir(), 'haip-counter-negative-'));
  try {
    for (const scenario of [
      'review',
      'unconfirmed',
      'signature',
      'crashed',
      'context',
      'policy',
      'format',
      'pending_anchor',
      'revoked',
      'expired',
    ]) {
      const input = env.request(scenario !== 'review');
      if (scenario === 'context') input.execution.context_digest = digest({ counter: 'another' });
      if (scenario === 'policy') input.execution.policy.digest = digest({ changed: true });
      if (scenario === 'format') input.execution.context_format = 'unknown-format';
      if (scenario === 'expired')
        input.execution.valid_until = new Date(Date.now() + 1000).toISOString();
      const created = await env.api('/v2/requests', input);
      assert.equal(created.status, 201);
      const id = created.body.request.id,
        directory = join(root, scenario);
      if (!['review', 'unconfirmed'].includes(scenario)) {
        const human = await env.login();
        const candidate = await human.call(`/v2/requests/${id}/candidates`, {
          decision: 'authorise',
          response: { choice: 'accept' },
        });
        await human.call(`/v2/requests/${id}/confirm`, {
          candidate_id: candidate.body.id,
          candidate_digest: digest(candidate.body),
        });
        if (scenario !== 'pending_anchor') await env.flush();
      }
      if (scenario === 'revoked') await env.api(`/v2/requests/${id}/revoke`, {});
      if (scenario === 'expired') await new Promise((resolve) => setTimeout(resolve, 1100));
      const client = new HAIPClient(env.origin, env.credentials.producer, true);
      if (scenario === 'signature') {
        const original = client.admission.bind(client);
        client.admission = async (...args) => {
          const a = await original(...args);
          a.record.signature = 'A'.repeat(86);
          return a;
        };
      }
      if (scenario === 'crashed') {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(directory);
        const claim = await client.claim(
          id,
          {
            execution_identity: 'counter:' + id,
            execution_binding_digest: digest(created.body.request.execution),
          },
          'crash',
        );
        await writeFile(join(directory, id + '.fence'), canonicalise(claim), {
          flag: 'wx',
          mode: 0o600,
        });
      }
      const options = {
        client,
        requestId: id,
        directory,
        trust: env.trust,
        tenant: 'test-tenant',
        producer: 'producer',
        verifyAnchor: async (checkpoint: any, acceptance: any) => {
          assert.equal(await readFile(acceptance.key, 'utf8'), canonicalise(checkpoint));
        },
      };
      await assert.rejects(runCounter(options));
      await assert.rejects(stat(join(directory, 'counter.json')), { code: 'ENOENT' });
      if (['context', 'policy', 'format'].includes(scenario))
        assert.equal(
          (await client.status(id)).execution_state,
          'unclaimed',
          'unsupported binding must fail before consuming a claim',
        );
      if (scenario === 'crashed') {
        await assert.rejects(runCounter(options), /uncertain/);
        assert.equal((await client.status(id)).execution_state, 'uncertain');
        assert.equal((await client.status(id)).grant_state, 'consumed');
      }
    }
  } finally {
    await env.close();
    await rm(root, { recursive: true, force: true });
  }
});
