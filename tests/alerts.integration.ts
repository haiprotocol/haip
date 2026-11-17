import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { digest } from '@haip/protocol/crypto';
import { sha256 } from '../deployment/adapters/evidence.mjs';
import { collectOperations } from '../deployment/adapters/operations.mjs';
import { createApp } from '../haip-server/src/server.js';
import { environment } from './environment.js';
import { localCertificates } from './fixtures/certificates.js';
import { freePort } from './fixtures/postgres.js';

const execute = promisify(execFile);
const metricsPath = '/v2/admin/metrics.prom';

type AlertmanagerNotification = {
  receiver: string;
  alerts: {
    status: 'firing' | 'resolved';
    labels: { alertname: string; job: string; instance: string };
    fingerprint: string;
    startsAt: string;
    endsAt: string;
  }[];
};

test(
  'operations acceptance checks controls and matches each routed alert to its resolution',
  { timeout: 165_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haip-alerts-'));
    const children: ReturnType<typeof execute>[] = [];
    const listeners: Server[] = [];
    let env: Awaited<ReturnType<typeof environment>> | undefined;

    async function listen(server: Server, port = 0) {
      listeners.push(server);
      await once(server.listen(port, '127.0.0.1'), 'listening');
      return (server.address() as AddressInfo).port;
    }

    function start(binary: string, args: string[]) {
      const launched = execute(binary, args, { cwd: directory, timeout: 155_000 });
      void launched.catch(() => {});
      children.push(launched);
    }

    try {
      const local = (env = await environment({ singleTenant: true }));
      const trustedHost = 'review.trusted.test';
      const monitorHost = 'monitor.fixture.test';
      const certificate = await localCertificates(directory, [
        'DNS:' + trustedHost,
        'DNS:' + monitorHost,
        'IP:127.0.0.1',
      ]);
      const tls = {
        key: await readFile(certificate.keyPath),
        cert: await readFile(certificate.certPath),
      };
      const haipPort = await freePort();
      const prometheusPort = await freePort();
      const alertmanagerPort = await freePort();
      const haipOrigin = 'https://' + trustedHost + ':' + haipPort;
      local.service.config.origin = local.service.config.issuer = local.trust.issuer = haipOrigin;
      await listen(httpsServer(tls, createApp(local.service)), haipPort);

      let canaryHealthy = true;
      const canaryPort = await listen(
        httpsServer(tls, (request, response) => {
          if (request.url !== metricsPath) return response.writeHead(404).end();
          if (!canaryHealthy) return response.writeHead(503).end();
          response
            .writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
            .end('haip_canary 1\n');
        }),
      );
      function target(port: number) {
        const instance = '127.0.0.1:' + port;
        return { job: 'haip', instance, scrape_url: 'https://' + instance + metricsPath };
      }
      const targets = { runtime: target(haipPort), canary: target(canaryPort) };

      const notifications: ReturnType<typeof observation>[] = [];
      function observation(
        message: AlertmanagerNotification,
        alert: AlertmanagerNotification['alerts'][number],
      ) {
        return {
          receiver: message.receiver,
          status: alert.status,
          labels: alert.labels,
          fingerprint: alert.fingerprint,
          starts_at: alert.startsAt,
          ends_at: alert.endsAt,
          received_at: new Date().toISOString(),
        };
      }
      const receiverPort = await listen(
        httpServer(async (request, response) => {
          try {
            assert.equal(request.url, '/alerts');
            const message: AlertmanagerNotification = JSON.parse(
              Buffer.concat(await Array.fromAsync(request)).toString(),
            );
            notifications.push(...message.alerts.map((alert) => observation(message, alert)));
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        }),
      );

      const planPath = join(directory, 'plan.json');
      const settingsPath = join(directory, 'operations.json');
      const reportPath = join(directory, 'report.json');
      const evidence = join(directory, 'evidence');
      const command = join(directory, 'control.mjs');
      const harness = join(directory, 'fixture.mjs');
      const plan = JSON.parse(await readFile('deployment/acceptance.plan.example.json', 'utf8'));
      plan.source.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      plan.deployment.trusted_origin = haipOrigin;
      plan.deployment.sandbox_origin_pattern = 'https://{scope}.sandbox.test';
      plan.adapter_env = [
        'HAIP_ACCEPTANCE_OPERATIONS_OPERATOR_TOKEN',
        'HAIP_TEST_OPERATIONS_CONTROL',
        'HAIP_TEST_OPERATIONS_KEY',
      ];
      plan.secret_env = ['HAIP_ACCEPTANCE_OPERATIONS_OPERATOR_TOKEN', 'HAIP_TEST_OPERATIONS_KEY'];
      const selected = plan.checks.find(({ id }: { id: string }) => id === 'operations');
      selected.timeout_ms = 145_000;
      selected.command = [
        process.execPath,
        harness,
        planPath,
        evidence,
        settingsPath,
        certificate.caPath,
      ];
      delete selected.unrun_reason;
      const planBytes = JSON.stringify(plan);
      const planDigest = sha256(planBytes);
      const probe = randomUUID();
      const controlKey = randomBytes(32).toString('base64url');
      const mutations: string[] = [];
      const controlPort = await listen(
        httpServer(async (request, response) => {
          try {
            assert.equal(request.headers.authorization, 'Bearer ' + controlKey);
            const args = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
            const [action, id, source, ...extra] = args;
            assert.deepEqual([id, source, ...extra], [probe, planDigest]);
            let output: unknown = null;
            switch (action) {
              case 'receipts':
                output = notifications;
                break;
              case 'stall':
                mutations.push(action);
                canaryHealthy = false;
                await local.store.pool.query(
                  "UPDATE haip_tenant_operations SET succeeded_at=clock_timestamp()-interval '1 hour' WHERE tenant='test-tenant' AND name IN ('outbox','retention')",
                );
                break;
              case 'recover':
                mutations.push(action);
                canaryHealthy = true;
                await local.worker.tick();
                await local.worker.cleanup();
                break;
              default:
                throw new Error('Unknown operation');
            }
            response
              .writeHead(200, { 'Content-Type': 'application/json' })
              .end(JSON.stringify(output));
          } catch {
            response.writeHead(400).end();
          }
        }),
      );
      const adapterEnv = {
        PATH: process.env.PATH,
        HAIP_ACCEPTANCE_OPERATIONS_OPERATOR_TOKEN: local.credentials.operator,
        HAIP_TEST_OPERATIONS_CONTROL: 'http://127.0.0.1:' + controlPort,
        HAIP_TEST_OPERATIONS_KEY: controlKey,
      };
      await mkdir(evidence, { mode: 0o700 });
      async function controlEvidence(file: string) {
        const bytes = 'Fixture only: ' + file;
        const path = join(evidence, file);
        await writeFile(path, bytes, { mode: 0o600 });
        return { file, digest: sha256(bytes), recorded_at: new Date().toISOString() };
      }
      const [keys, disks, backups] = await Promise.all(
        ['keys.txt', 'disks.txt', 'backups.txt'].map(controlEvidence),
      );
      const settings = {
        plan_digest: planDigest,
        probe_id: probe,
        prometheus_origin: 'https://' + monitorHost + ':' + prometheusPort,
        receiver: 'fixture',
        targets,
        control_command: [process.execPath, command],
        control_env: ['HAIP_TEST_OPERATIONS_CONTROL', 'HAIP_TEST_OPERATIONS_KEY'],
        control_observations: {
          plan_digest: planDigest,
          observer: 'fixture-operator',
          keys: {
            custodian: 'fixture-custodian',
            trust_out_of_band: true,
            historical_keys_retained: true,
            backup_key_separate: true,
            trust_manifest_digest: digest(local.trust),
            evidence: keys,
          },
          disks: {
            runtime_encrypted: true,
            database_encrypted: true,
            scratch_encrypted: true,
            evidence: disks,
          },
          backups: {
            private: true,
            encrypted: true,
            prune_observed: true,
            maximum_age_days: 30,
            interval_hours: 24,
            evidence: backups,
          },
        },
      };
      const authPath = join(directory, 'operator-token');
      const promPath = join(directory, 'prometheus.json');
      const webPath = join(directory, 'prometheus-web.json');
      const alertPath = join(directory, 'alertmanager.json');
      await Promise.all([
        writeFile(planPath, planBytes, { mode: 0o600 }),
        writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }),
        writeFile(
          harness,
          `
import { readFile } from 'node:fs/promises';
import { collectOperations } from ${JSON.stringify(pathToFileURL(resolve('deployment/adapters/operations.mjs')).href)};
const [plan, evidence, settings, caPath] = process.argv.slice(2);
const result = await collectOperations(plan, evidence, settings, { fixture: { ca: await readFile(caPath) } });
console.log(JSON.stringify(result));
`,
          { mode: 0o600 },
        ),
        writeFile(
          command,
          `
import assert from 'node:assert/strict';
assert.equal(process.env.HAIP_ACCEPTANCE_OPERATIONS_OPERATOR_TOKEN, undefined);
const response = await fetch(process.env.HAIP_TEST_OPERATIONS_CONTROL, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.HAIP_TEST_OPERATIONS_KEY },
  body: JSON.stringify(process.argv.slice(2)),
  signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 200);
console.log(await response.text());
`,
          { mode: 0o600 },
        ),
        writeFile(authPath, local.credentials.operator, { mode: 0o600 }),
        writeFile(
          promPath,
          JSON.stringify({
            global: { scrape_interval: '1s', evaluation_interval: '1s' },
            rule_files: [resolve('deployment/alerts.yml')],
            alerting: {
              alertmanagers: [{ static_configs: [{ targets: ['127.0.0.1:' + alertmanagerPort] }] }],
            },
            scrape_configs: [
              {
                job_name: 'haip',
                scrape_timeout: '800ms',
                scheme: 'https',
                tls_config: { ca_file: certificate.caPath },
                metrics_path: metricsPath,
                authorization: { credentials_file: authPath },
                static_configs: [{ targets: [targets.runtime.instance, targets.canary.instance] }],
              },
            ],
          }),
          { mode: 0o600 },
        ),
        writeFile(
          webPath,
          JSON.stringify({
            tls_server_config: { cert_file: certificate.certPath, key_file: certificate.keyPath },
          }),
          { mode: 0o600 },
        ),
        writeFile(
          alertPath,
          JSON.stringify({
            route: {
              receiver: 'fixture',
              group_by: ['alertname'],
              group_wait: '0s',
              group_interval: '1s',
            },
            receivers: [
              {
                name: 'fixture',
                webhook_configs: [
                  { url: 'http://127.0.0.1:' + receiverPort + '/alerts', send_resolved: true },
                ],
              },
            ],
          }),
          { mode: 0o600 },
        ),
      ]);

      await writeFile(join(evidence, backups.file), 'Changed backup evidence');
      const rejected = await collectOperations(planPath, evidence, settingsPath, {
        environment: adapterEnv,
        fixture: { ca: certificate.ca },
      });
      assert.equal(rejected.status, 'failed');
      assert.deepEqual(
        rejected.assertions.map(({ name }: { name: string }) => name),
        ['operational_controls'],
      );
      assert.deepEqual(mutations, []);
      assert.equal(rejected.evidence.length, 1);
      await controlEvidence(backups.file);

      await local.worker.tick();
      await local.worker.cleanup();
      start('alertmanager', [
        '--config.file=' + alertPath,
        '--storage.path=' + join(directory, 'alertmanager'),
        '--web.listen-address=127.0.0.1:' + alertmanagerPort,
        '--cluster.listen-address=',
      ]);
      start('prometheus', [
        '--config.file=' + promPath,
        '--storage.tsdb.path=' + join(directory, 'prometheus'),
        '--web.listen-address=127.0.0.1:' + prometheusPort,
        '--web.config.file=' + webPath,
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
        { env: adapterEnv, timeout: 150_000 },
      );
      await execute(process.execPath, ['deployment/run-acceptance.mjs', '--validate', reportPath]);
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      const result = report.checks.find(({ id }: { id: string }) => id === 'operations');
      assert.equal(report.summary.accepted, false);
      assert.equal(result.status, 'blocked', result.summary);
      assert.equal(result.facts.scope, 'local_fixture');
      assert.equal(result.facts.alerts_routed, 3);
      assert.equal(result.facts.alerts_resolved, 3);
      assert.equal(result.assertions.length, 5);
      assert.ok(result.assertions.every(({ passed }: { passed: boolean }) => passed));
      assert.deepEqual(mutations, ['stall', 'recover']);
      for (const state of ['firing', 'resolved']) {
        const names = new Set(
          notifications
            .filter((item) => item.status === state)
            .map((item) => item.labels.alertname),
        );
        assert.deepEqual([...names].sort(), [
          'HAIPOutboxWorkerStalled',
          'HAIPRetentionWorkerStalled',
          'HAIPScrapeUnavailable',
        ]);
      }
      assert.deepEqual(
        result.evidence.map(({ name }: { name: string }) => name),
        ['key_custody', 'encrypted_disks', 'backup_retention', 'operations_observations'],
      );
      for (const entry of result.evidence) {
        const bytes = await readFile(
          join(evidence, entry.reference.slice('private-evidence:'.length)),
        );
        assert.equal(entry.digest, sha256(bytes));
        assert.ok(!bytes.includes(local.credentials.operator) && !bytes.includes(controlKey));
      }
    } finally {
      for (const child of children) child.child.kill('SIGTERM');
      await Promise.allSettled(children);
      await Promise.all([
        ...listeners.map((server) => new Promise<void>((done) => server.close(() => done()))),
        env?.close(),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
