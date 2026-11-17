import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer, request } from 'node:https';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { digest, parseJson } from '@haip/protocol/crypto';
import type { SignedRecord } from '@haip/protocol';
import { PostgresWebhookInbox, verifyWebhook } from '@haip/sdk';
import { sha256 } from '../deployment/adapters/evidence.mjs';
import { createApp } from '../haip-server/src/server.js';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { environment } from './environment.js';
import { localCertificates } from './fixtures/certificates.js';
import { freePort, postgres } from './fixtures/postgres.js';

async function listen(server: Server, port = 0) {
  await once(server.listen(port, '127.0.0.1'), 'listening');
  return (server.address() as AddressInfo).port;
}

const execute = promisify(execFile);
const listenerAddress = (host: string, port: number) => 'https://' + host + ':' + port;

test(
  'notification acceptance follows the received link and checks signed delivery, durable replay and redirect refusal',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haip-notification-acceptance-'));
    const port = await freePort();
    const messages: { recipient: string; raw: string; at: string }[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['AUTH', 'STARTTLS'],
      onData(stream: any, session: any, done: any) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          messages.push({
            recipient: session.envelope.rcptTo[0].address,
            raw: Buffer.concat(chunks).toString(),
            at: new Date().toISOString(),
          });
          done();
        });
      },
    });
    let env: Awaited<ReturnType<typeof environment>> | undefined;
    let pg: Awaited<ReturnType<typeof postgres>> | undefined;
    let deliveryDb: Pool | undefined;
    let replayDb: Pool | undefined;
    const listeners: Server[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let running: Promise<unknown> | undefined;
    let workerError: unknown;
    try {
      await new Promise<void>((done) => smtp.listen(port, '127.0.0.1', done));
      const local = await environment({
        singleTenant: true,
        smtp: { host: '127.0.0.1', port, secure: false, from: 'review@test.invalid' },
      });
      env = local;
      const testPg = (pg = await postgres());
      const livePool = (deliveryDb = new Pool({ connectionString: testPg.url }));
      await livePool.query('CREATE SCHEMA haip_replay');
      const replayPool = (replayDb = new Pool({
        connectionString: testPg.url,
        options: '-c search_path=haip_replay',
      }));
      const liveInbox = new PostgresWebhookInbox(livePool);
      const replayInbox = new PostgresWebhookInbox(replayPool);
      await Promise.all([liveInbox.migrate(), replayInbox.migrate()]);

      const trustedHost = 'review.trusted.test';
      const receiverHost = 'receiver.fixture.test';
      const cert = await localCertificates(directory, [
        'DNS:' + trustedHost,
        'DNS:' + receiverHost,
      ]);
      const [key, serverCert] = await Promise.all([
        readFile(cert.keyPath),
        readFile(cert.certPath),
      ]);
      const pin = createHash('sha256')
        .update(new X509Certificate(serverCert).publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64');
      const haipPort = await freePort();
      const origin = listenerAddress(trustedHost, haipPort);
      local.service.config.origin = local.service.config.issuer = local.trust.issuer = origin;
      const trusted = httpsServer(
        { key, cert: serverCert },
        createApp(local.service, { exactHost: true }),
      );
      await listen(trusted, haipPort);
      listeners.push(trusted);
      const identity = { issuer: origin, tenant: 'test-tenant', producer: 'producer' };

      const observed = new Map<
        string,
        { envelope: SignedRecord; committed_at: string; acknowledged_at: string }
      >();
      let redirectEnabled = false;
      let redirectObservation:
        { envelope: SignedRecord; location: string; response_status: number } | undefined;
      let targetHits = 0;
      let expiredRefusals = 0;
      const redirectUrl = 'https://' + receiverHost + '/redirect-target';
      const receiver = httpsServer({ key, cert: serverCert }, async (req, res) => {
        if (req.url === '/redirect-target') {
          targetHits++;
          res.writeHead(204).end();
          return;
        }
        try {
          assert.equal(req.method, 'POST');
          assert.ok(req.url === '/events' || req.url === '/replay');
          const envelope = parseJson(
            Buffer.concat(await Array.fromAsync(req)).toString(),
          ) as SignedRecord;
          const delivery = verifyWebhook(envelope, local.trust, identity);
          if (req.url === '/events' && redirectEnabled) {
            redirectObservation = { envelope, location: redirectUrl, response_status: 302 };
            res.writeHead(302, { Location: redirectUrl }).end();
            return;
          }
          const [inbox, database] =
            req.url === '/events' ? [liveInbox, livePool] : [replayInbox, replayPool];
          await inbox.persist(delivery);
          const row = (
            await database.query(
              'SELECT digest FROM haip_received_events WHERE issuer=$1 AND tenant=$2 AND producer=$3 AND event_id=$4',
              [
                identity.issuer,
                identity.tenant,
                identity.producer,
                delivery.event.payload.event_id,
              ],
            )
          ).rows[0];
          assert.equal(row.digest, digest(delivery.event));
          const committed = new Date().toISOString();
          if (req.url === '/events')
            observed.set(delivery.event.payload.request_id + '/' + delivery.event.payload.reason, {
              envelope,
              committed_at: committed,
              acknowledged_at: new Date().toISOString(),
            });
          res.writeHead(204).end();
        } catch (error) {
          if (error instanceof Error && error.message === 'webhook_replay_window')
            expiredRefusals++;
          res.writeHead(400).end();
        }
      });
      const receiverPort = await listen(receiver);
      listeners.push(receiver);

      const recipient = 'requester@test.invalid';
      await local.principal('requester', 'human', {
        enabled: true,
        identity_certain: true,
        oidc_issuer: local.service.config.oidc.issuer,
        oidc_subject: 'requester',
        email_verified: true,
        email: recipient,
      });
      await local.put('/v2/admin/routes/review', { ...local.route, reviewers: ['reviewer'] });

      const replaySample = await local.api('/v2/requests', local.request());
      assert.equal(replaySample.status, 201);
      const expiredId = replaySample.body.request.id as string;
      const event = (await local.api('/v2/events')).body.items.find(
        ({ payload }: any) => payload.request_id === expiredId,
      );
      const earlier = new Date(Date.now() - 301_000);
      const principal = {
        id: identity.producer,
        tenant: identity.tenant,
        kind: 'producer' as const,
        config: { enabled: true },
      };
      const pastEvent = local.service.signed(
        'RequestChangedEvent',
        event.payload,
        principal,
        earlier,
        replaySample.body.request,
      );
      const expired = local.service.signed(
        'WebhookDelivery',
        {
          delivery_id: randomUUID(),
          event_id: event.payload.event_id,
          timestamp: earlier.toISOString(),
          event: pastEvent,
        },
        principal,
        earlier,
      );

      local.service.config.webhookHosts = [receiverHost];
      await local.principal(
        'producer',
        'producer',
        {
          enabled: true,
          publisher: 'publisher',
          owner: 'requester',
          routes: ['review'],
          webhook: 'https://' + receiverHost + '/events',
        },
        local.credentials.producer,
      );
      const probe = randomUUID();
      const created = await local.api(
        '/v2/requests',
        local.request(false, {
          summary: 'Private notification fixture',
          metadata: { haip_acceptance_fixture: 'notifications', haip_acceptance_probe: probe },
        }),
      );
      assert.equal(created.status, 201);
      const reviewId = created.body.request.id as string;
      const worker = new OutboxWorker(local.service, local.anchor, {
        webhookTransport: {
          resolve: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
          request: ((url: URL, options: any, callback: any) =>
            request(
              {
                ...options,
                hostname: '127.0.0.1',
                port: receiverPort,
                path: url.pathname,
                servername: receiverHost,
                ca: cert.ca,
                lookup: (_hostname: string, opts: any, cb: any) =>
                  opts.all
                    ? cb(null, [{ address: '127.0.0.1', family: 4 }])
                    : cb(null, '127.0.0.1', 4),
              },
              callback,
            )) as typeof request,
        },
      });
      timer = setInterval(() => {
        if (!running && !workerError)
          running = worker
            .tick()
            .catch((failure) => {
              workerError = failure;
            })
            .finally(() => {
              running = undefined;
            });
      }, 40);

      const plan = JSON.parse(await readFile('deployment/acceptance.plan.example.json', 'utf8'));
      plan.source.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      plan.deployment.trusted_origin = origin;
      plan.deployment.sandbox_origin_pattern = 'https://{scope}.sandbox.test';
      const planPath = join(directory, 'plan.json');
      const settingsPath = join(directory, 'notifications.json');
      const evidence = join(directory, 'evidence');
      const command = join(directory, 'observe.mjs');
      const harness = join(directory, 'fixture.mjs');
      const reportPath = join(directory, 'report.json');
      const adapterNames = [
        'HAIP_ACCEPTANCE_NOTIFICATION_PRODUCER_TOKEN',
        'HAIP_TEST_NOTIFICATION_OBSERVER',
        'HAIP_TEST_NOTIFICATION_KEY',
        'PLAYWRIGHT_BROWSERS_PATH',
      ];
      plan.adapter_env = adapterNames;
      plan.secret_env = [
        'HAIP_ACCEPTANCE_NOTIFICATION_PRODUCER_TOKEN',
        'HAIP_TEST_NOTIFICATION_KEY',
      ];
      const selected = plan.checks.find(({ id }: { id: string }) => id === 'notifications');
      selected.timeout_ms = 45_000;
      selected.command = [
        process.execPath,
        harness,
        planPath,
        evidence,
        settingsPath,
        cert.caPath,
        pin,
        local.service.config.oidc.issuer,
      ];
      delete selected.unrun_reason;
      const planBytes = JSON.stringify(plan);
      const planDigest = sha256(planBytes);
      const controlKey = randomBytes(32).toString('base64url');
      let observedMailbox = false;
      const control = httpServer(async (req, res) => {
        try {
          assert.equal(req.headers.authorization, 'Bearer ' + controlKey);
          const [action, id, digest_, value] = JSON.parse(
            Buffer.concat(await Array.fromAsync(req)).toString(),
          );
          assert.equal(id, probe);
          assert.equal(digest_, planDigest);
          let output: unknown = null;
          switch (action) {
            case 'mail': {
              assert.equal(value, reviewId);
              const link = origin + '/review/' + value;
              const mail = messages.find(
                (message) =>
                  message.recipient === recipient &&
                  message.raw
                    .replace(/=\r?\n/g, '')
                    .split(/\r?\n/)
                    .includes(link),
              );
              if (mail) {
                observedMailbox = true;
                output = {
                  recipient,
                  review_link: link,
                  received_at: mail.at,
                  message_digest: sha256(mail.raw),
                };
              }
              break;
            }
            case 'deliveries': {
              assert.equal(value, reviewId);
              const created = observed.get(value + '/created');
              const decision = observed.get(value + '/decision');
              if (created && decision) output = { created, decision };
              break;
            }
            case 'replay_state': {
              assert.ok(value === reviewId || value === expiredId);
              const { rows } = await replayPool.query(
                'SELECT event_id,digest AS event_digest,revision::int FROM haip_received_events WHERE request_id=$1',
                [value],
              );
              const pending = await replayInbox.pendingRefreshes(identity);
              output = {
                rows,
                pending_revision:
                  pending.find(({ requestId }) => requestId === value)?.revision ?? 0,
              };
              break;
            }
            case 'expired':
              assert.equal(value, expiredId);
              output = expired;
              break;
            case 'arm_redirect':
              assert.equal(value, redirectUrl);
              redirectEnabled = true;
              break;
            case 'restore_redirect':
              redirectEnabled = false;
              break;
            case 'redirect':
              if (
                (redirectObservation?.envelope.payload as any)?.event.payload.request_id === value
              )
                output = { ...redirectObservation, target_hits: targetHits };
              break;
            default:
              throw new Error('Unknown observation');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
        } catch {
          res.writeHead(400).end();
        }
      });
      const controlPort = await listen(control);
      listeners.push(control);
      const settings = {
        plan_digest: planDigest,
        probe_id: probe,
        tenant: identity.tenant,
        producer: identity.producer,
        review_id: reviewId,
        expired_request_id: expiredId,
        recipient,
        requester: 'requester',
        reviewer: 'reviewer',
        trust_manifest: local.trust,
        replay_endpoint: listenerAddress(receiverHost, receiverPort) + '/replay',
        redirect_target: redirectUrl,
        control_command: [process.execPath, command],
        control_env: ['HAIP_TEST_NOTIFICATION_OBSERVER', 'HAIP_TEST_NOTIFICATION_KEY'],
      };
      await Promise.all([
        writeFile(planPath, planBytes, { mode: 0o600 }),
        writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }),
        writeFile(
          harness,
          `
import { readFile } from 'node:fs/promises';
import { collectNotifications } from ${JSON.stringify(pathToFileURL(resolve('deployment/adapters/notifications.mjs')).href)};
const [plan, evidence, settings, caPath, pin, issuer] = process.argv.slice(2);
const result = await collectNotifications(plan, evidence, settings, {
  fixture: {
    ca: await readFile(caPath),
    pins: [pin],
    issuer,
    async signIn(page, subject) {
      await page.getByRole('textbox', { name: 'User' }).fill(subject);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    },
    async confirm(page) {
      await page.getByLabel('Response (JSON)').fill('{"choice":"accept"}');
      await page.getByRole('button', { name: 'Review this response' }).click();
      await page.getByRole('button', { name: 'Confirm this exact response' }).click();
    },
  },
});
console.log(JSON.stringify(result));
`,
          { mode: 0o600 },
        ),
        writeFile(
          command,
          `
import assert from 'node:assert/strict';
assert.equal(process.env.HAIP_ACCEPTANCE_NOTIFICATION_PRODUCER_TOKEN, undefined);
const response = await fetch(process.env.HAIP_TEST_NOTIFICATION_OBSERVER, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.HAIP_TEST_NOTIFICATION_KEY },
  body: JSON.stringify(process.argv.slice(2)),
  signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 200);
console.log(await response.text());
`,
          { mode: 0o600 },
        ),
      ]);
      await execute(
        process.execPath,
        [
          'deployment/run-acceptance.mjs',
          planPath,
          reportPath,
          '--allow-dirty',
          '--allow-incomplete',
        ],
        {
          timeout: 50_000,
          env: {
            PATH: process.env.PATH,
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
            HAIP_ACCEPTANCE_NOTIFICATION_PRODUCER_TOKEN: local.credentials.producer,
            HAIP_TEST_NOTIFICATION_OBSERVER: 'http://127.0.0.1:' + controlPort,
            HAIP_TEST_NOTIFICATION_KEY: controlKey,
          },
        },
      );
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      assert.equal(report.summary.accepted, false);
      const result = report.checks.find(({ id }: { id: string }) => id === 'notifications');
      assert.equal(result.status, 'blocked', result.summary);
      assert.equal(result.facts.scope, 'local_fixture');
      assert.ok(
        result.assertions.length === 9 &&
          result.assertions.every(({ passed }: { passed: boolean }) => passed),
      );
      assert.equal(observedMailbox, true);
      assert.equal(expiredRefusals, 1);
      assert.equal(targetHits, 0);
      assert.equal(redirectEnabled, false);
      assert.equal(workerError, undefined);
      const record = result.evidence[0];
      const raw = await readFile(
        join(evidence, record.reference.slice('private-evidence:'.length)),
      );
      assert.equal(record.digest, sha256(raw));
      for (const privateValue of [
        local.credentials.producer,
        controlKey,
        recipient,
        'Private notification fixture',
        reviewId,
      ])
        assert.ok(!raw.includes(privateValue));
    } finally {
      clearInterval(timer);
      await running;
      await Promise.all(
        listeners.map((server) => new Promise<void>((done) => server.close(() => done()))),
      );
      await Promise.all([deliveryDb?.end(), replayDb?.end(), env?.close()]);
      await pg?.close();
      await new Promise<void>((done) => smtp.close(done));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
