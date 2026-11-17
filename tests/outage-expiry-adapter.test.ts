import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { digest } from '@haip/protocol/crypto';
import { sha256 } from '../deployment/adapters/evidence.mjs';
import { RecoveryGuard } from '../haip-server/src/recovery.js';
import { createApp } from '../haip-server/src/server.js';
import { environment } from './environment.js';
import { localCertificates } from './fixtures/certificates.js';
import { TestSafetyStore } from './fixtures/safety.js';

const execute = promisify(execFile);

async function listen(server: Server) {
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return (server.address() as AddressInfo).port;
}

async function close(server?: Server) {
  if (server) await new Promise<void>((done) => server.close(() => done()));
}

test(
  'the acceptance runner verifies outage through expiry and requires a successful recovery control',
  { timeout: 55_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haip-outage-'));
    const env = await environment({ singleTenant: true });
    let trusted: Server | undefined;
    let controller: Server | undefined;
    try {
      const cert = await localCertificates(directory, ['DNS:review.trusted.test']);
      trusted = httpsServer(
        { key: await readFile(cert.keyPath), cert: await readFile(cert.certPath) },
        createApp(env.service),
      );
      const origin = 'https://review.trusted.test:' + (await listen(trusted));
      env.service.config.issuer = env.trust.issuer = origin;
      env.service.recovery = new RecoveryGuard(
        env.service,
        new TestSafetyStore(join(directory, 'safety')),
      );
      await env.worker.reconcile();

      const controlKey = randomBytes(32).toString('base64url');
      type Mode = 'restored' | 'still-unavailable' | 'begin-ack-lost';
      let currentProbe: { id: string; planDigest: string; mode: Mode } | undefined;
      const actions: string[] = [];
      controller = httpServer(async (incoming, response) => {
        try {
          assert.equal(incoming.headers.authorization, 'Bearer ' + controlKey);
          assert.equal(incoming.method, 'POST');
          const arguments_ = JSON.parse(
            await Array.fromAsync(incoming).then((chunks) => Buffer.concat(chunks).toString()),
          );
          const [action, probe, planDigest, lease] = arguments_;
          assert.equal(probe, currentProbe?.id);
          assert.equal(planDigest, currentProbe?.planDigest);
          assert.ok(Number.isInteger(Number(lease)) && Number(lease) >= 60 && Number(lease) <= 240);
          assert.ok(action === 'begin' || action === 'restore');
          actions.push(action);
          env.anchor.unavailable = action === 'begin' || currentProbe!.mode === 'still-unavailable';
          response
            .writeHead(action === 'begin' && currentProbe!.mode === 'begin-ack-lost' ? 503 : 204)
            .end();
        } catch {
          response.writeHead(400).end();
        }
      });
      const controllerUrl = 'http://127.0.0.1:' + (await listen(controller));
      const controllerPath = join(directory, 'controller.mjs');
      await writeFile(
        controllerPath,
        `
import assert from 'node:assert/strict';
assert.equal(process.env.HAIP_ACCEPTANCE_OUTAGE_PRODUCER_TOKEN, undefined);
const response = await fetch(process.env.HAIP_TEST_CONTROL_URL, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.HAIP_TEST_CONTROL_KEY },
  body: JSON.stringify(process.argv.slice(2)),
  signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 204);
`,
        { mode: 0o600 },
      );
      const checkEnv = {
        PATH: process.env.PATH,
        HAIP_ACCEPTANCE_OUTAGE_PRODUCER_TOKEN: env.credentials.producer,
        HAIP_TEST_CONTROL_URL: controllerUrl,
        HAIP_TEST_CONTROL_KEY: controlKey,
      };

      const reviewer = await env.login();
      async function prepare(probe: string, role: string) {
        const input = env.request(true, {
          summary: 'A private outage canary',
          metadata: {
            haip_acceptance_fixture: 'outage_expiry',
            haip_acceptance_probe: probe,
            haip_acceptance_role: role,
          },
        });
        if (role !== 'control')
          input.execution!.valid_until = new Date(Date.now() + 7000).toISOString();
        const created = await env.api('/v2/requests', input);
        assert.equal(created.status, 201);
        const request = created.body.request;
        const candidate = await reviewer.call(`/v2/requests/${request.id}/candidates`, {
          decision: 'authorise',
          response: { choice: 'accept' },
        });
        assert.equal(candidate.status, 201);
        const confirmed = await reviewer.call(`/v2/requests/${request.id}/confirm`, {
          candidate_id: candidate.body.id,
          candidate_digest: digest(candidate.body),
        });
        assert.equal(confirmed.status, 200);
        return request.id as string;
      }

      const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
      for (const mode of ['restored', 'still-unavailable', 'begin-ack-lost'] as const) {
        const probe = randomUUID();
        const control = await prepare(probe, 'control');
        const fresh = await prepare(probe, 'fresh');
        const preclaim = await prepare(probe, 'preclaim');
        await env.flush();

        const planPath = join(directory, mode + '-plan.json');
        const evidenceDirectory = join(directory, 'evidence');
        const settingsPath = join(directory, mode + '-settings.json');
        const reportPath = join(directory, mode + '-report.json');
        const plan = JSON.parse(await readFile('deployment/acceptance.plan.example.json', 'utf8'));
        Object.assign(plan.deployment, {
          environment: 'local-outage-fixture',
          trusted_origin: origin,
          sandbox_origin_pattern: 'https://{scope}.sandbox.test',
        });
        plan.source.commit = commit;
        plan.adapter_env = Object.keys(checkEnv).filter((name) => name !== 'PATH');
        plan.secret_env = ['HAIP_ACCEPTANCE_OUTAGE_PRODUCER_TOKEN', 'HAIP_TEST_CONTROL_KEY'];
        const check = plan.checks.find(({ id }: { id: string }) => id === 'outage_expiry');
        check.command = [
          process.execPath,
          'deployment/adapters/outage-expiry.mjs',
          planPath,
          evidenceDirectory,
          settingsPath,
          '--fixture-ca',
          cert.caPath,
        ];
        check.timeout_ms = 22_000;
        delete check.unrun_reason;
        const planBytes = JSON.stringify(plan);
        currentProbe = {
          id: probe,
          planDigest: sha256(planBytes),
          mode,
        };
        const settings = {
          plan_digest: currentProbe.planDigest,
          probe_id: probe,
          tenant: 'test-tenant',
          producer: 'producer',
          requests: { fresh, preclaim, control },
          trust_manifest: env.trust,
          control_command: [process.execPath, controllerPath],
          control_env: ['HAIP_TEST_CONTROL_URL', 'HAIP_TEST_CONTROL_KEY'],
        };
        await Promise.all([
          writeFile(planPath, planBytes, { mode: 0o600 }),
          writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }),
        ]);
        actions.length = 0;
        await execute(
          process.execPath,
          [
            'deployment/run-acceptance.mjs',
            planPath,
            reportPath,
            '--allow-dirty',
            '--allow-incomplete',
          ],
          { env: checkEnv, timeout: 24_000 },
        );
        const raw = await readFile(reportPath, 'utf8');
        const report = JSON.parse(raw);
        assert.equal(report.summary.accepted, false);
        const observed = report.checks.find(({ id }: { id: string }) => id === 'outage_expiry');
        assert.equal(observed.status, mode === 'restored' ? 'blocked' : 'failed', observed.summary);
        assert.equal(observed.facts.scope, 'local_fixture');
        assert.deepEqual(actions, ['begin', 'restore']);
        assert.deepEqual(
          observed.assertions.map(({ name, passed }: { name: string; passed: boolean }) => [
            name,
            passed,
          ]),
          mode === 'begin-ack-lost'
            ? [
                ['bound_canaries', true],
                ['claim_before_outage', true],
                ['restore_checkpoint_access', true],
                ['start_outage', false],
              ]
            : [
                ['bound_canaries', true],
                ['claim_before_outage', true],
                ['refused_during_outage', true],
                ['outage_crossed_expiry', true],
                ['restore_checkpoint_access', true],
                ['expired_after_restore', true],
                ['restored_control', mode === 'restored'],
              ],
        );
        assert.equal(env.anchor.unavailable, mode === 'still-unavailable');
        const record = observed.evidence[0];
        const evidence = await readFile(
          join(evidenceDirectory, record.reference.slice('private-evidence:'.length)),
          'utf8',
        );
        assert.equal(record.digest, sha256(evidence));
        for (const privateValue of [
          controlKey,
          env.credentials.producer,
          'A private outage canary',
        ]) {
          assert.ok(!raw.includes(privateValue));
          assert.ok(!evidence.includes(privateValue));
        }
        if (mode === 'restored') {
          const states = await Promise.all(
            [fresh, preclaim, control].map((id) => env.api('/v2/requests/' + id)),
          );
          assert.deepEqual(
            states.map(({ body }) => [body.grant_state, body.execution_state, body.outcome]),
            [
              ['expired', 'unclaimed', null],
              ['consumed', 'claimed', null],
              ['consumed', 'admitted', null],
            ],
          );
        }
        env.anchor.unavailable = false;
      }
    } finally {
      await Promise.all([close(trusted), close(controller), env.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
