import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { build } from 'esbuild';
import { collectOriginsTls } from '../deployment/adapters/origins-tls.mjs';
import { createApp, createSandboxApp } from '../haip-server/src/server.js';
import type { ReviewService } from '../haip-server/src/service.js';
import { environment } from './environment.js';
import { caddyFixture, caddyResponse } from './fixtures/caddy.js';
import { localCertificates } from './fixtures/certificates.js';

const execute = promisify(execFile);
const cookie = '__Host-haip=' + 's'.repeat(43);
const resolveLoopback = async () => [{ address: '127.0.0.1', family: 4 }];

function fixturePlan(port: number) {
  return {
    document_type: 'plan',
    schema_version: 'haip.deployment.acceptance.v1',
    source: { commit: '0'.repeat(40) },
    deployment: {
      trusted_origin: `https://review.trusted.test:${port}`,
      sandbox_origin_pattern: `https://{scope}.sandbox.test:${port}`,
    },
  };
}

function testApplications(service: ReviewService, port: number) {
  const { deployment } = fixturePlan(port);
  service.config.origin = deployment.trusted_origin;
  service.config.sandboxOrigin = (scope) =>
    deployment.sandbox_origin_pattern.replace('{scope}', BigInt('0x' + scope).toString(36));
  return {
    trusted: createApp(service, { exactHost: true }),
    sandbox: createSandboxApp(service),
  };
}

