// Linux CI smoke for the development image, using disposable local identities and storage.
// Build first: docker build --pull --target development -t haip:development .
// Run: node --import tsx scripts/smoke-container.ts haip:development
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  DEFAULT_LIMITS,
  PROTOCOL_REVISION,
  type SignedRecord,
  type TrustManifest,
} from '@haip/protocol';
import { digest, verifyRecord } from '@haip/protocol/crypto';
import { validate } from '../haip-server/src/validation.js';
import { identityProvider } from '../tests/fixtures/oidc.js';
import { freePort } from '../tests/fixtures/postgres.js';

assert.equal(
  process.platform,
  'linux',
  'This smoke uses Linux Docker host networking for the loopback-only OIDC fixture',
);
const image = process.argv[2] ?? 'haip:development';
assert.match(
  image,
  /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]+$/,
  'An explicit local image reference is required',
);
const exec = promisify(execFile);
const docker = async (args: string[], timeout = 120000) =>
  (
    await exec('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 ** 2 })
  ).stdout.trim();
const compose = await readFile('deployment/compose.dev.yml', 'utf8');
const postgresImage = compose.match(/^\s+image: (postgres:[^\s]+@sha256:[a-f0-9]{64})$/m)?.[1];
assert(postgresImage, 'Compose must pin an official PostgreSQL image digest');
await mkdir('.local', { recursive: true });
// Secrets stay outside the validation upload directory and are removed even after failure.
const privateDirectory = await mkdtemp(resolve('.local/container-smoke-private-'));
const output = resolve(process.env.HAIP_VALIDATION_DIR ?? '.local/validation/current');
const prefix = 'haip-smoke-' + randomUUID();
const databaseName = prefix + '-postgres',
  serviceName = prefix + '-server';
const bootstrapName = prefix + '-bootstrap';
const contextImage = prefix + '-context:development';
const contextSentinels = resolve('haip-server/src/.container-context-' + randomUUID());
const checks: string[] = [];
const evidence: Record<string, unknown> = {
  classification: 'development_container_smoke',
  production_acceptance: false,
  image,
  postgres_image: postgresImage,
  networking: 'Linux host networking, HAIP and identity listeners restricted to loopback',
  compose: 'configuration validation only; runtime checks use disposable Docker containers',
  passed: false,
  checks,
};
let oidc: Awaited<ReturnType<typeof identityProvider>> | undefined;
let failure: unknown;
const envFile = async (name: string, values: Record<string, string>) => {
  const path = join(privateDirectory, name);
  for (const value of Object.values(values)) assert(!/[\r\n]/.test(value));
  await writeFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    { mode: 0o600 },
  );
  return path;
};
async function untilReady(check: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if (await check()) return;
    } catch {
      /* The service may still be starting. */
    }
    await delay(500);
  }
  throw new Error(label + ' did not become ready');
}
try {
  evidence.docker = await docker(['version', '--format', '{{.Server.Version}}']);
  evidence.image_id = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(await docker(['image', 'inspect', image, '--format', '{{.Config.User}}']), 'node');
  const probe = JSON.parse(
    await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      image,
      'node',
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      assert.notEqual(process.getuid(), 0);
      for (const path of ['haip-server/dist/main.js', 'haip-server/schema/schema.json',
        'haip-server/migrations/004_bounded_work.sql', 'haip-server/public/host.js',
        'haip-server/public/sandbox.js',
        'haip-server/third-party/zod-4.5.4-LICENSE', '@types/contracts/schema.json'])
        assert(existsSync('/app/' + path), 'Missing runtime asset: ' + path);
      for (const path of ['.git', '.env', '.local', 'archive', 'research', 'evaluation', 'output',
        'tests', 'scripts', 'docs', 'haip-server/src', '@types/src', 'haip-sdk', 'haip-cli'])
        assert(!existsSync('/app/' + path), 'Unexpected image content: ' + path);
      await import('./haip-server/dist/index.js');
      await import('@haip/protocol');
      console.log(JSON.stringify({ node: process.version, uid: process.getuid() }));
    `,
    ]),
  );
  evidence.runtime = probe;
  checks.push(
    'non-root runtime, compiled entry point, schemas, migrations, browser assets and licences; excluded source/evidence paths',
  );

  // Challenge the context filter inside a permitted source tree with synthetic, non-secret files.
  await mkdir(join(contextSentinels, '.local'), { recursive: true });
  await mkdir(join(contextSentinels, 'node_modules'), { recursive: true });
  for (const name of [
    'keep.txt',
    '.env.example',
    'signing.pem',
    'private.key',
    '.local/sentinel',
    'node_modules/sentinel',
  ])
    await writeFile(join(contextSentinels, name), 'synthetic container-context sentinel\n');
  const contextDockerfile = join(privateDirectory, 'context.Dockerfile');
  const contextProbe = `
    import assert from 'node:assert/strict';
    import { existsSync, readdirSync } from 'node:fs';
    for (const path of ['.git', '.local', 'archive', 'research', 'evaluation', 'output', 'tests', 'docs', 'node_modules'])
      assert(!existsSync('/context/' + path), 'Excluded directory reached build context: ' + path);
    assert(existsSync('/context/haip-server/src/${contextSentinels.split('/').at(-1)}/keep.txt'));
    function walk(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assert(!entry.name.startsWith('.env') && !/\\.(pem|key)$/.test(entry.name), 'Private file reached build context');
        assert(!['node_modules', '.local'].includes(entry.name), 'Local directory reached build context');
        if (entry.isDirectory()) walk(directory + '/' + entry.name);
      }
    }
    walk('/context');
  `;
  await writeFile(
    contextDockerfile,
    `FROM ${image}\nCOPY . /context\nRUN ${JSON.stringify(['node', '--input-type=module', '-e', contextProbe])}\n`,
  );
  await docker(['build', '--file', contextDockerfile, '--tag', contextImage, '.']);
  checks.push(
    'Docker build context rejects synthetic .env/key files, nested local/dependency directories, archives and evidence',
  );

  const password = randomBytes(32).toString('hex');
  const databaseEnv = await envFile('postgres.env', {
    POSTGRES_USER: 'haip_smoke',
    POSTGRES_DB: 'haip_smoke',
    POSTGRES_PASSWORD: password,
  });
  await docker([
    'run',
    '--detach',
    '--name',
    databaseName,
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,nosuid,size=256m',
    '--env-file',
    databaseEnv,
    postgresImage,
  ]);
  await untilReady(async () => {
    await docker(
      [
        'exec',
        databaseName,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'haip_smoke',
        '-d',
        'haip_smoke',
      ],
      5000,
    );
    return true;
  }, 'PostgreSQL container');
  const databasePort = await docker(['port', databaseName, '5432/tcp']);
  assert.match(databasePort, /^127\.0\.0\.1:\d+$/);
  evidence.postgres_version = await docker(['exec', databaseName, 'postgres', '--version']);
  checks.push(
    'pinned PostgreSQL image starts with disposable storage and a loopback-only host port',
  );
  oidc = await identityProvider();
  const port = await freePort(),
    sandboxPort = await freePort();
  const origin = `http://localhost:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trust: TrustManifest = {
    issuer: origin,
    protocol_revision: PROTOCOL_REVISION,
    keys: [
      {
        key_id: 'container-smoke',
        algorithm: 'Ed25519',
        public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        not_before: new Date(Date.now() - 60000).toISOString(),
        not_after: new Date(Date.now() + 86400000).toISOString(),
      },
    ],
  };
  const signingFile = join(privateDirectory, 'signing-key.pem'),
    trustFile = join(privateDirectory, 'trust.json');
  // Individual read-only mounts are readable by UID 1000; the host directory remains mode 0700.
  await writeFile(signingFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o644,
  });
  await writeFile(trustFile, JSON.stringify(trust), { mode: 0o644 });
  const serviceEnv = {
    HAIP_MODE: 'development',
    HAIP_LISTEN_HOST: '127.0.0.1',
    PORT: String(port),
    HAIP_SANDBOX_PORT: String(sandboxPort),
    HAIP_ORIGIN: origin,
    HAIP_SANDBOX_ORIGIN: `http://{scope}.localhost:${sandboxPort}`,
    HAIP_DATABASE_URL: `postgresql://haip_smoke@${databasePort}/haip_smoke`,
    PGPASSWORD: password,
    HAIP_SIGNING_KEY_FILE: '/run/haip/signing-key.pem',
    HAIP_SIGNING_KEY_ID: 'container-smoke',
    HAIP_TRUST_MANIFEST_FILE: '/run/haip/trust.json',
    HAIP_OIDC_ISSUER: oidc.origin,
    HAIP_OIDC_CLIENT_ID: 'haip-test',
    HAIP_OIDC_CLIENT_SECRET: 'test-secret',
    HAIP_OIDC_LOCAL_HTTP: 'true',
  };
  const serviceEnvPath = await envFile('haip.env', serviceEnv);
  const operator = randomBytes(32).toString('base64url');
  const bootstrapEnv = await envFile('bootstrap.env', {
    ...serviceEnv,
    HAIP_BOOTSTRAP_TENANT: 'container-smoke',
    HAIP_BOOTSTRAP_OPERATOR: 'operator',
    HAIP_BOOTSTRAP_TOKEN: operator,
  });
  const composeEnv = await envFile('compose.env', {
    HAIP_DEV_POSTGRES_PASSWORD: password,
    HAIP_DEV_PORT: String(port),
    HAIP_DEV_SANDBOX_PORT: String(sandboxPort),
    HAIP_DEV_SIGNING_KEY_FILE: signingFile,
    HAIP_DEV_SIGNING_KEY_ID: 'container-smoke',
    HAIP_DEV_TRUST_MANIFEST_FILE: trustFile,
    HAIP_DEV_OIDC_ISSUER: oidc.origin,
    HAIP_DEV_OIDC_CLIENT_ID: 'haip-test',
    HAIP_DEV_OIDC_CLIENT_SECRET: 'test-secret',
    HAIP_DEV_OIDC_LOCAL_HTTP: 'true',
  });
  // An explicit generated file and clean environment avoid loading a developer's .env.
  assert.match(compose, /^\s+HAIP_LISTEN_HOST: 0\.0\.0\.0$/m);
  await exec(
    'docker',
    ['compose', '--env-file', composeEnv, '-f', 'deployment/compose.dev.yml', 'config', '--quiet'],
    { env: { PATH: process.env.PATH }, timeout: 30000 },
  );
  checks.push('development Compose configuration validates with explicit ephemeral settings');
  const runArguments = (name: string, file: string) => [
    'run',
    '--name',
    name,
    '--network',
    'host',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '128',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--env-file',
    file,
    '--mount',
    `type=bind,src=${signingFile},dst=/run/haip/signing-key.pem,readonly`,
    '--mount',
    `type=bind,src=${trustFile},dst=/run/haip/trust.json,readonly`,
  ];
  await docker([
    ...runArguments(bootstrapName, bootstrapEnv),
    image,
    'node',
    'haip-server/dist/main.js',
    '--bootstrap',
  ]);
  checks.push(
    'built main applies migrations and bootstraps only explicitly supplied local credentials',
  );
  await docker([...runArguments(serviceName, serviceEnvPath), '--detach', image]);
  await untilReady(
    async () => (await fetch(origin + '/health', { signal: AbortSignal.timeout(2000) })).ok,
    'HAIP container',
  );
  const json = async (path: string, options: RequestInit = {}, status = 200, schema?: string) => {
    const response = await fetch(origin + path, {
      redirect: 'manual',
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, status, `${path} returned ${response.status}`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
    const body = await response.json();
    if (schema) validate(schema, body);
    return body;
  };
  const health = await json('/health');
  assert.equal(health.status, 'ok');
  const discovery = await json('/.well-known/haip', {}, 200, 'Discovery');
  assert.equal(discovery.mode, 'development');
  assert.equal(discovery.release_ready, false);
  assert.equal(discovery.execution_admission, 'development_only');
  assert.deepEqual(await json('/.well-known/haip-trust', {}, 200, 'TrustManifest'), trust);
  assert.equal((await json('/v2/requests', {}, 401)).error, 'unauthenticated');
  assert.equal(
    (
      await json(
        '/v2/requests',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' },
        401,
      )
    ).error,
    'unauthenticated',
  );
  const unauthenticated = await fetch(origin + '/inbox', { redirect: 'manual' });
  assert.equal(unauthenticated.status, 302);
  assert.match(unauthenticated.headers.get('location')!, /^\/auth\/login/);
  checks.push(
    'health, discovery and trust contracts; authentication before parsing; trusted-host response headers',
  );

  const machine = (token: string, method: string, body: unknown): RequestInit => ({
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  for (const id of ['requester', 'reviewer'])
    await json(
      '/v2/admin/principals/' + id,
      machine(operator, 'PUT', {
        id,
        kind: 'human',
        config: {
          enabled: true,
          identity_certain: true,
          oidc_issuer: oidc.origin,
          oidc_subject: id,
        },
      }),
      200,
      'PrincipalResult',
    );
  const login = await fetch(origin + '/auth/login', { redirect: 'manual' });
  assert.equal(login.status, 302);
  const loginCookie = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('__Host-haip-login='))!;
  assert.match(loginCookie, /HttpOnly/);
  assert.match(loginCookie, /Secure/);
  assert.match(loginCookie, /SameSite=Lax/);
  const authorisation = new URL(login.headers.get('location')!);
  assert.equal(authorisation.origin, oidc.origin);
  assert.equal(authorisation.searchParams.get('code_challenge_method'), 'S256');
  assert(authorisation.searchParams.get('nonce'));
  assert(authorisation.searchParams.get('state'));
  const grant = await fetch(oidc.origin + '/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      query: authorisation.searchParams.toString(),
      subject: 'reviewer',
    }),
  });
  const authenticated = await fetch(grant.headers.get('location')!, {
    redirect: 'manual',
    headers: { Cookie: loginCookie.split(';')[0]! },
  });
  assert.equal(authenticated.status, 302);
  const sessionCookie = authenticated.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('__Host-haip='))!
    .split(';')[0]!;
  const session = await json('/auth/session', { headers: { Cookie: sessionCookie } });
  assert.equal(session.subject, 'reviewer');
  assert.equal(typeof session.csrf, 'string');
  checks.push(
    'existing local OIDC fixture completes state/nonce/PKCE exchange through the packaged server',
  );

  const producer = randomBytes(32).toString('base64url');
  await json(
    '/v2/admin/principals/publisher',
    machine(operator, 'PUT', { id: 'publisher', kind: 'publisher', config: { enabled: true } }),
  );
  await json(
    '/v2/admin/principals/producer',
    machine(operator, 'PUT', {
      id: 'producer',
      kind: 'producer',
      token: producer,
      config: { enabled: true, publisher: 'publisher', owner: 'requester', routes: ['review'] },
    }),
  );
  await json(
    '/v2/admin/routes/review',
    machine(operator, 'PUT', {
      reviewers: ['reviewer'],
      separation_of_duties: true,
      limits: DEFAULT_LIMITS,
      required_profiles: {},
      allowed_producers: ['producer'],
      modes: ['fixed_mock'],
    }),
    200,
    'RouteResult',
  );
  const request = JSON.parse(await readFile('examples/http/review.json', 'utf8'));
  const created = await json(
    '/v2/requests',
    machine(producer, 'POST', request),
    201,
    'RequestStatus',
  );
  const human = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: {
      Cookie: sessionCookie,
      Origin: origin,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const candidate = await json(
    `/v2/requests/${created.request.id}/candidates`,
    human({ decision: 'approve', response: { choice: 'accept' } }),
    201,
    'DecisionCandidate',
  );
  const receipt = await json(
    `/v2/requests/${created.request.id}/confirm`,
    human({ candidate_id: candidate.id, candidate_digest: digest(candidate) }),
    200,
    'SignedRecord',
  );
  verifyRecord(receipt as SignedRecord, trust, {
    issuer: origin,
    audience: 'producer',
    type: 'DecisionReceipt',
    purpose: 'review',
    tenant: 'container-smoke',
  });
  assert.equal(receipt.payload.candidate_digest, digest(candidate));
  const recorded = await json(
    `/v2/requests/${created.request.id}`,
    { headers: { Authorization: 'Bearer ' + producer } },
    200,
    'RequestStatus',
  );
  assert.equal(recorded.decision_state, 'confirmed');
  assert.equal(recorded.audit_state, 'pending');
  assert.equal(recorded.grant_state, 'not_applicable');
  checks.push(
    'schema-validated request, candidate, exact confirmation and signature; unanchored audit remains pending',
  );
  for (const path of ['/assets/host.js', '/assets/style.css']) {
    const asset = await fetch(origin + path);
    assert.equal(asset.status, 200);
    assert((await asset.text()).length > 100);
  }
  const review = await fetch(origin + '/review/' + created.request.id, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(review.status, 200);
  assert.match(review.headers.get('content-security-policy')!, /frame-src 'none'/);
  assert.match(await review.text(), /id="confirmation"/);
  const scope = 'a'.repeat(64),
    sandboxHost = `${BigInt('0x' + scope).toString(36)}.localhost:${sandboxPort}`;
  for (const path of ['/sandbox/' + scope, '/unknown'])
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${sandboxPort}${path}`,
        { headers: { Host: sandboxHost } },
        (response) => {
          try {
            assert.equal(response.statusCode, path === '/unknown' ? 404 : 200);
            assert.match(
              response.headers['content-security-policy'] as string,
              /connect-src 'none'/,
            );
            assert.match(
              response.headers['content-security-policy'] as string,
              new RegExp('frame-ancestors ' + origin.replaceAll('.', '\\.')),
            );
            assert.equal(response.headers['cache-control'], 'no-store');
            response.resume();
            response.on('end', resolve);
          } catch (error) {
            response.destroy();
            reject(error);
          }
        },
      );
      request.setTimeout(5000, () => request.destroy(new Error('Sandbox response timed out')));
      request.on('error', reject);
      request.end();
    });
  checks.push(
    'packaged browser assets and review page; sandbox success/error responses retain isolation headers',
  );
  evidence.passed = true;
} catch (error) {
  failure = error;
} finally {
  await mkdir(output, { recursive: true });
  for (const [name, logName] of [
    [serviceName, 'container-server.log'],
    [databaseName, 'container-postgres.log'],
  ] as const) {
    try {
      const logs = await exec('docker', ['logs', name], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 2 * 1024 ** 2,
      });
      await writeFile(join(output, logName), logs.stdout + logs.stderr);
    } catch {
      /* A failure may precede container creation. */
    }
  }
  for (const name of [serviceName, bootstrapName, databaseName])
    await docker(['rm', '--force', '--volumes', name], 15000).catch(() => undefined);
  await docker(['image', 'rm', '--force', contextImage], 15000).catch(() => undefined);
  await oidc?.close();
  await rm(contextSentinels, { recursive: true, force: true });
  await rm(privateDirectory, { recursive: true, force: true });
  evidence.completed_at = new Date().toISOString();
  await writeFile(join(output, 'container-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
}
if (failure) throw failure;
console.log(
  `Development container smoke passed (${checks.length} checks). No production acceptance is claimed.`,
);
