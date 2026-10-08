#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { isAbsolute, dirname, relative, resolve, sep } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { getDomain } from 'tldts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const maximumBytes = 1024 * 1024;
const scopeA = 'a'.repeat(64);
const scopeB = 'b'.repeat(64);
const scopeLabel = (scope) => BigInt('0x' + scope).toString(36);
const securityHeaders = [
  'cache-control',
  'content-security-policy',
  'connection-allowlist',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'reporting-endpoints',
  'report-to',
];
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const inside = (directory, path) => {
  const local = relative(directory, path);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
};
const errorCode = (error) =>
  /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'PROBE_ERROR';
const assertion = (name, passed, detail) => ({ name, passed, detail });

function origins(deployment) {
  const trusted = new URL(deployment.trusted_origin);
  const pattern = deployment.sandbox_origin_pattern;
  const parts = typeof pattern === 'string' ? pattern.split('{scope}') : [];
  if (
    trusted.protocol !== 'https:' ||
    trusted.origin !== deployment.trusted_origin ||
    parts.length !== 2 ||
    !(parts[0].endsWith('://') || parts[0].endsWith('.')) ||
    !/^(?:\.|:|$)/.test(parts[1])
  )
    throw new Error('Exact HTTPS origins and one complete scope label are required');
  const sandboxes = [scopeA, scopeB].map(
    (scope) => new URL(pattern.replace('{scope}', scopeLabel(scope))),
  );
  const trustedSite = getDomain(trusted.hostname, { allowPrivateDomains: true });
  const sites = sandboxes.map((url) => getDomain(url.hostname, { allowPrivateDomains: true }));
  if (
    !trustedSite ||
    sites.some((site) => !site || site === trustedSite) ||
    sites[0] !== sites[1] ||
    sandboxes.some(
      (url, index) =>
        url.protocol !== 'https:' ||
        url.origin !== pattern.replace('{scope}', scopeLabel([scopeA, scopeB][index])),
    )
  )
    throw new Error('Trusted and sandbox origins must use distinct registrable sites');
  return { trusted, sandboxes, trustedSite, sandboxSite: sites[0] };
}

function directives(value) {
  const result = new Map();
  if (typeof value !== 'string') return result;
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    if (result.has(name)) return new Map();
    result.set(name, sources);
  }
  return result;
}

function sameSources(policy, name, expected) {
  const actual = policy.get(name);
  return actual?.length === expected.length && expected.every((source) => actual.includes(source));
}

