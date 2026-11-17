import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { digest } from '@haip/protocol/crypto';
import { collectBackupRecovery } from '../deployment/adapters/backup-recovery.mjs';
import { sha256 } from '../deployment/adapters/evidence.mjs';
import { createBackup } from '../haip-server/src/backup.js';
import { RecoveryGuard } from '../haip-server/src/recovery.js';
import { Store } from '../haip-server/src/store.js';
import { environment } from './environment.js';
import { postgres } from './fixtures/postgres.js';
import { TestSafetyStore } from './fixtures/safety.js';

const execute = promisify(execFile);

test(
  'backup acceptance uses the pinned package to restore and recover with fixture storage',
  { timeout: 90000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haip-backup-adapter-'));
    const env = await environment({ singleTenant: true });
    const pg = await postgres({ tls: true });
    const target = new Store(pg.url);
    try {
      const origin = 'https://review.trusted.test';
      const tenant = 'test-tenant';
      const storage = join(directory, 'storage');
      await mkdir(storage);
      await symlink(env.anchor.root, join(storage, 'checkpoints'), 'dir');
      const safety = new TestSafetyStore(join(storage, 'safety'));
      env.trust.issuer = origin;
      env.service.config.issuer = origin;
      env.service.recovery = new RecoveryGuard(env.service, safety);
      await env.worker.reconcile();
      const created = await env.api(
        '/v2/requests',
        env.request(true, {
          summary: 'A private recovery canary',
          metadata: { haip_acceptance_fixture: 'backup_recovery' },
        }),
      );
      assert.equal(created.status, 201);
      const request = created.body.request;
      const reviewer = await env.login();
      const candidate = await reviewer.call(`/v2/requests/${request.id}/candidates`, {
        decision: 'authorise',
        response: { choice: 'accept' },
      });
      assert.equal(candidate.status, 201);
      const receipt = await reviewer.call(`/v2/requests/${request.id}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      });
      assert.equal(receipt.status, 200);
      await env.flush();
      assert.equal((await env.api(`/v2/requests/${request.id}`)).body.grant_state, 'available');

      const signingPath = join(directory, 'signing.pem');
      const trustPath = join(directory, 'trust.json');
      const keyPath = join(directory, 'backup.key');
      const backup = join(directory, 'source.haipbak');
      const key = randomBytes(32);
      await Promise.all([
        writeFile(
          signingPath,
          env.service.config.signingKey.export({ type: 'pkcs8', format: 'pem' }),
          { mode: 0o600 },
        ),
        writeFile(trustPath, JSON.stringify(env.trust), { mode: 0o600 }),
        writeFile(keyPath, key, { mode: 0o600 }),
      ]);
      await createBackup(env.store.pool.options.connectionString!, backup, key, pg.bin);
      const pack = await execute(
        'npm',
        [
          'pack',
          '--workspace',
          '@haip/server',
          '--offline',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          directory,
        ],
        { timeout: 15000 },
      );
      const archive = join(directory, JSON.parse(pack.stdout)[0].filename);
      const artifactDigest = sha256(await readFile(archive));
      const plan = JSON.parse(await readFile('deployment/acceptance.plan.example.json', 'utf8'));
      plan.source.commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
      plan.deployment.trusted_origin = origin;
      plan.deployment.sandbox_origin_pattern = 'https://{scope}.sandbox.test';
      plan.deployment.service_artifact_digest = artifactDigest;
      const planPath = join(directory, 'plan.json');
      const settingsPath = join(directory, 'settings.json');
      const evidence = join(directory, 'evidence');
      plan.checks.find((check: { id: string }) => check.id === 'backup_recovery').command = [
        'node',
        'deployment/adapters/backup-recovery.mjs',
        planPath,
        evidence,
        settingsPath,
      ];
      delete plan.checks.find((check: { id: string }) => check.id === 'backup_recovery')
        .unrun_reason;
      const {
        rows: [namespace],
      } = await env.store.pool.query('SELECT ledger_id,generation FROM haip_tenants WHERE id=$1', [
        tenant,
      ]);
      const settings = {
        plan_digest: '',
        server_archive: archive,
        node_modules: resolve('node_modules'),
        backup,
        backup_digest: sha256(await readFile(backup)),
        target_database: 'postgres',
        tenant,
        ledger_id: namespace.ledger_id,
        generation: namespace.generation,
        request_id: request.id,
      };
      const writeInputs = async () => {
        const bytes = JSON.stringify(plan);
        settings.plan_digest = sha256(bytes);
        await writeFile(planPath, bytes, { mode: 0o600 });
        await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
      };
      const options = {
        environment: {
          PATH: process.env.PATH,
          HAIP_ACCEPTANCE_RESTORE_DATABASE_URL: pg.url,
          HAIP_DATABASE_CA_FILE: pg.caFile,
          HAIP_PG_BIN: pg.bin,
          HAIP_BACKUP_KEY_FILE: keyPath,
          HAIP_SIGNING_KEY_FILE: signingPath,
          HAIP_SIGNING_KEY_ID: env.service.config.keyId,
          HAIP_TRUST_MANIFEST_FILE: trustPath,
          HAIP_OIDC_ISSUER: 'https://identity.fixture.test',
          HAIP_OIDC_CLIENT_ID: 'fixture',
          HAIP_OIDC_CLIENT_SECRET: 'fixture-oidc-secret',
          HAIP_AZURE_ACCOUNT_URL: 'https://fixture.blob.core.windows.net',
          HAIP_AZURE_CONTAINER: 'checkpoints',
          HAIP_AZURE_SAFETY_CONTAINER: 'safety',
        },
        fixture: {
          preload: ['--import', 'tsx', '--import', './tests/fixtures/standalone-storage.ts'],
          environment: { HAIP_TEST_STORAGE_ROOT: storage, HAIP_TEST_EXPECT_OFFLINE: '1' },
        },
      };
      plan.deployment.service_artifact_digest = 'sha256:' + '1'.repeat(64);
      await writeInputs();
      const mismatch = await collectBackupRecovery(planPath, evidence, settingsPath, options);
      assert.equal(mismatch.status, 'failed');
      assert.deepEqual(
        mismatch.assertions.map(({ name }: { name: string }) => name),
        ['artifact'],
      );
      assert.equal(
        (await target.pool.query("SELECT to_regclass('haip_tenants') AS present")).rows[0].present,
        null,
      );

      plan.deployment.service_artifact_digest = artifactDigest;
      await writeInputs();
      const output = join(directory, 'acceptance.json');
      await execute(
        process.execPath,
        ['deployment/run-acceptance.mjs', planPath, output, '--allow-dirty', '--allow-incomplete'],
        { timeout: 15000 },
      );
      const report = JSON.parse(await readFile(output, 'utf8'));
      const unapproved = report.checks.find(
        (check: { id: string }) => check.id === 'backup_recovery',
      );
      assert.equal(report.summary.accepted, false);
      assert.equal(unapproved.status, 'blocked');
      assert.deepEqual(unapproved.evidence, []);

      plan.deployment.independent_administration_asserted = true;
      const storagePath = join(directory, 'storage-settings.json');
      Object.assign(settings, {
        storage_settings: storagePath,
        storage_settings_digest: 'sha256:' + '7'.repeat(64),
      });
      await writeInputs();
      await writeFile(storagePath, JSON.stringify({ plan_digest: settings.plan_digest }), {
        mode: 0o600,
      });
      const wrongStorage = await collectBackupRecovery(planPath, evidence, settingsPath, {
        environment: options.environment,
      });
      assert.equal(wrongStorage.status, 'failed');
      assert.deepEqual(
        wrongStorage.assertions.map(({ name }: { name: string }) => name),
        ['settings'],
      );
      assert.equal(
        (await target.pool.query("SELECT to_regclass('haip_tenants') AS present")).rows[0].present,
        null,
      );

      plan.deployment.independent_administration_asserted = false;
      await writeInputs();
      const accepted = await collectBackupRecovery(planPath, evidence, settingsPath, options);
      assert.equal(accepted.status, 'blocked', accepted.summary);
      assert.equal(accepted.facts.scope, 'local_fixture');
      assert.equal(accepted.facts.receipt_digest, digest(receipt.body));
      assert.deepEqual(
        accepted.assertions.map(({ name }: { name: string }) => name),
        ['artifact', 'restore_target', 'encrypted_restore', 'offline_recovery'],
      );
      assert.ok(accepted.assertions.every(({ passed }: { passed: boolean }) => passed));
      const record = accepted.evidence[0];
      const evidenceBytes = await readFile(
        join(evidence, record.reference.slice('private-evidence:'.length)),
      );
      assert.equal(record.digest, sha256(evidenceBytes));
      assert.doesNotMatch(
        evidenceBytes.toString(),
        /A private recovery canary|fixture-oidc-secret|postgresql:\/\//,
      );
      const {
        rows: [restoredNamespace],
      } = await target.pool.query('SELECT generation,fenced FROM haip_tenants WHERE id=$1', [
        tenant,
      ]);
      assert.notEqual(restoredNamespace.generation, namespace.generation);
      assert.equal(restoredNamespace.fenced, true);
    } finally {
      await target.close();
      await pg.close();
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
