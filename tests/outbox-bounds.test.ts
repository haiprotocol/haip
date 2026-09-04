import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { createServer, request } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, parseJson } from '@haip/protocol/crypto';
import { verifyWebhook } from '../haip-sdk/src/webhooks.js';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { environment } from './environment.js';
import { freePort } from './fixtures/postgres.js';

test('more than fifty unconfigured checkpoints cannot starve actual SMTP or TLS webhook deliveries', async () => {
  const port = await freePort(),
    messages: string[] = [];
  const smtp = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream: any, _session: any, callback: any) {
      let body = '';
      stream.on('data', (chunk: Buffer) => (body += chunk));
      stream.on('end', () => {
        messages.push(body);
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(port, '127.0.0.1', resolve));
  const env = await environment({
    smtp: { host: '127.0.0.1', port, secure: false, from: 'review@test.invalid' },
  });
  const directory = await mkdtemp(join(tmpdir(), 'haip-unanchored-delivery-'));
  let receiver: ReturnType<typeof createServer> | undefined;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=receiver.test',
        '-addext',
        'subjectAltName=DNS:receiver.test',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'pipe' },
    );
    const cert = await readFile(join(directory, 'cert.pem'));
    let delivered = 0;
    receiver = createServer(
      { key: await readFile(join(directory, 'key.pem')), cert },
      async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const record = parseJson(Buffer.concat(chunks).toString()) as any;
          verifyWebhook(record, env.trust, {
            issuer: env.origin,
            tenant: 'test-tenant',
            producer: 'producer',
          });
          delivered++;
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      },
    );
    await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', resolve));
    const tlsPort = (receiver.address() as { port: number }).port;
    env.service.config.webhookHosts.push('receiver.test');
    await env.principal(
      'producer',
      'producer',
      {
        enabled: true,
        publisher: 'publisher',
        owner: 'requester',
        routes: ['review'],
        webhook: 'https://receiver.test/events',
      },
      env.credentials.producer,
    );
    for (const id of ['reviewer', 'requester'])
      await env.principal(id, 'human', {
        enabled: true,
        identity_certain: true,
        oidc_issuer: env.service.config.oidc.issuer,
        oidc_subject: id,
        email: id + '@test.invalid',
        email_verified: true,
      });
    const p = (
      await env.store.pool.query(
        "SELECT * FROM haip_principals WHERE tenant='test-tenant' AND id='producer'",
      )
    ).rows[0];
    await env.store.transaction('test-tenant', async (tx, now) => {
      for (let i = 0; i < 55; i++)
        await env.service.audit(tx, p, now, 'FixtureMaintenance', { ordinal: i });
    });
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const pending = () =>
      env.store.pool.query(
        "SELECT count(*) FROM haip_outbox WHERE kind='checkpoint' AND state='pending'",
      );
    const backlog = Number((await pending()).rows[0].count);
    assert(backlog > 50);
    const worker = new OutboxWorker(env.service, undefined, {
      webhookTransport: {
        resolve: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
        request: ((url: URL, options: any, callback: any) =>
          request(
            {
              ...options,
              hostname: '127.0.0.1',
              port: tlsPort,
              path: url.pathname,
              servername: 'receiver.test',
              ca: cert,
            },
            callback,
          )) as typeof request,
      },
    });
    await worker.reconcile();
    assert.equal(
      (await env.api('/v2/admin/metrics', undefined, env.credentials.operator)).body
        .admission_fenced,
      true,
    );
    assert.equal(await worker.tick(), 3);
    assert.equal(messages.length, 2);
    assert.equal(delivered, 1);
    assert.equal(
      Number((await pending()).rows[0].count),
      backlog,
      'unconfigured anchoring remains visible and retryable',
    );
    assert.equal(await worker.tick(), 0);
    assert.equal(messages.length, 2);
    assert.equal(delivered, 1);
    // Restoring an anchor resumes those old checkpoints without redelivering accepted notifications.
    await env.flush();
    assert.equal(Number((await pending()).rows[0].count), 0);
    assert.equal(messages.length, 2);
    assert.equal(delivered, 1);
  } finally {
    if (receiver) await new Promise<void>((resolve) => receiver!.close(() => resolve()));
    await env.close();
    await new Promise<void>((resolve) => smtp.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a checkpoint covering many decisions is applied in bounded resumable batches without re-opening expired grants', async () => {
  const env = await environment();
  try {
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: { ...env.route.limits, grant_seconds: 1 },
    });
    const human = await env.login();
    let finalDeadline = 0;
    for (let i = 0; i < 52; i++) {
      // Advance only the fixture token bucket so this test can form a long checkpoint backlog quickly.
      if (i % 10 === 0)
        await env.store.pool.query(
          "UPDATE haip_tenants SET config=config-'buckets' WHERE id='test-tenant'",
        );
      const created = await env.api('/v2/requests', env.request(true));
      assert.equal(created.status, 201);
      const id = created.body.request.id;
      const candidate = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'authorise',
        response: { choice: 'accept' },
      });
      assert.equal(candidate.status, 201);
      const receipt = await human.call(`/v2/requests/${id}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      });
      assert.equal(receipt.status, 200);
      finalDeadline = Math.max(finalDeadline, Date.parse(receipt.body.payload.grant_deadline));
    }
    // A later checkpoint may overtake delayed earlier deliveries. Its accepted prefix covers all decisions.
    await env.store.pool.query(
      "UPDATE haip_outbox SET next_at=clock_timestamp()+interval '1 day' WHERE kind='checkpoint'",
    );
    const checkpoint = (
      await env.store.pool.query(
        "SELECT id,body FROM haip_outbox WHERE tenant='test-tenant' AND kind='checkpoint' ORDER BY (body->'payload'->>'sequence')::bigint DESC LIMIT 1",
      )
    ).rows[0];
    const latest = checkpoint.id,
      checkpointDigest = digest(checkpoint.body);
    const accept = env.anchor.accept.bind(env.anchor);
    let attempts = 0;
    env.anchor.accept = async (record) => {
      if (digest(record) === checkpointDigest) attempts++;
      return accept(record);
    };
    const originalReceipts = (
      await env.store.pool.query(
        "SELECT id,data->'receipt' AS receipt,data->>'grant_deadline' AS deadline FROM haip_requests WHERE tenant='test-tenant' ORDER BY id",
      )
    ).rows;
    await env.store.pool.query('UPDATE haip_outbox SET next_at=clock_timestamp() WHERE id=$1', [
      latest,
    ]);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, finalDeadline - Date.now() + 20)),
    );
    const began = Date.now();
    assert.equal(await env.worker.tick(), 50);
    assert.equal(attempts, 1);
    const partial = (
      await env.store.pool.query(
        'SELECT state,next_at,accepted,body FROM haip_outbox WHERE id=$1',
        [latest],
      )
    ).rows[0];
    assert.equal(partial.state, 'pending');
    assert(
      partial.next_at.getTime() >= began + 29000,
      'a partial checkpoint page is deferred for thirty seconds',
    );
    assert(partial.accepted);
    assert.deepEqual(partial.body, checkpoint.body);
    const counts = () =>
      env.store.pool.query(
        "SELECT data->>'audit_state' AS state,count(*) FROM haip_requests WHERE tenant='test-tenant' GROUP BY data->>'audit_state'",
      );
    const first = (await counts()).rows;
    assert.equal(Number(first.find((r) => r.state === 'anchored')?.count), 50);
    assert.equal(Number(first.find((r) => r.state === 'pending')?.count), 2);
    assert.equal(
      (await env.store.pool.query('SELECT state FROM haip_outbox WHERE id=$1', [latest])).rows[0]
        .state,
      'pending',
    );
    // Isolate this partially applied checkpoint from the new checkpoints emitted by its first page.
    await env.store.pool.query(
      "UPDATE haip_outbox SET next_at=clock_timestamp()+interval '1 day' WHERE kind='checkpoint' AND id<>$1",
      [latest],
    );
    const resumed = new OutboxWorker(env.service, env.anchor);
    await resumed.reconcile();
    assert.equal(await resumed.tick(), 0, 'the database-backed delay survives a worker restart');
    assert.equal(await resumed.tick(), 0);
    assert.equal(attempts, 1, 'fast ticks do not call the external anchor again');
    // Simulate the scheduled retry becoming due, without changing any grant clock.
    await env.store.pool.query(
      'UPDATE haip_outbox SET next_at=clock_timestamp(),accepted=\'{"backend":"untrusted_database_copy"}\' WHERE id=$1',
      [latest],
    );
    await resumed.tick();
    assert.equal(
      attempts,
      2,
      'an accepted database receipt is never used instead of re-verifying independent storage',
    );
    const applied = (
      await env.store.pool.query('SELECT accepted,body FROM haip_outbox WHERE id=$1', [latest])
    ).rows[0];
    assert.equal(applied.accepted.backend, 'test_filesystem');
    assert.deepEqual(applied.body, checkpoint.body);
    assert.deepEqual(
      (
        await env.store.pool.query(
          "SELECT id,data->'receipt' AS receipt,data->>'grant_deadline' AS deadline FROM haip_requests WHERE tenant='test-tenant' ORDER BY id",
        )
      ).rows,
      originalReceipts,
    );
    assert.equal(Number((await counts()).rows.find((r) => r.state === 'anchored')?.count), 52);
    assert.equal(
      (await env.store.pool.query('SELECT state FROM haip_outbox WHERE id=$1', [latest])).rows[0]
        .state,
      'accepted',
    );
    assert.equal(
      Number(
        (
          await env.store.pool.query(
            "SELECT count(*) FROM haip_requests WHERE tenant='test-tenant' AND data->>'grant_state'='available'",
          )
        ).rows[0].count,
      ),
      0,
    );
  } finally {
    await env.close();
  }
});