function hstsMaxAge(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const fields = new Map();
  const token = /[!#$%&'*+.^_`|~0-9A-Za-z-]+/y;
  let position = 0;
  const whitespace = () => {
    while (header[position] === ' ' || header[position] === '\t') position++;
  };
  const readToken = () => {
    token.lastIndex = position;
    const match = token.exec(header);
    if (!match) return null;
    position = token.lastIndex;
    return match[0];
  };
  while (position < header.length) {
    whitespace();
    if (position === header.length) break;
    if (header[position] === ';') {
      position++;
      continue;
    }
    const rawName = readToken();
    if (rawName === null) return null;
    const name = rawName.toLowerCase();
    if (fields.has(name) || fields.size >= 128) return null;
    whitespace();
    let value = null;
    if (header[position] === '=') {
      position++;
      whitespace();
      if (header[position] === '"') {
        position++;
        value = '';
        let closed = false;
        while (position < header.length) {
          let character = header[position++];
          if (character === '"') {
            closed = true;
            break;
          }
          if (character === '\\') {
            if (position === header.length) return null;
            character = header[position++];
          }
          const code = character.charCodeAt(0);
          if ((code < 32 && code !== 9) || code === 127 || code > 255) return null;
          value += character;
        }
        if (!closed) return null;
      } else {
        value = readToken();
        if (value === null) return null;
      }
      whitespace();
    }
    fields.set(name, value);
    if (position < header.length) {
      if (header[position] !== ';') return null;
      position++;
    }
  }
  if (fields.has('includesubdomains') && fields.get('includesubdomains') !== null) return null;
  const seconds = fields.get('max-age');
  return typeof seconds === 'string' && /^[0-9]+$/.test(seconds) ? BigInt(seconds) : null;
}

function headerAssertions(probe, sandbox, trustedOrigin) {
  const headers = probe.headers;
  const prefix = probe.name;
  const policy = directives(headers['content-security-policy']);
  const equal = (name, value) =>
    assertion(
      `${prefix}_${name.replaceAll('-', '_')}`,
      headers[name] === value,
      `Expected ${name}: ${value}.`,
    );
  const required = sandbox
    ? {
        'default-src': ["'none'"],
        'script-src': ["'unsafe-inline'"],
        'style-src': ["'unsafe-inline'"],
        'connect-src': ["'none'"],
        'img-src': ['data:'],
        'font-src': ['data:'],
        'frame-src': ['about:'],
        'form-action': ["'none'"],
        'base-uri': ["'none'"],
        'object-src': ["'none'"],
        'frame-ancestors': [trustedOrigin],
      }
    : {
        'default-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'connect-src': ["'self'"],
        'img-src': ["'self'"],
        'frame-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      };
  const permissions = headers['permissions-policy'] ?? '';
  const seconds = hstsMaxAge(headers['strict-transport-security']);
  const assertions = [
    equal('cross-origin-opener-policy', 'same-origin'),
    equal('cross-origin-embedder-policy', 'require-corp'),
    equal('cross-origin-resource-policy', sandbox ? 'cross-origin' : 'same-origin'),
    equal('referrer-policy', 'no-referrer'),
    equal('x-content-type-options', 'nosniff'),
    equal('cache-control', 'no-store'),
    assertion(
      `${prefix}_csp`,
      policy.size === Object.keys(required).length &&
        Object.entries(required).every(([name, sources]) => sameSources(policy, name, sources)),
      'All required CSP directives have exactly the expected sources.',
    ),
    assertion(
      `${prefix}_hsts`,
      seconds !== null && seconds >= 31536000n,
      'HSTS has valid, unique directives and a max-age of at least one year.',
    ),
  ];
  assertions.push(
    assertion(
      `${prefix}_permissions`,
      [
        'camera',
        'microphone',
        'geolocation',
        'payment',
        'clipboard-read',
        'clipboard-write',
        ...(sandbox ? [] : ['usb']),
      ].every((name) => new RegExp(`(?:^|,)\\s*${name}=\\(\\)\\s*(?:,|$)`).test(permissions)),
      'The required device and clipboard permissions are denied.',
    ),
  );
  if (sandbox) {
    assertions.push(
      assertion(
        `${prefix}_connection_allowlist`,
        /^\(\)\s*;\s*webrtc=block\s*;\s*redirects=block(?:\s*;\s*report-to=haip-view-policy)?\s*$/.test(
          headers['connection-allowlist'] ?? '',
        ),
        'The connection allowlist is empty and denies WebRTC and redirects.',
      ),
      assertion(
        `${prefix}_reporting_destinations`,
        !headers['reporting-endpoints'] && !headers['report-to'],
        'No network reporting destination is configured.',
      ),
    );
  } else assertions.push(equal('x-frame-options', 'DENY'));
  return assertions;
}

async function probe(url, name, options) {
  const started = Date.now();
  let dnsTimeout;
  const addresses = await Promise.race([
    options.resolve(url.hostname),
    new Promise((_, reject) => {
      dnsTimeout = setTimeout(
        () => reject(Object.assign(new Error('DNS timeout'), { code: 'PROBE_TIMEOUT' })),
        options.timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(dnsTimeout));
  if (
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some(
      (value) => ![4, 6].includes(value.family) || isIP(value.address) !== value.family,
    )
  )
    throw new Error('DNS returned no bounded address set');
  const pinnedLookup = (_host, lookupOptions, callback) => {
    const eligible = addresses.filter(
      (entry) => !lookupOptions.family || entry.family === lookupOptions.family,
    );
    if (lookupOptions.all) callback(null, eligible);
    else if (eligible[0]) callback(null, eligible[0].address, eligible[0].family);
    else callback(Object.assign(new Error('No address for family'), { code: 'ENOTFOUND' }));
  };
  return new Promise((complete, reject) => {
    const timeout = setTimeout(
      () => outgoing.destroy(Object.assign(new Error('Probe timeout'), { code: 'PROBE_TIMEOUT' })),
      Math.max(1, options.timeoutMs - (Date.now() - started)),
    );
    let handshake;
    const outgoing = request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: pinnedLookup,
        servername: url.hostname,
        rejectUnauthorized: true,
        ...(options.ca ? { ca: options.ca } : {}),
        headers: {
          Accept: 'application/json,text/html;q=0.9',
          ...(options.host ? { Host: options.host } : {}),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
      },
      (incoming) => {
        const chunks = [];
        let bytes = 0;
        incoming.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maximumBytes)
            outgoing.destroy(
              Object.assign(new Error('Oversized probe response'), { code: 'PROBE_TOO_LARGE' }),
            );
          else chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const body = Buffer.concat(chunks);
          const headers = Object.fromEntries(
            securityHeaders
              .filter((key) => incoming.headers[key] !== undefined)
              .map((key) => [key, incoming.headers[key]]),
          );
          complete({
            name,
            url: url.href,
            status: incoming.statusCode,
            addresses,
            tls: handshake,
            headers,
            body_bytes: bytes,
            body_digest: hash(body),
            session_cookie_returned: (incoming.headers['set-cookie'] ?? []).some((value) =>
              value.startsWith('__Host-haip='),
            ),
            session_cookie_attributes_valid: (incoming.headers['set-cookie'] ?? [])
              .filter((value) => value.startsWith('__Host-haip='))
              .every(
                (value) =>
                  /;\s*Secure(?:;|$)/i.test(value) &&
                  /;\s*HttpOnly(?:;|$)/i.test(value) &&
                  /;\s*Path=\/(?:;|$)/i.test(value) &&
                  /;\s*SameSite=Lax(?:;|$)/i.test(value) &&
                  !/;\s*Domain=/i.test(value),
              ),
          });
        });
      },
    );
    outgoing.on('socket', (socket) =>
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerCertificate();
        const identityError = checkServerIdentity(url.hostname, certificate);
        if (!socket.authorized || identityError || !certificate.raw) {
          outgoing.destroy(
            identityError ??
              Object.assign(new Error('Unauthorised TLS connection'), { code: 'TLS_UNAUTHORIZED' }),
          );
          return;
        }
        handshake = {
          authorised: true,
          hostname_valid: true,
          protocol: socket.getProtocol(),
          cipher: socket.getCipher().standardName ?? socket.getCipher().name,
          certificate_digest: hash(certificate.raw),
          certificate_valid_from: certificate.valid_from,
          certificate_valid_to: certificate.valid_to,
          certificate_subject_alt_name: certificate.subjectaltname,
          remote_address: socket.remoteAddress,
        };
      }),
    );
    outgoing.once('error', reject);
    outgoing.once('close', () => clearTimeout(timeout));
    outgoing.end();
  });
}

