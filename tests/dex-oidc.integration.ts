import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { collectExternalIdentity } from '../deployment/adapters/external-identity.mjs';
import { createApp, createSandboxApp } from '../haip-server/src/server.js';
import { environment } from './environment.js';
import { caddyFixture, caddyResponse } from './fixtures/caddy.js';
import { localCertificates } from './fixtures/certificates.js';
import { freePort } from './fixtures/postgres.js';

const execute = promisify(execFile);

function account(id: string) {
  const userID = randomUUID();
  const email = `${id}@identity.test`;
  const password = randomBytes(24).toString('base64url');
  const hash = execFileSync('htpasswd', ['-niBC', '10', id], {
    input: password + '\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .trim()
    .split(':')[1];
  if (!hash?.startsWith('$2')) throw new Error('Expected a bcrypt hash from htpasswd');
  // Dex encodes the configured user UUID and local connector into its public subject.
  const subject = Buffer.concat([
    Buffer.from([10, userID.length]),
    Buffer.from(userID),
    Buffer.from([18, 5]),
    Buffer.from('local'),
  ]).toString('base64url');
  return { id, email, password, subject, staticPassword: { userID, email, username: id, hash } };
}

for (const method of ['client_secret_basic', 'client_secret_post'] as const) {
  test(
    `Dex HTTPS sign-in exercises ${method}, callback refusals and role separation`,
    { timeout: 100_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'haip-dex-'));
      const originalCerts = getCACertificates('default');
      const originalFetch = globalThis.fetch;
      let env: Awaited<ReturnType<typeof environment>> | undefined;
      let caddy: Awaited<ReturnType<typeof caddyFixture>> | undefined;
      let dex: ReturnType<typeof execute> | undefined;
      try {
        const { ca, certPath, keyPath } = await localCertificates(directory, [
          'DNS:review.trusted.test',
          'DNS:*.sandbox.test',
          'IP:127.0.0.1',
        ]);
        setDefaultCACertificates([...originalCerts, ca.toString('utf8')]);
        const reviewer = account('dex-reviewer');
        const owner = account('dex-requester');
        const unmapped = account('dex-unmapped');
        const dexAddress = `127.0.0.1:${await freePort()}`;
        const issuer = `https://${dexAddress}/dex`;
        const clientId = 'haip-rehearsal';
        const secret = randomBytes(32).toString('base64url');
        env = await environment();
        const service = env.service;
        caddy = await caddyFixture(
          process.env.HAIP_TEST_CADDY ?? 'caddy',
          directory,
          certPath,
          keyPath,
          (port) => {
            service.config.origin = `https://review.trusted.test:${port}`;
            service.config.oidc = { issuer, clientId, clientSecret: secret, clientAuth: method };
            service.config.sandboxOrigin = (scope) =>
              `https://${BigInt('0x' + scope).toString(36)}.sandbox.test:${port}`;
            return {
              trusted: createApp(service, { exactHost: true }),
              sandbox: createSandboxApp(service),
            };
          },
        );
        const trusted = service.config.origin;
        const dexConfig = join(directory, 'dex.json');
        await writeFile(
          dexConfig,
          JSON.stringify({
            issuer,
            storage: { type: 'memory' },
            web: { https: dexAddress, tlsCert: certPath, tlsKey: keyPath },
            oauth2: {
              responseTypes: ['code'],
              skipApprovalScreen: true,
              pkce: { enforce: true, codeChallengeMethodsSupported: ['S256'] },
            },
            staticClients: [
              {
                id: clientId,
                name: 'HAIP fixture',
                secret,
                redirectURIs: [`${trusted}/auth/callback`],
              },
            ],
            enablePasswordDB: true,
            staticPasswords: [reviewer, owner, unmapped].map((user) => user.staticPassword),
          }),
          { mode: 0o600 },
        );
        dex = execute(process.env.HAIP_TEST_DEX ?? 'dex', ['serve', dexConfig], {
          env: { PATH: process.env.PATH },
          timeout: 100_000,
        });
        void dex.catch(() => {});
        let ready = false;
        for (let attempt = 0; attempt < 50 && !ready; attempt++) {
          if (!dex.child.pid || dex.child.exitCode !== null) await dex;
          const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
            redirect: 'error',
            signal: AbortSignal.timeout(1000),
          }).catch(() => undefined);
          ready = !!response?.ok && (await response.json()).issuer === issuer;
          if (!ready) await delay(100);
        }
        assert.ok(ready, 'Dex TLS discovery is available');
        assert.equal((await caddyResponse(new URL('/health', trusted), ca)).status, 200);
        const leaf = new X509Certificate(await readFile(certPath));
        const pin = createHash('sha256')
          .update(leaf.publicKey.export({ format: 'der', type: 'spki' }))
          .digest('base64');

        for (const user of [reviewer, owner, unmapped]) {
          await env.principal(user.id, 'human', {
            enabled: true,
            identity_certain: true,
            oidc_issuer: user === unmapped ? 'https://different.test/dex' : issuer,
            oidc_subject: user.subject,
          });
        }
        await env.principal('producer', 'producer', {
          enabled: true,
          publisher: 'publisher',
          owner: owner.id,
          routes: ['review'],
        });
        await env.put('/v2/admin/routes/review', {
          ...env.route,
          reviewers: [reviewer.id, owner.id],
        });
        const seeded = await env.api(
          '/v2/requests',
          env.request(false, {
            metadata: { haip_acceptance_fixture: 'external_identity' },
          }),
        );
        assert.equal(seeded.status, 201);

        const exchanges: { methodMatches: boolean; verifierPresent: boolean; status: number }[] =
          [];
        globalThis.fetch = async (input, options) => {
          const url = input instanceof Request ? input.url : String(input);
          const response = await originalFetch(input, options);
          if (url === `${issuer}/token`) {
            const authorization = new Headers(options?.headers).get('authorization');
            const form = new URLSearchParams(String(options?.body));
            const basic = authorization?.match(/^Basic ([A-Za-z0-9+/]+=*)$/i);
            const basicCredentials = basic
              ? Buffer.from(basic[1], 'base64')
                  .toString('utf8')
                  .split(':')
                  .map((value) => decodeURIComponent(value))
              : [];
            exchanges.push({
              methodMatches:
                method === 'client_secret_basic'
                  ? basicCredentials.length === 2 &&
                    basicCredentials[0] === clientId &&
                    basicCredentials[1] === secret &&
                    !form.has('client_secret')
                  : authorization === null &&
                    form.get('client_id') === clientId &&
                    form.get('client_secret') === secret,
              verifierPresent: /^[A-Za-z0-9._~-]{43,128}$/.test(form.get('code_verifier') ?? ''),
              status: response.status,
            });
          }
          return response;
        };
        const probe = await collectExternalIdentity(
          { deployment: { trusted_origin: trusted } },
          {
            issuer,
            client_id: clientId,
            client_auth: method,
            review_id: seeded.body.request.id,
            reviewer: reviewer.id,
            requester: owner.id,
            unmapped_account: true,
          },
          {
            fixturePins: [pin],
            async fixtureLogin(url: URL) {
              const reply = await caddyResponse(url, ca);
              const headers = new Headers();
              for (const [name, values] of Object.entries(reply.headers))
                for (const value of Array.isArray(values)
                  ? values
                  : values === undefined
                    ? []
                    : [values])
                  headers.append(name, value);
              return { status: reply.status, headers };
            },
            async signIn(page: Page, subject: string) {
              const user =
                subject === reviewer.id ? reviewer : subject === owner.id ? owner : unmapped;
              assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
              await page.locator('#login').fill(user.email);
              await page.locator('#password').fill(user.password);
              await page.locator('#submit-login').click();
            },
          },
        );
        assert.equal(
          probe.passed,
          true,
          JSON.stringify(probe.assertions.filter((row: { passed: boolean }) => !row.passed)),
        );
        assert.ok(
          exchanges.every((entry) => entry.methodMatches && entry.verifierPresent),
          JSON.stringify(exchanges),
        );
        assert.deepEqual(
          exchanges.map((entry) => entry.status),
          [200, 200, 200, 200, 400, 200, 200],
        );
      } finally {
        globalThis.fetch = originalFetch;
        if (dex) dex.child.kill('SIGTERM');
        await dex?.catch(() => {});
        await caddy?.close();
        await env?.close();
        setDefaultCACertificates(originalCerts);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
