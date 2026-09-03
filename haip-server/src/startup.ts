import { createPublicKey, type KeyObject } from 'node:crypto';
import type { PoolConfig } from 'pg';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import { isAgentUiOrigin, PROTOCOL_REVISION, type TrustManifest } from '@haip/protocol';
import { validate } from './validation.js';

type Mode = 'development' | 'production';

function loopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    (isIP(host) === 4 && host.startsWith('127.'))
  );
}

export function validateOrigins(mode: Mode, origin: string, sandboxPattern: string): void {
  const parts = sandboxPattern.split('{scope}');
  if (parts.length !== 2) throw new Error('Sandbox origin must contain {scope} exactly once');
  if (!(parts[0]!.endsWith('://') || parts[0]!.endsWith('.')) || !/^(?:\.|:|$)/.test(parts[1]!))
    throw new Error('Sandbox origin requires scope to occupy a complete DNS label');
  const sample = sandboxPattern.replace('{scope}', 'scope');
  const trusted = new URL(origin),
    sandbox = new URL(sample);
  if (
    !['http:', 'https:'].includes(trusted.protocol) ||
    !['http:', 'https:'].includes(sandbox.protocol) ||
    trusted.origin !== origin ||
    sandbox.origin !== sample ||
    !isAgentUiOrigin(sample) ||
    !sandbox.hostname.split('.').includes('scope') ||
    sandbox.hostname === trusted.hostname
  )
    throw new Error(
      'Trusted host and sandbox require separate exact origins, with scope in a DNS label',
    );
  // Only disposable loopback development may relax HTTPS and site separation.
  if (mode === 'production' || !loopbackHost(trusted.hostname) || !loopbackHost(sandbox.hostname)) {
    const trustedSite = getDomain(trusted.hostname, { allowPrivateDomains: true });
    const sandboxSite = getDomain(sandbox.hostname, { allowPrivateDomains: true });
    const alternateSite = getDomain(
      new URL(sandboxPattern.replace('{scope}', 'another-scope')).hostname,
      { allowPrivateDomains: true },
    );
    if (
      trusted.protocol !== 'https:' ||
      sandbox.protocol !== 'https:' ||
      !trustedSite ||
      !sandboxSite ||
      trustedSite === sandboxSite ||
      sandboxSite !== alternateSite
    )
      throw new Error(
        `${mode === 'production' ? 'Production' : 'Non-loopback development'} requires HTTPS origins on distinct registrable sites; scope must be a subdomain`,
      );
  }
}

export function requireProductionAnchor(mode: Mode, env: NodeJS.ProcessEnv): void {
  if (
    mode === 'production' &&
    (!env.HAIP_AZURE_ACCOUNT_URL ||
      !env.HAIP_AZURE_CONTAINER ||
      env.HAIP_ANCHOR_INDEPENDENT_ADMIN !== 'true')
  )
    throw new Error(
      'Production requires HAIP_AZURE_ACCOUNT_URL, HAIP_AZURE_CONTAINER and independently administered anchoring',
    );
}

/** URL SSL flags override pg's SSL object, so validate and remove them first. */
export function databaseConnection(
  mode: Mode,
  raw: string,
  ca?: string,
): { url: string; options: PoolConfig & { sslnegotiation?: 'postgres' | 'direct' } } {
  if (mode === 'development') return { url: raw, options: {} };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Production requires a PostgreSQL TCP URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.includes('%') ||
    url.hash
  )
    throw new Error('Production requires a PostgreSQL TCP URL');
  let negotiation: 'postgres' | 'direct' | undefined;
  for (const [name, value] of [...url.searchParams]) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'hostaddr')
      throw new Error('Production database host must be in the URL authority');
    if (!lower.startsWith('ssl') && lower !== 'uselibpqcompat') continue;
    if (
      name !== lower ||
      url.searchParams.getAll(name).length !== 1 ||
      !(
        (name === 'sslmode' && value === 'verify-full') ||
        (name === 'ssl' && ['true', '1'].includes(value)) ||
        (name === 'uselibpqcompat' && value === 'false') ||
        (name === 'sslnegotiation' && ['postgres', 'direct'].includes(value))
      )
    )
      throw new Error(
        'Production database requires verified TLS; use HAIP_DATABASE_CA_FILE for a private CA',
      );
    if (name === 'sslnegotiation') negotiation = value as 'postgres' | 'direct';
    url.searchParams.delete(name);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return {
    url: url.href,
    options: {
      ...(negotiation ? { sslnegotiation: negotiation } : {}),
      ssl: {
        rejectUnauthorized: true,
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
        ...(ca ? { ca } : {}),
      },
    },
  };
}

export function validateSigningTrust(
  input: unknown,
  issuer: string,
  keyId: string,
  signingKey: KeyObject,
  now = new Date(),
): TrustManifest {
  validate('TrustManifest', input);
  const trust = input as TrustManifest;
  if (trust.issuer !== issuer || trust.protocol_revision !== PROTOCOL_REVISION)
    throw new Error('Trust manifest issuer or protocol revision does not match this service');
  if (signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Ed25519 private signing key required');
  const seen = new Set<string>();
  const expected = createPublicKey(signingKey).export({ format: 'der', type: 'spki' });
  let active = false;
  for (const key of trust.keys) {
    if (seen.has(key.key_id)) throw new Error('Trust manifest contains duplicate key IDs');
    seen.add(key.key_id);
    if (
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(
        key.public_key,
      )
    )
      throw new Error('Trust manifest must contain public keys only');
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(key.public_key);
    } catch {
      throw new Error('Trust manifest contains an invalid public key');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519')
      throw new Error('Trust manifest requires Ed25519 public keys');
    const from = Date.parse(key.not_before),
      until = Date.parse(key.not_after);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until)
      throw new Error('Trust manifest has an invalid key validity window');
    if (key.key_id !== keyId) continue;
    if (
      !publicKey.export({ format: 'der', type: 'spki' }).equals(expected) ||
      now.getTime() < from ||
      now.getTime() >= until ||
      (key.revoked_at !== undefined && now.getTime() >= Date.parse(key.revoked_at))
    )
      throw new Error('Active signing key does not match a currently trusted key');
    active = true;
  }
  if (!active) throw new Error('Active signing key ID is missing from the trust manifest');
  return trust;
}