export async function collectOriginsTls(plan, options = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('TLS validation must remain enabled');
  if (options.ca && !options.fixture)
    throw new Error('Custom certificate authority is permitted only for labelled fixtures');
  const { trusted, sandboxes, trustedSite, sandboxSite } = origins(plan.deployment);
  const cookie = options.cookie;
  if (cookie && !/^__Host-haip=[A-Za-z0-9_-]{32,256}$/.test(cookie))
    throw new Error('Only one opaque HAIP session cookie is permitted');
  const started = Date.now();
  const records = [];
  const assertions = [
    assertion(
      'distinct_registrable_sites',
      true,
      'Trusted and sandbox origins use different registrable sites, including private suffix rules.',
    ),
  ];
  const jobs = [
    { name: 'trusted_health', url: new URL('/health', trusted), status: [200], sandbox: false },
    {
      name: 'trusted_unexpected_host',
      url: new URL('/health', trusted),
      host: 'unexpected-host.invalid',
      status: [403, 404, 421],
      sandbox: false,
      headers: false,
    },
    ...sandboxes.map((url, index) => ({
      name: `sandbox_scope_${index + 1}`,
      url: new URL(`/sandbox/${[scopeA, scopeB][index]}`, url),
      status: [200],
      sandbox: true,
    })),
    {
      name: 'sandbox_wrong_host',
      url: new URL(`/sandbox/${scopeA}`, sandboxes[0]),
      host: sandboxes[1].host,
      status: [403, 404, 421],
      sandbox: true,
    },
    {
      name: 'sandbox_invalid_scope',
      url: new URL('/sandbox/invalid-scope', sandboxes[0]),
      status: [404],
      sandbox: true,
    },
    {
      name: 'sandbox_unknown_path',
      url: new URL('/unexpected-path', sandboxes[0]),
      status: [404],
      sandbox: true,
    },
    ...(cookie
      ? [
          {
            name: 'authenticated_session',
            url: new URL('/auth/session', trusted),
            status: [200],
            sandbox: false,
            cookie,
          },
        ]
      : []),
  ];
  for (const job of jobs) {
    try {
      const remaining = Math.min(options.timeoutMs ?? 5000, 45000 - (Date.now() - started));
      if (remaining <= 0)
        throw Object.assign(new Error('Adapter deadline'), { code: 'ADAPTER_TIMEOUT' });
      const record = await probe(job.url, job.name, {
        ...options,
        host: job.host,
        cookie: job.cookie,
        timeoutMs: remaining,
        resolve: options.resolve ?? ((hostname) => lookup(hostname, { all: true, verbatim: true })),
      });
      records.push(record);
      assertions.push(
        assertion(
          `${job.name}_tls`,
          !!record.tls?.authorised &&
            record.tls.hostname_valid &&
            ['TLSv1.2', 'TLSv1.3'].includes(record.tls.protocol),
          'TLS validates the certificate chain and requested hostname and uses TLS 1.2 or 1.3.',
        ),
      );
      assertions.push(
        assertion(
          `${job.name}_status`,
          job.status.includes(record.status),
          `Observed status ${record.status}. Expected ${job.status.join(', ')} without following redirects.`,
        ),
      );
      if (job.headers !== false)
        assertions.push(...headerAssertions(record, job.sandbox, trusted.origin));
      if (record.session_cookie_returned)
        assertions.push(
          assertion(
            `${job.name}_returned_session_cookie`,
            record.session_cookie_attributes_valid,
            'Any returned session cookie is Secure, HttpOnly, SameSite=Lax and host-only with path /.',
          ),
        );
    } catch (error) {
      records.push({ name: job.name, url: job.url.href, error_code: errorCode(error) });
      assertions.push(
        assertion(
          `${job.name}_completed`,
          false,
          `The bounded probe failed with ${errorCode(error)}.`,
        ),
      );
    }
  }
  const failed = assertions.some((value) => !value.passed);
  const document = {
    format: 'haip.origins-tls.probes.v1',
    recorded_at: new Date().toISOString(),
    evidence_kind: options.fixture ? 'local_fixture' : 'live_read_only',
    trusted_origin: trusted.origin,
    sandbox_origin_pattern: plan.deployment.sandbox_origin_pattern,
    trusted_site: trustedSite,
    sandbox_site: sandboxSite,
    records,
    coverage: {
      tls_and_headers: true,
      session_issuance: false,
      hostile_framing: false,
      unexpected_message_source: false,
      browser_network_enforcement: false,
    },
  };
  return {
    document,
    result: {
      status: failed ? 'failed' : 'blocked',
      summary: failed
        ? 'One or more origin, TLS, routing or header probes failed.'
        : 'Origin, TLS, routing and header probes passed. Actual session issuance, hostile framing, unexpected message sources and browser network enforcement still need an exercised browser adapter.',
      assertions,
      evidence: [],
      facts: {
        fixture_evidence: !!options.fixture,
        probes: records.length,
        trusted_site: trustedSite,
        sandbox_site: sandboxSite,
        authenticated_session_observed: records.some(
          (value) => value.name === 'authenticated_session' && value.status === 200,
        ),
        browser_boundaries_exercised: false,
        session_issuance_exercised: false,
      },
    },
  };
}

