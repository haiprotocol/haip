import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { Store } from './store.js';
import { ReviewService } from './service.js';
import { createApp, createSandboxApp } from './server.js';
import { OutboxWorker } from './worker.js';
import { AzureAnchor, AzureSafetyStore } from './anchor.js';
import { RecoveryGuard, recoverTenant } from './recovery.js';
import { bootstrapTenant } from './admin.js';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
};
const mode = process.env.HAIP_MODE ?? 'development';
if (!['development', 'production'].includes(mode))
  throw new Error('HAIP_MODE must be development or production');
const origin = required('HAIP_ORIGIN'),
  sandboxPattern = required('HAIP_SANDBOX_ORIGIN');
if (sandboxPattern.split('{scope}').length !== 2)
  throw new Error('Sandbox origin must contain {scope} exactly once');
const trustedOrigin = new URL(origin);
const sandboxOrigin = new URL(sandboxPattern.replace('{scope}', 'scope'));
if (
  trustedOrigin.origin !== origin ||
  sandboxOrigin.origin !== sandboxPattern.replace('{scope}', 'scope') ||
  !sandboxOrigin.hostname.split('.').includes('scope') ||
  sandboxOrigin.hostname === trustedOrigin.hostname
)
  throw new Error(
    'Trusted host and sandbox require separate exact origins, with scope in a DNS label',
  );
if (
  mode === 'production' &&
  (!origin.startsWith('https://') ||
    !sandboxPattern.startsWith('https://') ||
    process.env.HAIP_ANCHOR_INDEPENDENT_ADMIN !== 'true')
)
  throw new Error('Production requires TLS and independently administered anchoring');
const signingKey = createPrivateKey(readFileSync(required('HAIP_SIGNING_KEY_FILE')));
const discovery = process.env.HAIP_OIDC_DISCOVERY ?? 'oidc';
const clientAuth = process.env.HAIP_OIDC_CLIENT_AUTH ?? 'client_secret_post';
if (
  !['oidc', 'oauth2'].includes(discovery) ||
  !['client_secret_post', 'client_secret_basic'].includes(clientAuth)
)
  throw new Error('Unsupported OIDC discovery or client authentication mode');
if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signing key required');
const trust = JSON.parse(readFileSync(required('HAIP_TRUST_MANIFEST_FILE'), 'utf8'));
const store = new Store(required('HAIP_DATABASE_URL'));
await store.migrate();
const service = new ReviewService(store, {
  mode: mode as 'development' | 'production',
  origin,
  issuer: origin,
  keyId: required('HAIP_SIGNING_KEY_ID'),
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
if (process.argv.includes('--bootstrap')) {
  await bootstrapTenant(
    service,
    required('HAIP_BOOTSTRAP_TENANT'),
    required('HAIP_BOOTSTRAP_OPERATOR'),
    required('HAIP_BOOTSTRAP_TOKEN'),
  );
  await store.close();
} else {
  const anchor = process.env.HAIP_AZURE_ACCOUNT_URL
    ? new AzureAnchor(
        process.env.HAIP_AZURE_ACCOUNT_URL,
        required('HAIP_AZURE_CONTAINER'),
        process.env.HAIP_ANCHOR_PREFIX ?? 'haip',
        trust,
      )
    : undefined;
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
  await worker.cleanup();
  const server = createApp(service).listen(Number(process.env.PORT ?? 8080), '127.0.0.1');
  const sandbox = createSandboxApp(service).listen(
    Number(process.env.HAIP_SANDBOX_PORT ?? 8081),
    '127.0.0.1',
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
  const cleanup = setInterval(
    () => void worker.cleanup().catch(() => console.error('HAIP retention failure')),
    15 * 60000,
  );
  console.log(
    `HAIP draft service: ${origin}; ${service.discovery().notifications}; ${anchor ? 'independent namespace checks enabled' : 'unanchored; execution admission fenced'}`,
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      clearInterval(tick);
      clearInterval(cleanup);
      server.close();
      sandbox.close();
      void store.close();
    });
}
