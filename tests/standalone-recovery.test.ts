import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { PROTOCOL_REVISION } from '@haip/protocol';
import { Store } from '../haip-server/src/store.js';
import { freePort, postgres } from './fixtures/postgres.js';

const execute = promisify(execFile);
const origin = 'https://review.trusted.test';
const tenant = 'local-recovery-fixture';

test(
  'standalone commands restore and recover offline before a new process can serve',
  { timeout: 60000 },
  async () => {
    const pg = await postgres({ tls: true });
    const source = new Store(pg.url);
    const targetUrl = new URL(pg.url);
    targetUrl.pathname = '/recovered';
    const restored = new Store(targetUrl.href);
    const directory = await mkdtemp(join(tmpdir(), 'haip-standalone-recovery-'));
    try {
      const token = randomBytes(32).toString('base64url');
      const newToken = randomBytes(32).toString('base64url');
      const signingPath = join(directory, 'signing.pem');
      const trustPath = join(directory, 'trust.json');
      const backupKeyPath = join(directory, 'backup.key');
      const backupPath = join(directory, 'snapshot.haipbak');
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      await Promise.all([
        writeFile(signingPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
          mode: 0o600,
        }),
        writeFile(backupKeyPath, randomBytes(32), { mode: 0o600 }),
        writeFile(
          trustPath,
          JSON.stringify({
            issuer: origin,
            protocol_revision: PROTOCOL_REVISION,
            keys: [
              {
                key_id: 'fixture',
                algorithm: 'Ed25519',
                public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
                not_before: '2020-01-01T00:00:00Z',
                not_after: '2099-01-01T00:00:00Z',
              },
            ],
          }),
          { mode: 0o600 },
        ),
      ]);
      const trustedPort = await freePort();
      const sandboxPort = await freePort();
      const config = {
        PATH: process.env.PATH,
        PORT: String(trustedPort),
        HAIP_SANDBOX_PORT: String(sandboxPort),
        HAIP_MODE: 'production',
        HAIP_ORIGIN: origin,
        HAIP_SANDBOX_ORIGIN: 'https://{scope}.sandbox.test',
        HAIP_SIGNING_KEY_ID: 'fixture',
        HAIP_SIGNING_KEY_FILE: signingPath,
        HAIP_TRUST_MANIFEST_FILE: trustPath,
        HAIP_DATABASE_CA_FILE: pg.caFile,
        HAIP_OIDC_ISSUER: 'https://identity.fixture.test',
        HAIP_OIDC_CLIENT_ID: 'fixture',
        HAIP_OIDC_CLIENT_SECRET: 'local-fixture',
        HAIP_AZURE_ACCOUNT_URL: 'https://fixture.blob.core.windows.net',
        HAIP_AZURE_CONTAINER: 'checkpoints',
        HAIP_AZURE_SAFETY_CONTAINER: 'safety',
        HAIP_ANCHOR_INDEPENDENT_ADMIN: 'true',
        HAIP_TEST_STORAGE_ROOT: join(directory, 'storage'),
      };
      const command = (database: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
        execute(
          process.execPath,
          [
            '--import',
            'tsx',
            '--import',
            './tests/fixtures/standalone-storage.ts',
            'haip-server/dist/main.js',
            ...args,
          ],
          { env: { ...config, HAIP_DATABASE_URL: database, ...extra }, timeout: 15000 },
        );
      const offline = (database: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
        command(database, args, { ...extra, HAIP_TEST_EXPECT_OFFLINE: '1' });
      const backup = (database: string, operation: 'create' | 'restore') =>
        execute(process.execPath, ['scripts/backup.mjs', operation, backupPath], {
          env: {
            PATH: process.env.PATH,
            HAIP_MODE: 'production',
            HAIP_DATABASE_URL: database,
            HAIP_DATABASE_CA_FILE: pg.caFile,
            HAIP_BACKUP_KEY_FILE: backupKeyPath,
            HAIP_PG_BIN: pg.bin,
          },
          timeout: 10000,
        });
      const leavesListenersClosed = (database: string) =>
        assert.rejects(offline(database), (error) => {
          const stderr = (error as { stderr: string }).stderr;
          assert.match(
            stderr,
            /Offline namespace recovery is required before opening production listeners/,
          );
          assert.doesNotMatch(stderr, /attempted to start a listener/);
          return true;
        });
      const generation = async (store: Store) =>
        (await store.pool.query('SELECT generation,fenced FROM haip_tenants WHERE id=$1', [tenant]))
          .rows[0];
      const metrics = (credential: string) =>
        status(trustedPort, 'review.trusted.test', '/v2/admin/metrics', credential);
      async function serve(database: string, verify: () => Promise<void>) {
        const running = command(database, []);
        const ready = new Promise<void>((resolve, reject) => {
          let output = '';
          running.child.stdout!.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
            if (output.includes('HAIP draft service:')) resolve();
          });
          running.child.once('close', () => reject(new Error('Service exited before startup')));
        });
        void running.catch(() => {});
        try {
          await ready;
          assert.equal(await status(trustedPort, 'review.trusted.test', '/health'), 200);
          assert.equal(await status(sandboxPort, '1.sandbox.test', '/'), 404);
          await verify();
        } finally {
          running.child.kill('SIGTERM');
          await running;
        }
      }

      await offline(pg.url, ['--migrate']);
      await offline(pg.url, ['--bootstrap'], {
        HAIP_BOOTSTRAP_TENANT: tenant,
        HAIP_BOOTSTRAP_OPERATOR: 'original',
        HAIP_BOOTSTRAP_TOKEN: token,
      });
      const original = await generation(source);
      assert.equal(original.fenced, true);
      const mail = ['accepted', 'failed', 'expired', 'pending'].map((state) => ({
        id: randomUUID(),
        state,
      }));
      const restoredMail = async () =>
        (
          await restored.pool.query(
            'SELECT id,state,body,destination,accepted,attempts,error,claim_until,claim_revision FROM haip_outbox WHERE tenant=$1 AND id=ANY($2::uuid[])',
            [tenant, mail.map(({ id }) => id)],
          )
        ).rows;
      await serve(pg.url, async () => {
        assert.equal((await generation(source)).fenced, false);
        assert.equal(await metrics(token), 200);
        assert.equal(
          await status(
            trustedPort,
            'review.trusted.test',
            '/v2/admin/principals/publisher',
            token,
            {
              id: 'publisher',
              kind: 'publisher',
              config: { enabled: true },
              token: randomBytes(32).toString('base64url'),
            },
          ),
          200,
        );
        await source.pool.query(
          'UPDATE haip_outbox SET next_at=clock_timestamp() WHERE tenant=$1 AND checkpoint_batch_count IS NOT NULL',
          [tenant],
        );
        async function hasCheckpoint() {
          const { rowCount } = await source.pool.query(
            "SELECT 1 FROM haip_outbox WHERE kind='checkpoint' AND state='accepted' LIMIT 1",
          );
          return rowCount === 1;
        }
        for (let attempt = 0; attempt < 40 && !(await hasCheckpoint()); attempt++) await delay(100);
        assert.ok(await hasCheckpoint(), 'The running service recorded a retained checkpoint');
        const weak = new URL(pg.url);
        weak.searchParams.set('sslmode', 'disable');
        await assert.rejects(backup(weak.href, 'create'), (error) => {
          assert.match(
            (error as { stderr: string }).stderr,
            /Production database requires verified TLS/,
          );
          return true;
        });
        const wrongHost = new URL(pg.url);
        wrongHost.hostname = 'localhost';
        await assert.rejects(backup(wrongHost.href, 'create'), /backup_database_command_failed/);
        for (const { id, state } of mail) {
          await source.pool.query(
            `INSERT INTO haip_outbox(id,tenant,kind,state,destination,body,accepted,attempts,error,next_at,claim_until,claim_revision)
             VALUES($1,$2,'smtp',$3,'reviewer@test.invalid','{"text":"Old notification body"}',
               CASE WHEN $3='accepted' THEN '{"smtp_accepted":true}'::jsonb END,1,
               CASE WHEN $3='failed' THEN 'delivery_window_expired' END,clock_timestamp()+interval '1 day',
               CASE WHEN $3='pending' THEN clock_timestamp()+interval '1 day' END,
               CASE WHEN $3='pending' THEN 'old-claim' END)`,
            [id, tenant, state],
          );
        }
        const backupResult = await backup(pg.url, 'create');
        assert.equal(JSON.parse(backupResult.stdout).encrypted, 'AES-256-GCM');
      });
      await leavesListenersClosed(pg.url);
      await source.pool.query('CREATE DATABASE recovered');
      const restoreResult = await backup(targetUrl.href, 'restore');
      assert.equal(JSON.parse(restoreResult.stdout).admission, 'fenced');
      assert.deepEqual(await generation(restored), original);
      const beforeRecovery = await restoredMail();
      assert.equal(beforeRecovery.length, mail.length);
      assert.ok(
        beforeRecovery.every(
          ({ body, destination }) =>
            body.text === 'Old notification body' && destination === 'reviewer@test.invalid',
        ),
      );
      await leavesListenersClosed(targetUrl.href);

      const recovery = await offline(targetUrl.href, ['--recover'], {
        HAIP_RECOVERY_TENANT: tenant,
        HAIP_RECOVERY_OPERATOR: 'fresh',
        HAIP_RECOVERY_TOKEN: newToken,
      });
      const result = JSON.parse(recovery.stdout);
      assert.equal(result.retired_generation, original.generation);
      assert.equal(result.history_state, 'matching_retained_prefix');
      assert.notEqual(result.generation, original.generation);
      assert.deepEqual(await generation(restored), { generation: result.generation, fenced: true });
      const afterRecovery = await restoredMail();
      assert.equal(afterRecovery.length, mail.length);
      for (const { id, state } of mail) {
        assert.deepEqual(
          afterRecovery.find((row) => row.id === id),
          {
            id,
            state: state === 'pending' ? 'expired' : state,
            body: {},
            destination: null,
            accepted: null,
            attempts: 1,
            error: state === 'failed' ? 'delivery_window_expired' : null,
            claim_until: null,
            claim_revision: null,
          },
        );
      }
      await serve(targetUrl.href, async () => {
        assert.equal(await metrics(token), 401);
        assert.equal(await metrics(newToken), 200);
        assert.deepEqual(await generation(restored), {
          generation: result.generation,
          fenced: false,
        });
        await leavesListenersClosed(pg.url);
      });
    } finally {
      await Promise.all([source.close(), restored.close()]);
      await pg.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function status(
  port: number,
  host: string,
  path: string,
  token?: string,
  body?: object,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body ? 'PUT' : 'GET',
        headers: {
          Host: host,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        response.on('end', () => resolve(response.statusCode));
        response.on('error', reject);
        response.resume();
      },
    );
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
