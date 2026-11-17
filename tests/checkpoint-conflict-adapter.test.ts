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
import { digest, signRecord } from '@haip/protocol/crypto';
import { collectCheckpointConflict } from '../deployment/adapters/checkpoint-conflict.mjs';
import { sha256 } from '../deployment/adapters/evidence.mjs';
import { bootstrapTenant } from '../haip-server/src/admin.js';
import { AzureAnchor } from '../haip-server/src/anchor.js';
import { createApp } from '../haip-server/src/server.js';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { environment } from './environment.js';
import { azureFixture } from './fixtures/azure-acceptance.js';
import { localCertificates } from './fixtures/certificates.js';

const execute = promisify(execFile);
const cases = ['extra', 'missing', 'changed', 'deleted'] as const;
type Variant = (typeof cases)[number];

function versionedStorage() {
  const contents = new Map<string, { body: string; version: string; expiry: Date }>();
  const faults = new Map<string, Variant>();
  const puts: string[] = [];
  const container = {
    getBlockBlobClient(key: string) {
      return {
        async upload(
          body: string,
          bytes: number,
          options: { conditions: { ifNoneMatch: string } },
        ) {
          assert.equal(options.conditions.ifNoneMatch, '*');
          assert.equal(bytes, Buffer.byteLength(body));
          puts.push(key);
          if (contents.has(key)) throw { statusCode: 412 };
          const version = randomUUID();
          contents.set(key, { body, version, expiry: new Date(Date.now() + 91 * 86_400_000) });
          return { versionId: version };
        },
      };
    },
    async *listBlobsFlat(options: {
      prefix: string;
      includeVersions: boolean;
      includeDeleted: boolean;
      includeDeletedWithVersions: boolean;
    }) {
      assert.ok(
        options.includeVersions && options.includeDeleted && options.includeDeletedWithVersions,
      );
      for (const [name, object] of contents) {
        if (!name.startsWith(options.prefix)) continue;
        const fault = faults.get(name);
        const old = { name, versionId: object.version, isCurrentVersion: true };
        const newCurrent = { ...old, versionId: 'different-version' };
        if (fault === 'missing') continue;
        if (fault === 'changed' || fault === 'extra') yield newCurrent;
        if (fault !== 'changed')
          yield { ...old, isCurrentVersion: fault === undefined, deleted: fault === 'deleted' };
      }
    },
    getBlobClient(key: string) {
      return {
        withVersion(version: string) {
          const object = contents.get(key);
          assert.equal(object?.version, version);
          assert.equal(faults.has(key), false);
          const bytes = Buffer.from(object!.body);
          return {
            async getProperties() {
              return {
                versionId: version,
                immutabilityPolicyMode: 'locked',
                immutabilityPolicyExpiresOn: object!.expiry,
                contentLength: bytes.length,
                etag: '"retained"',
              };
            },
            async downloadToBuffer(
              offset: number,
              count: number,
              options: { conditions: { ifMatch: string } },
            ) {
              assert.equal(offset, 0);
              assert.equal(count, bytes.length);
              assert.equal(options.conditions.ifMatch, '"retained"');
              return bytes;
            },
          };
        },
      };
    },
  };
  return { container, contents, faults, puts };
}

async function listen(server: Server) {
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return (server.address() as AddressInfo).port;
}

const token = () => randomBytes(32).toString('base64url');

