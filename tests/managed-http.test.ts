import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, verifyRecord } from '@haip/protocol/crypto';
import { CommitWitness } from '../haip-server/src/commit-witness.js';
import { createApp } from '../haip-server/src/server.js';
import { ReviewService } from '../haip-server/src/service.js';
import { Store } from '../haip-server/src/store.js';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { environment } from './environment.js';
import { TestSafetyStore } from './fixtures/safety.js';

test('replacement handlers share witnessed review state and refuse access after an ambiguous commit', async () => {
  const env = await environment();
  const directory = await mkdtemp(join(tmpdir(), 'haip-managed-http-'));
  const storage = new TestSafetyStore(directory);
  const incarnation = {
    epoch: randomUUID(),
    deployment: 'fixture-http',
    database: digest('fixture-http-database'),
  };
  const config = env.service.config;
  const stores: Store[] = [];
  const servers: Server[] = [];
  try {
    const human = await env.login();
    const witness = new CommitWitness(storage, config, incarnation);
    await env.store.write((tx) => witness.provision(tx));
    const database = env.store.pool.options.connectionString;
    assert(database);
    const runHandler = async () => {
      const guard = new CommitWitness(storage, config, incarnation);
      const store = new Store(database, {}, undefined, guard);
      stores.push(store);
      const service = new ReviewService(store, config);
      const server = createServer(createApp(service));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const call = async (path: string, headers: Record<string, string>, body?: unknown) => {
        const result = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: result.status, body: await result.json() };
      };
      return { call, worker: new OutboxWorker(service, env.anchor) };
    };
    const first = await runHandler();
    const replacement = await runHandler();
    const producer = { Authorization: 'Bearer ' + env.credentials.producer };
    const reviewer = { Cookie: human.cookie, Origin: env.origin, 'X-CSRF-Token': human.csrf };
    const operator = { Authorization: 'Bearer ' + env.credentials.operator };
    const created = await first.call('/v2/requests', producer, env.request());
    assert.equal(created.status, 201);
    const path = '/v2/requests/' + created.body.request.id;
    const material = await replacement.call(path + '/material', reviewer);
    assert.equal(material.status, 200);
    assert.deepEqual(material.body.payload, env.request().payload);
    const candidate = await replacement.call(path + '/candidates', reviewer, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201);
    const receipt = await first.call(path + '/confirm', reviewer, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    assert.equal(receipt.status, 200);
    verifyRecord(receipt.body, env.trust, {
      issuer: env.origin,
      audience: 'producer',
      type: 'DecisionReceipt',
      tenant: 'test-tenant',
      purpose: 'review',
    });
    const ready = await replacement.worker.readyJobs();
    assert(ready.ids.length > 0);
    assert.deepEqual(await first.worker.runJob(ready.ids[0]!), { state: 'settled' });
    assert.equal((await first.call('/auth/session', reviewer)).status, 200);
    assert.equal((await first.call('/v2/admin/ledger', operator)).status, 200);

    storage.loseNextWrite = true;
    const unavailable = { status: 503, body: { error: 'service_unavailable' } };
    assert.deepEqual(await replacement.call('/v2/requests', producer, env.request()), unavailable);
    assert.equal((await env.store.pool.query('SELECT id FROM haip_requests')).rowCount, 1);
    assert.deepEqual(await first.call('/auth/session', reviewer), {
      status: 503,
      body: { error: 'managed_state_diverged' },
    });
    assert.equal((await replacement.call(path + '/material', producer)).status, 503);
    assert.equal((await first.call('/v2/admin/ledger', operator)).status, 503);
    await assert.rejects(replacement.worker.readyJobs(), /managed_state_diverged/);
    await assert.rejects(first.worker.runJob(ready.ids[0]!), /managed_state_diverged/);
  } finally {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.all(stores.map((store) => store.close()));
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});