async function privateEvidence(directory, document) {
  if (!isAbsolute(directory)) throw new Error('Evidence directory must be absolute');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error('Evidence directory must be a private directory with mode 0700');
  const canonical = await realpath(directory);
  if (inside(await realpath(root), canonical))
    throw new Error('Evidence must remain outside the repository');
  const name = `origins-tls-${randomUUID()}.json`;
  const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  const file = await open(
    resolve(canonical, name),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return {
    name: 'origins-tls-probes',
    digest: hash(bytes),
    recorded_at: document.recorded_at,
    reference: `private-evidence:${name}`,
  };
}

async function main() {
  const [planPath, evidenceDirectory, flag, caPath, ...rest] = process.argv.slice(2);
  if (
    !planPath ||
    !evidenceDirectory ||
    rest.length ||
    (flag !== undefined && (flag !== '--fixture-ca' || !caPath))
  )
    throw new Error(
      'Usage: node deployment/adapters/origins-tls.mjs PLAN PRIVATE_EVIDENCE_DIRECTORY [--fixture-ca CA_FILE]',
    );
  if (
    process.env.HAIP_ACCEPTANCE_CHECK_ID &&
    process.env.HAIP_ACCEPTANCE_CHECK_ID !== 'origins_tls'
  )
    throw new Error('This adapter serves origins_tls only');
  const bytes = await readFile(planPath);
  if (bytes.length > maximumBytes) throw new Error('Plan exceeds 1 MiB');
  const plan = JSON.parse(bytes.toString('utf8'));
  if (plan.document_type !== 'plan' || plan.schema_version !== 'haip.deployment.acceptance.v1')
    throw new Error('Expected an HAIP deployment acceptance plan');
  const options = {
    cookie: process.env.HAIP_ACCEPTANCE_REVIEW_COOKIE,
    fixture: flag === '--fixture-ca',
  };
  if (options.fixture) {
    const values = origins(plan.deployment);
    if ([values.trusted, ...values.sandboxes].some((url) => !url.hostname.endsWith('.test')))
      throw new Error('TLS fixtures must use reserved .test hostnames');
    options.ca = await readFile(caPath);
    options.resolve = async () => [{ address: '127.0.0.1', family: 4 }];
  }
  const { document, result } = await collectOriginsTls(plan, options);
  document.plan_digest = hash(bytes);
  document.source_commit = plan.source?.commit ?? null;
  result.evidence.push(await privateEvidence(evidenceDirectory, document));
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(
      JSON.stringify({
        status: 'failed',
        summary:
          'The origins/TLS adapter could not validate its inputs or preserve private evidence.',
        assertions: [
          assertion(
            'adapter_completed',
            false,
            'Check the reviewed plan, private evidence directory and TLS configuration. No credential values are emitted.',
          ),
        ],
        evidence: [],
        facts: {},
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