async function fixture(
  options: {
    redirect?: boolean;
    missingPolicy?: boolean;
    returnedDomain?: boolean;
    oversizedHealth?: boolean;
    stalledHealth?: boolean;
    hsts?: string;
    service?: ReviewService;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'haip-origin-tls-'));
  let redirects = 0;
  let applications:
    | { trusted: ReturnType<typeof createApp>; sandbox: ReturnType<typeof createSandboxApp> }
    | undefined;
  try {
    const { ca, caPath, keyPath, certPath } = await localCertificates(directory, [
      'DNS:review.trusted.test',
      'DNS:*.sandbox.test',
    ]);
    const service = options.service;
    if (service && process.env.HAIP_TEST_CADDY) {
      const proxy = await caddyFixture(
        process.env.HAIP_TEST_CADDY,
        directory,
        certPath,
        keyPath,
        (port) => testApplications(service, port),
      );
      return {
        directory,
        caPath,
        ca,
        plan: fixturePlan(proxy.port),
        redirects: () => 0,
        stopUpstreams: proxy.stopUpstreams,
        async close() {
          await proxy.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    }
    const server = createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      (request, response) => {
        const host = request.headers.host ?? '';
        const sandbox = host.includes('.sandbox.test:');
        if (applications) {
          response.setHeader('Strict-Transport-Security', 'max-age=31536000');
          return applications[sandbox ? 'sandbox' : 'trusted'](request, response);
        }
        const origin = `https://review.trusted.test:${(server.address() as any).port}`;
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        response.setHeader(
          'Cross-Origin-Resource-Policy',
          sandbox ? 'cross-origin' : 'same-origin',
        );
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Strict-Transport-Security', options.hsts ?? 'max-age=31536000');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader(
          'Permissions-Policy',
          'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
        );
        if (sandbox) {
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader(
            'Content-Security-Policy',
            `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src data:; frame-src about:; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors ${origin}`,
          );
          response.setHeader(
            'Permissions-Policy',
            'camera=(), microphone=(), geolocation=(), payment=(), clipboard-read=(), clipboard-write=()',
          );
          if (!options.missingPolicy)
            response.setHeader(
              'Connection-Allowlist',
              '(); webrtc=block; redirects=block; report-to=haip-view-policy',
            );
        } else {
          response.setHeader('X-Frame-Options', 'DENY');
          response.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          );
        }
        const scope = request.url?.match(/^\/sandbox\/([a-f0-9]{64})$/)?.[1];
        if (request.url === '/redirect-target') redirects++;
        if (
          options.redirect &&
          request.url === '/health' &&
          host.startsWith('review.trusted.test:')
        ) {
          response.writeHead(302, { Location: '/redirect-target' });
        } else if (request.url === '/auth/session' && request.headers.cookie === cookie) {
          if (options.returnedDomain)
            response.setHeader(
              'Set-Cookie',
              `${cookie}; Secure; HttpOnly; Path=/; SameSite=Lax; Domain=trusted.test`,
            );
        } else if (
          host === 'unexpected-host.invalid' ||
          (sandbox &&
            (!scope ||
              host !==
                `${BigInt('0x' + scope).toString(36)}.sandbox.test:${(server.address() as any).port}`))
        ) {
          response.statusCode = 404;
        }
        if (
          request.url === '/health' &&
          host.startsWith('review.trusted.test:') &&
          options.oversizedHealth
        ) {
          response.end(Buffer.alloc(1024 * 1024 + 1, 0x61));
          return;
        }
        if (
          request.url === '/health' &&
          host.startsWith('review.trusted.test:') &&
          options.stalledHealth
        ) {
          response.write('local fixture');
          return;
        }
        response.end(
          request.url === '/auth/session'
            ? JSON.stringify({ csrf: 'private-fixture-csrf', subject: 'fixture-reviewer' })
            : 'local fixture',
        );
      },
    );
    await new Promise<void>((complete) => server.listen(0, '127.0.0.1', complete));
    const port = (server.address() as any).port;
    if (service) applications = testApplications(service, port);
    return {
      directory,
      caPath,
      ca,
      plan: fixturePlan(port),
      redirects: () => redirects,
      async close() {
        await new Promise<void>((complete, reject) =>
          server.close((error) => (error ? reject(error) : complete())),
        );
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('the origins adapter exercises authenticated browser boundaries while keeping local evidence blocked for deployment', async () => {
  const env = await environment();
  let tls: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    tls = await fixture({ service: env.service });
    const asset = await build({
      entryPoints: ['examples/http/choice-app.js'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    });
    const bundle = await env.api(
      '/v2/bundles',
      {
        html:
          '<!doctype html><body><script type="module">' +
          asset.outputFiles[0]!.text.replaceAll('</script', '<\\/script') +
          '</script></body>',
        compatibility: { agent_ui: '2' },
        author: 'Local browser acceptance',
        licence: 'MIT',
      },
      env.credentials.publisher,
    );
    assert.equal(bundle.status, 201);
    const responseSchema = JSON.parse(
      await readFile('examples/http/review.json', 'utf8'),
    ).response_schema;
    const created = await env.api(
      '/v2/requests',
      env.request(false, {
        bundle_id: bundle.body.id,
        profiles: { 'haip.agent-ui': '2' },
        metadata: { haip_acceptance_fixture: 'origins_tls' },
        response_schema: responseSchema,
      }),
    );
    assert.equal(created.status, 201);
    const id = created.body.request.id;
    const planPath = join(tls.directory, 'browser-plan.json');
    const reportPath = join(tls.directory, 'browser-report.json');
    const evidenceDirectory = join(tls.directory, 'browser-evidence');
    const plan = JSON.parse(await readFile('deployment/acceptance.plan.example.json', 'utf8'));
    plan.source.commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
    Object.assign(plan.deployment, tls.plan.deployment);
    plan.deployment.environment = 'local-browser-fixture';
    plan.adapter_env = ['PLAYWRIGHT_BROWSERS_PATH'];
    plan.secret_env = [];
    const origins = plan.checks.find((check: { id: string }) => check.id === 'origins_tls');
    origins.command = [
      process.execPath,
      'deployment/adapters/origins-tls.mjs',
      planPath,
      evidenceDirectory,
      '--fixture-ca',
      tls.caPath,
      '--review-id',
      id,
    ];
    delete origins.unrun_reason;
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
    await execute(
      process.execPath,
      [
        'deployment/run-acceptance.mjs',
        planPath,
        reportPath,
        '--allow-dirty',
        '--allow-incomplete',
      ],
      { timeout: 75_000 },
    );
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const result = report.checks.find((check: { id: string }) => check.id === 'origins_tls');
    assert.equal(
      result.status,
      'blocked',
      JSON.stringify(result.assertions.filter((entry: { passed: boolean }) => !entry.passed)),
    );
    assert.deepEqual(report.summary, {
      passed: 0,
      blocked: 1,
      failed: 0,
      unrun: 9,
      accepted: false,
    });
    const { stdout: validation } = await execute(process.execPath, [
      'deployment/run-acceptance.mjs',
      '--validate',
      reportPath,
    ]);
    assert.deepEqual(JSON.parse(validation), { valid: true, accepted: false });
    assert.equal(result.facts.browser_boundaries_exercised, true);
    assert.equal(result.facts.session_issuance_exercised, true);
    const [evidenceFile] = await readdir(evidenceDirectory);
    const evidence = await readFile(join(evidenceDirectory, evidenceFile!), 'utf8');
    assert.equal(JSON.parse(evidence).evidence_kind, 'local_fixture');
    assert.equal(JSON.parse(evidence).browser.passed, true);
    assert.equal(
      `sha256:${createHash('sha256').update(evidence).digest('hex')}`,
      result.evidence[0].digest,
    );
    assert(!evidence.includes(id));
    const status = await env.api(`/v2/requests/${id}`);
    assert.equal(status.body.decision_state, 'pending');
    assert.equal(
      (await env.api(`/v2/requests/${id}/material`)).body.candidate.response.choice,
      'accept',
    );
    const unmarked = await env.api(
      '/v2/requests',
      env.request(false, {
        bundle_id: bundle.body.id,
        profiles: { 'haip.agent-ui': '2' },
        response_schema: responseSchema,
      }),
    );
    assert.equal(unmarked.status, 201);
    const unmarkedId = unmarked.body.request.id;
    const { stdout: refusal } = await execute(
      process.execPath,
      [...origins.command.slice(1, -1), unmarkedId],
      { timeout: 60_000 },
    );
    const denied = JSON.parse(refusal);
    assert.equal(denied.status, 'failed');
    assert(
      denied.assertions.some(
        (item: { name: string; passed: boolean }) =>
          item.name === 'browser_test_review' && !item.passed,
      ),
    );
    assert.equal((await env.api(`/v2/requests/${unmarkedId}/material`)).body.candidate, null);
    if (tls.stopUpstreams) {
      assert.equal(
        JSON.parse(evidence).records.find(
          (record: { name: string }) => record.name === 'trusted_unexpected_host',
        ).status,
        421,
      );
      await tls.stopUpstreams();
      const { trusted_origin, sandbox_origin_pattern } = tls.plan.deployment;
      const trusted = await caddyResponse(new URL('/health', trusted_origin), tls.ca);
      const sandbox = await caddyResponse(
        new URL('/', sandbox_origin_pattern.replace('{scope}', '1')),
        tls.ca,
      );
      for (const error of [trusted, sandbox]) {
        assert.equal(error.status, 502);
        assert.equal(error.headers['cache-control'], 'no-store');
        assert.equal(error.headers['cross-origin-opener-policy'], 'same-origin');
        assert.equal(error.headers['cross-origin-embedder-policy'], 'require-corp');
        assert.equal(error.headers['strict-transport-security'], 'max-age=31536000');
        assert.equal(error.headers['x-content-type-options'], 'nosniff');
        assert.match(String(error.headers['permissions-policy']), /clipboard-write=\(\)/);
        assert.match(String(error.headers['content-security-policy']), /frame-ancestors 'none'/);
        assert.equal(error.headers['set-cookie'], undefined);
      }
      assert.equal(trusted.headers['cross-origin-resource-policy'], 'same-origin');
      assert.equal(sandbox.headers['cross-origin-resource-policy'], 'cross-origin');
      assert.equal(
        sandbox.headers['connection-allowlist'],
        '(); webrtc=block; redirects=block; report-to=haip-view-policy',
      );
      assert.equal(sandbox.headers['report-to'], undefined);
      assert.equal(sandbox.headers['reporting-endpoints'], undefined);
    }
  } finally {
    await tls?.close();
    await env.close();
  }
});

test('origins adapter records actual TLS and scoped routing but keeps omitted browser evidence blocked', async () => {
  const env = await fixture();
  try {
    const { result, document } = await collectOriginsTls(env.plan, {
      fixture: true,
      ca: env.ca,
      resolve: resolveLoopback,
      cookie,
    });
    assert.equal(
      result.status,
      'blocked',
      JSON.stringify(result.assertions.filter((value: any) => !value.passed)),
    );
    assert.equal(
      result.assertions.every((value: any) => value.passed),
      true,
    );
    assert.equal(result.facts.authenticated_session_observed, true);
    assert.equal(result.facts.browser_boundaries_exercised, false);
    assert.equal(result.facts.session_issuance_exercised, false);
    assert.equal(document.evidence_kind, 'local_fixture');
    assert.equal(document.records.length, 8);
    assert.equal(
      document.records.every((value: any) => value.tls?.authorised && value.tls.hostname_valid),
      true,
    );
    assert.match(document.records[0].tls.certificate_digest, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(
      JSON.stringify({ result, document }),
      /private-fixture-csrf|ssssssssssssssss/,
    );
  } finally {
    await env.close();
  }
});

test('origins adapter rejects missing network policy and a session cookie scoped to a parent domain', async () => {
  const env = await fixture({ missingPolicy: true, returnedDomain: true });
  try {
    const { result } = await collectOriginsTls(env.plan, {
      fixture: true,
      ca: env.ca,
      resolve: resolveLoopback,
      cookie,
    });
    assert.equal(result.status, 'failed');
    assert.equal(
      result.assertions.find((value: any) => value.name === 'sandbox_scope_1_connection_allowlist')
        ?.passed,
      false,
    );
    assert.equal(
      result.assertions.find(
        (value: any) => value.name === 'authenticated_session_returned_session_cookie',
      )?.passed,
      false,
    );
  } finally {
    await env.close();
  }
});

test('origins adapter does not follow redirects and validates both certificate trust and hostname', async () => {
  const env = await fixture({ redirect: true });
  try {
    const options = { fixture: true, ca: env.ca, resolve: resolveLoopback };
    const redirected = await collectOriginsTls(env.plan, options);
    assert.equal(redirected.result.status, 'failed');
    assert.equal(env.redirects(), 0);
    const untrusted = await collectOriginsTls(env.plan, { resolve: resolveLoopback });
    assert.equal(untrusted.result.status, 'failed');
    assert.equal(
      untrusted.document.records.every((value: any) => value.error_code),
      true,
    );
    const wrongHostname = structuredClone(env.plan);
    wrongHostname.deployment.trusted_origin = env.plan.deployment.trusted_origin.replace(
      'review.trusted.test',
      'wrong.trusted.test',
    );
    const wrong = await collectOriginsTls(wrongHostname, options);
    assert.equal(wrong.result.status, 'failed');
    assert.equal(wrong.document.records[0].error_code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  } finally {
    await env.close();
  }
});

test('origins adapter bounds stalled DNS and refuses origin and credential ambiguity before probing', async () => {
  const plan = {
    deployment: {
      trusted_origin: 'https://review.trusted.test',
      sandbox_origin_pattern: 'https://{scope}.sandbox.test',
    },
  };
  const start = Date.now();
  const stalled = await collectOriginsTls(plan, {
    timeoutMs: 10,
    resolve: () => new Promise(() => {}),
  });
  assert.equal(stalled.result.status, 'failed');
  assert.ok(Date.now() - start < 1500);
  assert.equal(
    stalled.document.records.every((value: any) => value.error_code === 'PROBE_TIMEOUT'),
    true,
  );
  const sameSite = {
    deployment: { ...plan.deployment, sandbox_origin_pattern: 'https://{scope}.trusted.test' },
  };
  await assert.rejects(collectOriginsTls(sameSite), /distinct registrable sites/);
  await assert.rejects(
    collectOriginsTls(plan, { cookie: `${cookie}; extra=credential` }),
    /Only one opaque/,
  );
  await assert.rejects(
    collectOriginsTls(plan, { ca: Buffer.from('custom') }),
    /only for labelled fixtures/,
  );
});

test('origins adapter bounds oversized bodies and a stalled response stream', async () => {
  const controls = { oversizedHealth: true, stalledHealth: false };
  const env = await fixture(controls);
  try {
    const options = { fixture: true, ca: env.ca, resolve: resolveLoopback, timeoutMs: 150 };
    const large = await collectOriginsTls(env.plan, options);
    assert.equal(large.result.status, 'failed');
    assert.equal(large.document.records[0].error_code, 'PROBE_TOO_LARGE');
    controls.oversizedHealth = false;
    controls.stalledHealth = true;
    const start = Date.now();
    const stalled = await collectOriginsTls(env.plan, options);
    assert.equal(stalled.result.status, 'failed');
    assert.equal(stalled.document.records[0].error_code, 'PROBE_TIMEOUT');
    assert.ok(Date.now() - start < 1500);
  } finally {
    await env.close();
  }
});

test('origins adapter rejects duplicate and malformed HSTS directives and zero retention', async () => {
  const controls = { hsts: 'max-age=31536000; max-age=0' };
  const env = await fixture(controls);
  try {
    const options = { fixture: true, ca: env.ca, resolve: resolveLoopback };
    for (const value of [
      'max-age=31536000; max-age=0',
      'max-age=31536000; mAx-AgE=0',
      'max-age=31536000; includeSubDomains; INCLUDESUBDOMAINS',
      'max-age=0',
      'max-age=31536000; invalid/name',
      'max-age=31536000; includeSubDomains=yes',
      'max-age=31536000x',
    ]) {
      controls.hsts = value;
      const { result } = await collectOriginsTls(env.plan, options);
      assert.equal(result.status, 'failed', value);
      assert.equal(
        result.assertions.find((entry: any) => entry.name === 'trusted_health_hsts')?.passed,
        false,
        value,
      );
    }
    for (const value of [
      'MAX-AGE=31536000; includeSubDomains',
      'max-age="31536000"; extension="a;b"',
    ]) {
      controls.hsts = value;
      const { result } = await collectOriginsTls(env.plan, options);
      assert.equal(result.status, 'blocked', value);
      assert.equal(
        result.assertions.find((entry: any) => entry.name === 'trusted_health_hsts')?.passed,
        true,
        value,
      );
    }
  } finally {
    await env.close();
  }
});

test('origins adapter CLI preserves private schema-compatible evidence with source and plan binding', async () => {
  const env = await fixture();
  try {
    const evidenceDirectory = join(env.directory, 'evidence');
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const planPath = join(env.directory, 'plan.json');
    const planBytes = JSON.stringify(env.plan);
    await writeFile(planPath, planBytes, { mode: 0o600 });
    const outcome = await execute(
      process.execPath,
      [
        'deployment/adapters/origins-tls.mjs',
        planPath,
        evidenceDirectory,
        '--fixture-ca',
        env.caPath,
      ],
      {
        env: {
          ...process.env,
          HAIP_ACCEPTANCE_CHECK_ID: 'origins_tls',
          HAIP_ACCEPTANCE_REVIEW_COOKIE: cookie,
        },
      },
    );
    const result = JSON.parse(outcome.stdout);
    const schema = JSON.parse(await readFile('deployment/acceptance.schema.json', 'utf8'));
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addSchema(schema);
    const validate = ajv.getSchema(`${schema.$id}#/$defs/adapterResult`)!;
    assert.equal(validate(result), true, JSON.stringify(validate.errors));
    assert.equal(result.status, 'blocked');
    const names = await readdir(evidenceDirectory);
    assert.equal(names.length, 1);
    const evidencePath = join(evidenceDirectory, names[0]);
    const evidenceFile = await open(evidencePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let evidenceBytes: Buffer;
    try {
      const info = await evidenceFile.stat();
      assert.equal(info.isFile(), true);
      assert.equal(info.mode & 0o777, 0o600);
      evidenceBytes = await evidenceFile.readFile();
    } finally {
      await evidenceFile.close();
    }
    const evidence = JSON.parse(evidenceBytes.toString('utf8'));
    assert.equal(evidence.source_commit, env.plan.source.commit);
    assert.equal(
      evidence.plan_digest,
      'sha256:' + createHash('sha256').update(planBytes).digest('hex'),
    );
    assert.equal(
      result.evidence[0].digest,
      'sha256:' + createHash('sha256').update(evidenceBytes).digest('hex'),
    );
    assert.doesNotMatch(
      outcome.stdout + evidenceBytes.toString(),
      /private-fixture-csrf|ssssssssssssssss|BEGIN PRIVATE KEY/,
    );
    await assert.rejects(
      execute(
        process.execPath,
        [
          'deployment/adapters/origins-tls.mjs',
          planPath,
          evidenceDirectory,
          '--fixture-ca',
          env.caPath,
        ],
        { env: { ...process.env, HAIP_ACCEPTANCE_CHECK_ID: 'external_identity' } },
      ),
    );
  } finally {
    await env.close();
  }
});
