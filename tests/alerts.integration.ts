import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { environment } from './environment.js';
import { freePort } from './fixtures/postgres.js';

const execute = promisify(execFile);

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const address = `127.0.0.1:${(server.address() as { port: number }).port}`;
  return { address, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type RoutedAlert = {
  status: 'firing' | 'resolved';
  labels: { alertname: string; instance: string };
};

test(
  'Prometheus sends worker and scrape alerts through Alertmanager',
  { timeout: 125_000 },
  async () => {
    const env = await environment();
    const directory = await mkdtemp(join(tmpdir(), 'haip-alerts-'));
    const notifications: RoutedAlert[] = [];
    const receiver = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          notifications.push(...body.alerts);
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
    });
    const failedScrape = await listen((_request, response) => response.writeHead(503).end());
    const children: ReturnType<typeof execute>[] = [];
    function start(binary: string, args: string[]) {
      const launched = execute(binary, args, { cwd: directory, timeout: 115_000 });
      void launched.catch(() => {});
      children.push(launched);
    }
    async function waitForAlerts(
      status: RoutedAlert['status'],
      expected: string[],
      timeoutMs: number,
    ) {
      const deadline = performance.now() + timeoutMs;
      while (!expected.every((key) => received(status).has(key)) && performance.now() < deadline) {
        for (const child of children) {
          if (
            !child.child.pid ||
            child.child.exitCode !== null ||
            child.child.signalCode !== null
          ) {
            await child;
            throw new Error('Monitoring process exited during rehearsal');
          }
        }
        await delay(250);
      }
      assert.deepEqual([...received(status)].sort(), [...expected].sort());
    }
    const received = (status: RoutedAlert['status']) =>
      new Set(
        notifications
          .filter((alert) => alert.status === status)
          .map((alert) => `${alert.labels.alertname}:${alert.labels.instance}`),
      );

    try {
      const prometheusAddr = `127.0.0.1:${await freePort()}`;
      const alertmanagerAddr = `127.0.0.1:${await freePort()}`;
      const liveScrape = new URL(env.origin).host;
      const authPath = join(directory, 'operator-token');
      const rulesPath = resolve('deployment/alerts.yml');
      const promPath = join(directory, 'prometheus.json');
      const alertPath = join(directory, 'alertmanager.json');
      await Promise.all([
        writeFile(authPath, env.credentials.operator, { mode: 0o600 }),
        writeFile(
          promPath,
          JSON.stringify({
            global: { scrape_interval: '1s', evaluation_interval: '1s' },
            rule_files: [rulesPath],
            alerting: { alertmanagers: [{ static_configs: [{ targets: [alertmanagerAddr] }] }] },
            scrape_configs: [
              {
                job_name: 'haip',
                scrape_timeout: '800ms',
                metrics_path: '/v2/admin/metrics.prom',
                authorization: { credentials_file: authPath },
                static_configs: [{ targets: [liveScrape, failedScrape.address] }],
              },
            ],
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
                  { url: `http://${receiver.address}/alerts`, send_resolved: true },
                ],
              },
            ],
          }),
          { mode: 0o600 },
        ),
      ]);
      await env.worker.tick();
      await env.worker.cleanup();
      await env.store.pool.query(
        "UPDATE haip_tenant_operations SET succeeded_at=clock_timestamp()-interval '1 hour' WHERE tenant='test-tenant' AND name IN ('outbox','retention')",
      );
      start('alertmanager', [
        '--config.file=' + alertPath,
        '--storage.path=' + join(directory, 'alertmanager'),
        '--web.listen-address=' + alertmanagerAddr,
        '--cluster.listen-address=',
      ]);
      start('prometheus', [
        '--config.file=' + promPath,
        '--storage.tsdb.path=' + join(directory, 'prometheus'),
        '--web.listen-address=' + prometheusAddr,
      ]);
      const workerAlerts = [
        `HAIPOutboxWorkerStalled:${liveScrape}`,
        `HAIPRetentionWorkerStalled:${liveScrape}`,
      ];
      await waitForAlerts(
        'firing',
        [...workerAlerts, `HAIPScrapeUnavailable:${failedScrape.address}`],
        90_000,
      );
      await env.worker.tick();
      await env.worker.cleanup();
      await waitForAlerts('resolved', workerAlerts, 15_000);
    } finally {
      for (const child of children) child.child.kill('SIGTERM');
      await Promise.allSettled(children);
      await Promise.all([receiver.close(), failedScrape.close(), env.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
