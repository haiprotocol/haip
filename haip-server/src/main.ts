import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { parseJson } from '@haip/protocol/crypto';
import { Store } from './store.js';
import { ReviewService } from './service.js';
import { createApp, createSandboxApp } from './server.js';
import { OutboxWorker } from './worker.js';
import { AzureAnchor, AzureSafetyStore } from './anchor.js';
import { RecoveryGuard, recoverTenant } from './recovery.js';
import { bootstrapTenant } from './admin.js';
import {
  databaseConnection,
  requireProductionAnchor,
  validateOrigins,
  validateSigningTrust,
} from './startup.js';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
};
const selectedMode = process.env.HAIP_MODE ?? 'development';
if (selectedMode !== 'development' && selectedMode !== 'production')
  throw new Error('HAIP_MODE must be development or production');
const mode = selectedMode;
const listenHost = process.env.HAIP_LISTEN_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(listenHost))
  throw new Error('HAIP_LISTEN_HOST must be an explicit loopback or wildcard IP address');
const origin = required('HAIP_ORIGIN'),
  sandboxPattern = required('HAIP_SANDBOX_ORIGIN');
validateOrigins(mode, origin, sandboxPattern);
requireProductionAnchor(mode, process.env);
const database = databaseConnection(
  mode,
  required('HAIP_DATABASE_URL'),
  process.env.HAIP_DATABASE_CA_FILE
    ? readFileSync(process.env.HAIP_DATABASE_CA_FILE, 'utf8')
    : undefined,
);
const signingKey = createPrivateKey(readFileSync(required('HAIP_SIGNING_KEY_FILE')));
const keyId = required('HAIP_SIGNING_KEY_ID');
const discovery = process.env.HAIP_OIDC_DISCOVERY ?? 'oidc';
const clientAuth = process.env.HAIP_OIDC_CLIENT_AUTH ?? 'client_secret_post';
if (
  !['oidc', 'oauth2'].includes(discovery) ||
  !['client_secret_post', 'client_secret_basic'].includes(clientAuth)
)
  throw new Error('Unsupported OIDC discovery or client authentication mode');
const trust = validateSigningTrust(
  parseJson(readFileSync(required('HAIP_TRUST_MANIFEST_FILE'), 'utf8')),
  origin,
  keyId,
  signingKey,
);
// Validate all local production requirements before migrations, bootstrap or listeners.
const anchor = process.env.HAIP_AZURE_ACCOUNT_URL
  ? new AzureAnchor(
      process.env.HAIP_AZURE_ACCOUNT_URL,
      required('HAIP_AZURE_CONTAINER'),
      process.env.HAIP_ANCHOR_PREFIX ?? 'haip',
      trust,
    )
  : undefined;
const store = new Store(database.url, database.options);
const service = new ReviewService(store, {
  mode,
  origin,
  issuer: origin,
  keyId,
  signingKey,
  trust,
  sandboxOrigin: (scope) => sandboxPattern.replace('{scope}', BigInt('0x' + scope).toString(36)),
  oidc: {
    issuer: required('HAIP_OIDC_ISSUER'),
    clientId: required('HAIP_OIDC_CLIENT_ID'),
    clientSecret: required('HAIP_OIDC_CLIENT_SECRET'),
    discovery: discovery as 'oidc' | 'oauth2',
    clientAuth: clientAuth as 'client_secret_post' | 'client_secret_basic',
    allowLocalHttp: mode === 'development' && process.env.HAIP_OIDC_LOCAL_HTTP === 'true',
  },
  webhookHosts: (process.env.HAIP_WEBHOOK_HOSTS ?? '').split(',').filter(Boolean),
  ...(process.env.HAIP_SMTP_HOST
    ? {
        smtp: {
          host: process.env.HAIP_SMTP_HOST,
          port: Number(process.env.HAIP_SMTP_PORT ?? 465),
          secure: process.env.HAIP_SMTP_TLS !== 'false',
          from: required('HAIP_SMTP_FROM'),
          ...(process.env.HAIP_SMTP_USER
            ? { auth: { user: process.env.HAIP_SMTP_USER, pass: required('HAIP_SMTP_PASSWORD') } }
            : {}),
        },
      }
    : {}),
});
await store.migrate();
if (process.argv.includes('--bootstrap')) {
  await bootstrapTenant(
    service,
    required('HAIP_BOOTSTRAP_TENANT'),
    required('HAIP_BOOTSTRAP_OPERATOR'),
    required('HAIP_BOOTSTRAP_TOKEN'),
  );
  await store.close();
} else {
  const worker = new OutboxWorker(service, anchor);
  if (anchor)
    service.recovery = new RecoveryGuard(
      service,
      new AzureSafetyStore(
        required('HAIP_AZURE_ACCOUNT_URL'),
        required('HAIP_AZURE_CONTAINER'),
        process.env.HAIP_ANCHOR_PREFIX ?? 'haip',
        trust,
      ),
    );
  if (process.argv.includes('--recover')) {
    if (!anchor || !service.recovery) throw new Error('Independent storage required for recovery');
    console.log(
      JSON.stringify(
        await recoverTenant(
          service,
          anchor,
          service.recovery,
          required('HAIP_RECOVERY_TENANT'),
          required('HAIP_RECOVERY_OPERATOR'),
          required('HAIP_RECOVERY_TOKEN'),
        ),
      ),
    );
    await store.close();
    process.exit(0);
  }
  await worker.reconcile();
  if (
    mode === 'production' &&
    (await store.pool.query('SELECT 1 FROM haip_tenants WHERE fenced LIMIT 1')).rowCount
  ) {
    await store.close();
    throw new Error('Offline namespace recovery is required before opening production listeners');
  }
  const initialCleanup = await worker.cleanup();
  const server = createApp(service).listen(Number(process.env.PORT ?? 8080), listenHost);
  const sandbox = createSandboxApp(service).listen(
    Number(process.env.HAIP_SANDBOX_PORT ?? 8081),
    listenHost,
  );
  let busy = false;
  const tick = setInterval(() => {
    if (busy) return;
    busy = true;
    void worker
      .tick()
      .catch(() => console.error('HAIP outbox failure'))
      .finally(() => {
        busy = false;
      });
  }, 1000);
  let closing = false;
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  function scheduleCleanup(more: boolean) {
    // Continue bounded passes after listeners open; never overlap retention runs.
    cleanup = setTimeout(
      async () => {
        cleanup = undefined;
        let continuation = false;
        try {
          continuation = (await worker.cleanup()).more;
        } catch {
          console.error('HAIP retention failure');
        }
        if (!closing) scheduleCleanup(continuation);
      },
      more ? 1000 : 15 * 60000,
    );
  }
  scheduleCleanup(initialCleanup.more);
  console.log(
    `HAIP draft service: ${origin}; ${service.discovery().notifications}; ${anchor ? 'independent namespace checks enabled' : 'unanchored; execution admission fenced'}`,
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      closing = true;
      clearInterval(tick);
      clearTimeout(cleanup);
      server.close();
      sandbox.close();
      void store.close();
    });
}
