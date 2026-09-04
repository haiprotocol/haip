import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../haip-server/src/store.js';
import { ReviewService } from '../haip-server/src/service.js';
import { createApp, createSandboxApp } from '../haip-server/src/server.js';
import { bootstrapTenant } from '../haip-server/src/admin.js';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { PROTOCOL_REVISION, DEFAULT_LIMITS } from '@haip/protocol';
import { digest } from '@haip/protocol/crypto';
import { postgres, freePort } from './fixtures/postgres.js';
import { identityProvider } from './fixtures/oidc.js';
import { TestAnchor } from './fixtures/anchor.js';
import type { ServiceConfig } from '../haip-server/src/config.js';
export async function environment(options: { smtp?: ServiceConfig['smtp'] } = {}) {
  const pg = await postgres(),
    oidc = await identityProvider(),
    store = new Store(pg.url);
  await store.migrate();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const port = await freePort(),
    sandboxPort = await freePort();
  const origin = `http://localhost:${port}`;
  const trust = {
    issuer: origin,
    protocol_revision: PROTOCOL_REVISION,
    keys: [
      {
        key_id: 'test-signing',
        algorithm: 'Ed25519' as const,
        public_key: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        not_before: '2020-01-01T00:00:00.000Z',
        not_after: '2099-01-01T00:00:00.000Z',
      },
    ],
  };
  const service = new ReviewService(store, {
    origin,
    issuer: origin,
    keyId: 'test-signing',
    signingKey: privateKey,
    trust,
    mode: 'development',
    sandboxOrigin: (scope) =>
      `http://${BigInt('0x' + scope).toString(36)}.localhost:${sandboxPort}`,
    oidc: {
      issuer: oidc.origin,
      clientId: 'haip-test',
      clientSecret: 'test-secret',
      allowLocalHttp: true,
    },
    webhookHosts: [],
    ...options,
  });
  const server = createApp(service).listen(port, '127.0.0.1');
  const sandbox = createSandboxApp(service).listen(sandboxPort, '127.0.0.1');
  await Promise.all([
    new Promise<void>((r) => server.once('listening', r)),
    new Promise<void>((r) => sandbox.once('listening', r)),
  ]);
  const token = () => randomBytes(32).toString('base64url');
  const credentials = {
    operator: token(),
    producer: token(),
    publisher: token(),
    otherProducer: token(),
    otherPublisher: token(),
    foreignOperator: token(),
    foreignProducer: token(),
    foreignPublisher: token(),
  };
  await bootstrapTenant(service, 'test-tenant', 'operator', credentials.operator);
  await bootstrapTenant(service, 'foreign-tenant', 'operator', credentials.foreignOperator);
  const api = async (
    path: string,
    body?: unknown,
    credential = credentials.producer,
    method = body === undefined ? 'GET' : 'POST',
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + credential,
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'Idempotency-Key': randomBytes(16).toString('hex'),
            }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const put = async (path: string, data: unknown, credential = credentials.operator) => {
    const r = await api(path, data, credential, 'PUT');
    if (r.status !== 200) throw new Error('Setup ' + path + ': ' + JSON.stringify(r));
  };
  const principal = async (
    id: string,
    kind: string,
    config: unknown,
    key?: string,
    operator = credentials.operator,
  ) => put('/v2/admin/principals/' + id, { id, kind, config, token: key }, operator);
  for (const [id, sub] of [
    ['requester', 'requester'],
    ['reviewer', 'reviewer'],
    ['reviewer2', 'reviewer2'],
  ])
    await principal(id!, 'human', {
      enabled: true,
      identity_certain: true,
      oidc_issuer: oidc.origin,
      oidc_subject: sub,
    });
  await principal('publisher', 'publisher', { enabled: true }, credentials.publisher);
  await principal('other-publisher', 'publisher', { enabled: true }, credentials.otherPublisher);
  await principal(
    'producer',
    'producer',
    { enabled: true, publisher: 'publisher', owner: 'requester', routes: ['review'] },
    credentials.producer,
  );
  await principal(
    'other-producer',
    'producer',
    { enabled: true, publisher: 'other-publisher', owner: 'requester', routes: ['review'] },
    credentials.otherProducer,
  );
  await principal(
    'foreign-requester',
    'human',
    {
      enabled: true,
      identity_certain: true,
      oidc_issuer: oidc.origin,
      oidc_subject: 'foreign-requester',
    },
    undefined,
    credentials.foreignOperator,
  );
  await principal(
    'publisher',
    'publisher',
    { enabled: true },
    credentials.foreignPublisher,
    credentials.foreignOperator,
  );
  await principal(
    'producer',
    'producer',
    { enabled: true, publisher: 'publisher', owner: 'foreign-requester', routes: ['review'] },
    credentials.foreignProducer,
    credentials.foreignOperator,
  );
  const route = {
    reviewers: ['reviewer', 'reviewer2', 'requester'],
    separation_of_duties: true,
    limits: { ...DEFAULT_LIMITS },
    required_profiles: {},
    allowed_producers: ['producer', 'other-producer'],
    modes: ['fixed_mock'],
  };
  await put('/v2/admin/routes/review', route);
  await put(
    '/v2/admin/routes/review',
    { ...route, reviewers: ['foreign-requester'], allowed_producers: ['producer'] },
    credentials.foreignOperator,
  );
  const anchorDir = await mkdtemp(join(tmpdir(), 'haip-test-anchor-')),
    anchor = new TestAnchor(anchorDir),
    worker = new OutboxWorker(service, anchor);
  await worker.reconcile();
  async function flush() {
    for (let i = 0; i < 30; i++) {
      if (!(await worker.tick())) return;
    }
    throw new Error('Outbox did not settle');
  }
  async function login(subject = 'reviewer') {
    const first = await fetch(origin + '/auth/login', { redirect: 'manual' });
    const cookie = first.headers.getSetCookie()[0]!.split(';')[0]!;
    const url = new URL(first.headers.get('location')!);
    const signIn = await fetch(url.origin + '/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: url.searchParams.toString(), subject }),
    });
    const callback = await fetch(signIn.headers.get('location')!, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    if (callback.status !== 302)
      throw new Error('OIDC callback ' + callback.status + ': ' + (await callback.text()));
    const sessionCookie = callback.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-haip='))!
      .split(';')[0]!;
    const session = await (
      await fetch(origin + '/auth/session', { headers: { Cookie: sessionCookie } })
    ).json();
    return {
      cookie: sessionCookie,
      csrf: session.csrf,
      async call(path: string, body?: unknown, headers: Record<string, string> = {}) {
        const response = await fetch(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Cookie: sessionCookie,
            Origin: origin,
            'X-CSRF-Token': session.csrf,
            'Content-Type': 'application/json',
            'Idempotency-Key': token(),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json(), headers: response.headers };
      },
    };
  }
  const request = (execution = false, extra: Record<string, unknown> = {}) => ({
    protocol_revision: PROTOCOL_REVISION,
    purpose: execution ? 'authorise_execution' : 'review',
    profiles: execution ? { 'haip.execution': '1-draft.1' } : {},
    route: 'review',
    summary: 'Choose a support response',
    artefact: {
      digest: digest({ message: 'test' }),
      representation: 'application/json',
      digest_rules: 'rfc8785-sha256',
    },
    payload: { message: 'A stored support message' },
    response_schema: {
      type: 'object',
      properties: {
        choice: { type: 'string', enum: ['accept', 'decline'] },
        score: { type: 'number' },
      },
      required: ['choice'],
      additionalProperties: false,
    },
    review_document: 'Retained support message for a test review.',
    ...(execution
      ? {
          execution: {
            action_occurrence_id: randomBytes(16).toString('hex'),
            proposal_digest: digest({ action: 'counter.increment', amount: 1 }),
            proposal_format: 'mock-counter-v1',
            context_digest: digest({ counter: 'test' }),
            context_format: 'mock-context-v1',
            policy: {
              source: 'operator',
              revision: '1',
              digest: digest({ allow: 'counter.increment' }),
            },
            mode: 'fixed_mock',
            valid_until: new Date(Date.now() + 3600000).toISOString(),
            execution_seconds: 60,
            provenance: { profile: 'haip.execution', version: '1-draft.1', references: {} },
          },
        }
      : {}),
    ...extra,
  });
  return {
    origin,
    trust,
    service,
    store,
    worker,
    anchor,
    api,
    put,
    principal,
    route,
    credentials,
    login,
    request,
    flush,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => sandbox.close(() => r()));
      await oidc.close();
      await store.close();
      await pg.close();
      await rm(anchorDir, { recursive: true, force: true });
    },
  };
}
