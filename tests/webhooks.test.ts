import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:https';
import { verifyWebhook, PostgresWebhookInbox } from '../haip-sdk/src/webhooks.js';
import { parseJson } from '@haip/protocol/crypto';
import { deliverWebhook, publicAddress } from '../haip-server/src/delivery.js';
import { environment } from './environment.js';

test('TLS webhook delivery persists before acknowledgement, deduplicates after restart and rejects five-minute replay and altered scopes', async () => {
  const env = await environment(),
    directory = await mkdtemp(join(tmpdir(), 'haip-webhook-tls-'));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const identity = { issuer: env.origin, tenant: 'test-tenant', producer: 'producer' };
    const principal = {
      tenant: identity.tenant,
      id: identity.producer,
      kind: 'producer' as const,
      config: { enabled: true },
    };
    const create = await env.api('/v2/requests', env.request());
    await env.api(`/v2/requests/${create.body.request.id}/cancel`, {});
    const events = (await env.api('/v2/events')).body;
    const older = events.items[0],
      latest = events.items.at(-1);
    const delivery = (event = latest, at = new Date()) =>
      env.service.signed(
        'WebhookDelivery',
        {
          delivery_id: randomUUID(),
          event_id: event.payload.event_id,
          timestamp: at.toISOString(),
          event,
        },
        principal,
        at,
      );
    let inbox = new PostgresWebhookInbox(env.store.pool);
    await inbox.migrate();
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
    let redirect = false,
      requests = 0,
      acknowledged = 0;
    server = createServer(
      { key: await readFile(join(directory, 'key.pem')), cert },
      async (req, res) => {
        requests++;
        if (redirect) {
          res.writeHead(302, { Location: 'https://receiver.test/unsafe' });
          res.end();
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const record = parseJson(Buffer.concat(chunks).toString()) as any;
          await inbox.persist(verifyWebhook(record, env.trust, identity));
          const count = (await env.store.pool.query('SELECT count(*) FROM haip_received_events'))
            .rows[0].count;
          assert.ok(Number(count) > 0);
          acknowledged++;
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      },
    );
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // Only this test transport maps a public DNS fixture to its isolated TLS listener.
    const transport = {
      resolve: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
      request: ((url: URL, options: any, callback: any) =>
        request(
          {
            ...options,
            hostname: '127.0.0.1',
            port,
            path: url.pathname,
            servername: 'receiver.test',
            ca: cert,
          },
          callback,
        )) as typeof request,
    };
    await deliverWebhook('https://receiver.test/events', delivery(), ['receiver.test'], transport);
    inbox = new PostgresWebhookInbox(env.store.pool); // receiver process state is disposable
    await inbox.migrate();
    await deliverWebhook('https://receiver.test/events', delivery(), ['receiver.test'], transport);
    await deliverWebhook(
      'https://receiver.test/events',
      delivery(older),
      ['receiver.test'],
      transport,
    );
    assert.equal(acknowledged, 3);
    assert.equal(
      Number(
        (await env.store.pool.query('SELECT count(*) FROM haip_received_events')).rows[0].count,
      ),
      2,
    );
    assert.equal(
      Number(
        (await env.store.pool.query('SELECT revision FROM haip_status_refresh')).rows[0].revision,
      ),
      latest.payload.revision,
    );
    assert.equal((await env.api('/v2/events?after=' + events.next)).body.items.length, 0);
    const now = Date.now();
    assert.throws(
      () => verifyWebhook(delivery(latest, new Date(now - 300000)), env.trust, identity, now),
      /webhook_replay_window/,
    );
    assert.throws(() =>
      verifyWebhook(delivery(), env.trust, { ...identity, producer: 'other-producer' }),
    );
    const altered = delivery();
    (altered.payload as any).event_id = randomUUID();
    assert.throws(() => verifyWebhook(altered, env.trust, identity));
    redirect = true;
    await assert.rejects(
      deliverWebhook('https://receiver.test/events', delivery(), ['receiver.test'], transport),
      /webhook_not_accepted/,
    );
    assert.equal(requests, 4, 'redirect must not be followed');
    const before = requests;
    await assert.rejects(
      deliverWebhook('https://receiver.test/events', delivery(), ['receiver.test'], {
        ...transport,
        resolve: (async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]) as any,
      }),
      /webhook_address_rejected/,
    );
    assert.equal(requests, before);
    for (const address of [
      '::1',
      '::ffff:127.0.0.1',
      '2002:7f00:1::',
      '2001::1',
      '2001:db8::1',
      '3fff::1',
      'fc00::1',
      '169.254.169.254',
    ])
      assert.equal(publicAddress(address), false, address);
    assert.equal(publicAddress('2606:4700:4700::1111'), true);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await env.close();
    await rm(directory, { recursive: true, force: true });
  }
});