test(
  'the conflict adapter replays a signed checkpoint and observes each fault fence a real tenant',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haip-conflict-'));
    const env = await environment({ singleTenant: true });
    let trusted: Server | undefined;
    let controlServer: Server | undefined;
    try {
      const cert = await localCertificates(directory, ['DNS:review.trusted.test']);
      trusted = httpsServer(
        { key: await readFile(cert.keyPath), cert: await readFile(cert.certPath) },
        createApp(env.service),
      );
      const origin = 'https://review.trusted.test:' + (await listen(trusted));
      env.service.config.issuer = env.trust.issuer = origin;
      const azure = azureFixture();
      const { account, anchor_prefix: prefix, checkpoint } = azure.settings;
      const azureOrigin = `https://${account}.blob.core.windows.net`;
      const transport = versionedStorage();
      const anchor = new AzureAnchor(
        azureOrigin,
        checkpoint.container,
        prefix,
        env.trust,
        azure.options.runtimeCredential,
      );
      Object.defineProperty(anchor, 'container', { value: transport.container });
      Object.defineProperty(env.service, 'anchor', { value: anchor });
      const worker = new OutboxWorker(env.service, anchor);

      const identities = new Map<
        Variant,
        { tenant: string; producer: string; operator: string; subject: string; probe: string }
      >();
      const credentials: Record<string, string> = {};
      for (const variant of cases) {
        const tenant = 'checkpoint-' + variant;
        const producer = token();
        const operator = token();
        const subject = 'reviewer-' + variant;
        identities.set(variant, { tenant, producer, operator, subject, probe: randomUUID() });
        credentials[`HAIP_ACCEPTANCE_CONFLICT_${variant.toUpperCase()}_PRODUCER_TOKEN`] = producer;
        credentials[`HAIP_ACCEPTANCE_CONFLICT_${variant.toUpperCase()}_OPERATOR_TOKEN`] = operator;
        await bootstrapTenant(env.service, tenant, 'operator', operator);
        for (const id of ['requester', 'reviewer'])
          await env.principal(
            id,
            'human',
            {
              enabled: true,
              identity_certain: true,
              oidc_issuer: env.service.config.oidc.issuer,
              oidc_subject: id + '-' + variant,
            },
            undefined,
            operator,
          );
        await env.principal('publisher', 'publisher', { enabled: true }, token(), operator);
        await env.principal(
          'producer',
          'producer',
          {
            enabled: true,
            publisher: 'publisher',
            owner: 'requester',
            routes: ['review'],
          },
          producer,
          operator,
        );
        await env.put(
          '/v2/admin/routes/review',
          { ...env.route, reviewers: ['reviewer'], allowed_producers: ['producer'] },
          operator,
        );
      }
      await worker.reconcile();

      async function prepare(variant: Variant) {
        const identity = identities.get(variant)!;
        const reviewer = await env.login(identity.subject);
        const prepared = [];
        for (const role of ['fresh', 'preclaim']) {
          const created = await env.api(
            '/v2/requests',
            env.request(true, {
              summary: 'A private conflict canary',
              metadata: {
                haip_acceptance_fixture: 'duplicate_conflict',
                haip_acceptance_probe: identity.probe,
                haip_acceptance_role: role,
              },
            }),
            identity.producer,
          );
          assert.equal(created.status, 201);
          const id = created.body.request.id as string;
          const candidate = await reviewer.call(`/v2/requests/${id}/candidates`, {
            decision: 'authorise',
            response: { choice: 'accept' },
          });
          assert.equal(candidate.status, 201);
          assert.equal(
            (
              await reviewer.call(`/v2/requests/${id}/confirm`, {
                candidate_id: candidate.body.id,
                candidate_digest: digest(candidate.body),
              })
            ).status,
            200,
          );
          let state;
          for (let attempt = 0; attempt < 20; attempt++) {
            await worker.tick();
            state = (await env.api('/v2/requests/' + id, undefined, identity.producer)).body;
            if (state.grant_state === 'available') break;
          }
          assert.equal(state.grant_state, 'available');
          prepared.push(state);
        }
        return prepared;
      }

      const prepared = new Map();
      for (const variant of cases) prepared.set(variant, await prepare(variant));
      const planPath = join(directory, 'plan.json');
      const settingsPath = join(directory, 'conflict.json');
      const storagePath = join(directory, 'storage.json');
      const evidence = join(directory, 'evidence');
      const plan = JSON.parse(await readFile('deployment/acceptance.plan.example.json', 'utf8'));
      const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
      plan.source.commit = commit;
      plan.deployment.trusted_origin = origin;
      plan.deployment.sandbox_origin_pattern = 'https://{scope}.sandbox.test';
      const check = plan.checks.find(({ id }: { id: string }) => id === 'duplicate_conflict');
      check.command = [
        process.execPath,
        'deployment/adapters/checkpoint-conflict.mjs',
        planPath,
        evidence,
        settingsPath,
      ];
      delete check.unrun_reason;
      const planBytes = JSON.stringify(plan);
      const planDigest = sha256(planBytes);
      const storageBytes = JSON.stringify({
        ...azure.settings,
        trust_manifest: env.trust,
        plan_digest: planDigest,
      });
      await writeFile(planPath, planBytes, { mode: 0o600 });
      await writeFile(storagePath, storageBytes, { mode: 0o600 });
      const unapprovedPath = join(directory, 'unapproved.json');
      await execute(process.execPath, [
        'deployment/run-acceptance.mjs',
        planPath,
        unapprovedPath,
        '--allow-dirty',
        '--allow-incomplete',
      ]);
      const unapproved = JSON.parse(await readFile(unapprovedPath, 'utf8'));
      assert.equal(unapproved.summary.accepted, false);
      const blocked = unapproved.checks.find(
        ({ id }: { id: string }) => id === 'duplicate_conflict',
      );
      assert.equal(blocked.status, 'blocked');
      assert.deepEqual(blocked.assertions, []);

      const controlKey = token();
      const injections: Variant[] = [];
      controlServer = httpServer(async (incoming, reply) => {
        try {
          assert.equal(incoming.headers.authorization, 'Bearer ' + controlKey);
          const args = JSON.parse(
            await Array.fromAsync(incoming).then((rows) => Buffer.concat(rows).toString()),
          );
          const variant: Variant = args[0];
          const [state] = prepared.get(variant);
          const pin = state.anchor.acceptance;
          assert.deepEqual(args, [
            variant,
            identities.get(variant)!.probe,
            planDigest,
            azureOrigin,
            checkpoint.container,
            pin.key,
            pin.version_id,
          ]);
          assert.equal(transport.contents.get(pin.key)?.version, pin.version_id);
          transport.faults.set(pin.key, variant);
          injections.push(variant);
          reply.writeHead(204).end();
        } catch {
          reply.writeHead(400).end();
        }
      });
      const controlUrl = 'http://127.0.0.1:' + (await listen(controlServer));
      const script = join(directory, 'controller.mjs');
      await writeFile(
        script,
        `
import assert from 'node:assert/strict';
assert.ok(!Object.keys(process.env).some((key) => key.startsWith('HAIP_ACCEPTANCE_CONFLICT_')));
const response = await fetch(process.env.HAIP_TEST_CONFLICT_CONTROL, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.HAIP_TEST_CONFLICT_KEY },
  body: JSON.stringify(process.argv.slice(2)),
  signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 204);
`,
        { mode: 0o600 },
      );
      const options = {
        environment: {
          PATH: process.env.PATH,
          ...credentials,
          HAIP_TEST_CONFLICT_CONTROL: controlUrl,
          HAIP_TEST_CONFLICT_KEY: controlKey,
        },
        fixture: { ca: cert.ca, anchor },
      };
      const [extra] = prepared.get('extra');
      const checkpointRecord = extra.anchor.checkpoint;
      const settings = {
        plan_digest: planDigest,
        storage_settings: storagePath,
        storage_settings_digest: sha256(storageBytes),
        cases: Object.fromEntries(
          [...prepared].map(([variant, [fresh, preclaim]]) => [
            variant,
            {
              tenant: fresh.request.tenant,
              producer: fresh.request.producer,
              probe_id: identities.get(variant)!.probe,
              fresh_request: fresh.request.id,
              preclaim_request: preclaim.request.id,
            },
          ]),
        ),
        conflicting_checkpoint: checkpointRecord,
        control_command: [process.execPath, script],
        control_env: ['HAIP_TEST_CONFLICT_CONTROL', 'HAIP_TEST_CONFLICT_KEY'],
      };
      async function run() {
        await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
        return collectCheckpointConflict(planPath, evidence, settingsPath, options);
      }

      const initialPuts = transport.puts.length;
      const invalid = await run();
      assert.equal(invalid.status, 'failed');
      assert.equal(invalid.assertions.at(-1).name, 'bound_canaries');
      assert.equal(initialPuts, transport.puts.length);
      assert.deepEqual(injections, []);

      settings.conflicting_checkpoint = signRecord(
        { ...checkpointRecord.payload, head: digest({ changed: true }) },
        checkpointRecord.protected,
        env.service.config.signingKey,
      );
      const result = await run();
      assert.equal(result.status, 'blocked', result.summary);
      assert.deepEqual(result.facts, { scope: 'local_fixture', variants_fenced: 4 });
      assert.deepEqual(injections, cases);
      assert.equal(result.assertions.length, 10);
      assert.ok(result.assertions.every(({ passed }: { passed: boolean }) => passed));
      assert.deepEqual(transport.puts.slice(initialPuts), [
        extra.anchor.acceptance.key,
        extra.anchor.acceptance.key,
      ]);
      const record = result.evidence[0];
      const written = await readFile(
        join(evidence, record.reference.slice('private-evidence:'.length)),
      );
      assert.equal(record.digest, sha256(written));
      assert.doesNotMatch(written.toString(), /A private conflict canary/);
      for (const secret of [...Object.values(credentials), controlKey])
        assert.ok(!written.includes(secret));
      const recorded = JSON.parse(written.toString());
      assert.equal(
        recorded.replay.version_digest,
        recorded.variants.extra.versions.find(({ current }: { current: boolean }) => !current)
          .version_digest,
      );
      assert.deepEqual(recorded.variants.missing.versions, []);
      for (const variant of cases) {
        const metrics = await env.api(
          '/v2/admin/metrics',
          undefined,
          identities.get(variant)!.operator,
        );
        assert.equal(metrics.status, 200);
        assert.equal(metrics.body.admission_fenced, true);
        assert.deepEqual(
          metrics.body.incidents.map(({ code }: { code: string }) => code),
          [recorded.variants[variant].error],
        );
      }
    } finally {
      for (const server of [controlServer, trusted])
        if (server) await new Promise<void>((done) => server.close(() => done()));
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
