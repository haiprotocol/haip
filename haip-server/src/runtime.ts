import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import type { TokenCredential } from '@azure/identity';
import { parseJson } from '@haip/protocol/crypto';
import { Store } from './store.js';
import { createNeonStore } from './neon.js';
import { ReviewService } from './service.js';
import { AzureAnchor, AzureSafetyStore } from './anchor.js';
import { RecoveryGuard } from './recovery.js';
import {
  databaseConnection,
  requireProductionAnchor,
  validateOrigins,
  validateSigningTrust,
} from './startup.js';

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

function modeOf(env: NodeJS.ProcessEnv) {
  const mode = env.HAIP_MODE ?? 'development';
  if (mode !== 'development' && mode !== 'production')
    throw new Error('HAIP_MODE must be development or production');
  return mode;
}

export function createRuntimeStore(
  env: NodeJS.ProcessEnv,
  access: 'runtime' | 'administrative' = 'runtime',
): Store {
  const url = requiredEnv(env, 'HAIP_DATABASE_URL');
  const provider = env.HAIP_DATABASE_PROVIDER ?? 'postgres';
  const mode = modeOf(env);
  if (provider === 'neon') {
    if (mode !== 'production' || env.HAIP_DATABASE_CA_FILE)
      throw new Error('Neon requires production mode and public certificate verification');
    return createNeonStore(url, access);
  }
  if (provider !== 'postgres') throw new Error('Unknown HAIP database provider');
  const connection = databaseConnection(
    mode,
    url,
    env.HAIP_DATABASE_CA_FILE ? readFileSync(env.HAIP_DATABASE_CA_FILE, 'utf8') : undefined,
  );
  return new Store(connection.url, connection.options);
}

export function createRuntime(
  env: NodeJS.ProcessEnv,
  {
    storageCredential,
    databaseAccess,
  }: {
    storageCredential?: TokenCredential;
    databaseAccess?: 'runtime' | 'administrative';
  } = {},
) {
  const required = (name: string) => requiredEnv(env, name);
  const mode = modeOf(env);
  const origin = required('HAIP_ORIGIN');
  const sandboxPattern = required('HAIP_SANDBOX_ORIGIN');
  validateOrigins(mode, origin, sandboxPattern);
  requireProductionAnchor(mode, env);
  const signingKey = createPrivateKey(readFileSync(required('HAIP_SIGNING_KEY_FILE')));
  const keyId = required('HAIP_SIGNING_KEY_ID');
  const trust = validateSigningTrust(
    parseJson(readFileSync(required('HAIP_TRUST_MANIFEST_FILE'), 'utf8')),
    origin,
    keyId,
    signingKey,
  );
  const discovery = env.HAIP_OIDC_DISCOVERY ?? 'oidc';
  const clientAuth = env.HAIP_OIDC_CLIENT_AUTH ?? 'client_secret_post';
  if (
    (discovery !== 'oidc' && discovery !== 'oauth2') ||
    (clientAuth !== 'client_secret_post' && clientAuth !== 'client_secret_basic')
  )
    throw new Error('Unsupported OIDC discovery or client authentication mode');

  const account = env.HAIP_AZURE_ACCOUNT_URL;
  const prefix = env.HAIP_ANCHOR_PREFIX ?? 'haip';
  const anchor = account
    ? new AzureAnchor(account, required('HAIP_AZURE_CONTAINER'), prefix, trust, storageCredential)
    : undefined;
  const safety = account
    ? new AzureSafetyStore(
        account,
        required('HAIP_AZURE_SAFETY_CONTAINER'),
        prefix,
        trust,
        storageCredential,
      )
    : undefined;
  const oidc = {
    issuer: required('HAIP_OIDC_ISSUER'),
    clientId: required('HAIP_OIDC_CLIENT_ID'),
    clientSecret: required('HAIP_OIDC_CLIENT_SECRET'),
    discovery,
    clientAuth,
    allowLocalHttp: mode === 'development' && env.HAIP_OIDC_LOCAL_HTTP === 'true',
  } as const;
  const smtp = env.HAIP_SMTP_HOST
    ? {
        host: env.HAIP_SMTP_HOST,
        port: Number(env.HAIP_SMTP_PORT ?? 465),
        secure: env.HAIP_SMTP_TLS !== 'false',
        from: required('HAIP_SMTP_FROM'),
        ...(env.HAIP_SMTP_USER
          ? { auth: { user: env.HAIP_SMTP_USER, pass: required('HAIP_SMTP_PASSWORD') } }
          : {}),
      }
    : undefined;
  const service = new ReviewService(createRuntimeStore(env, databaseAccess), {
    mode,
    origin,
    issuer: origin,
    keyId,
    signingKey,
    trust,
    sandboxOrigin: (scope) => sandboxPattern.replace('{scope}', BigInt('0x' + scope).toString(36)),
    oidc,
    smtp,
    webhookHosts: (env.HAIP_WEBHOOK_HOSTS ?? '').split(',').filter(Boolean),
  });
  if (safety) service.recovery = new RecoveryGuard(service, safety);
  return { service, anchor };
}
