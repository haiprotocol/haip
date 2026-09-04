import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pgClient from 'pg';
import { PROTOCOL_REVISION } from '@haip/protocol';
import {
  databaseConnection,
  requireProductionAnchor,
  validateOrigins,
  validateSigningTrust,
} from '../haip-server/src/startup.js';
import { Store } from '../haip-server/src/store.js';
import { postgres } from './fixtures/postgres.js';

test('production separates registrable sites, including private public-suffix entries', () => {
  validateOrigins('development', 'http://localhost:8080', 'http://{scope}.localhost:8081');
  validateOrigins('development', 'http://127.0.0.1:8080', 'http://{scope}.localhost:8081');
  validateOrigins('development', 'http://[::1]:8080', 'http://{scope}.localhost:8081');
  validateOrigins('development', 'https://review.example.com', 'https://{scope}.sandbox.net');
  for (const [host, sandbox] of [
    ['https://review.example.com', 'https://{scope}.example.com'],
    ['https://review.alpha.pages.dev', 'https://{scope}.alpha.pages.dev'],
    ['http://review.example.com', 'http://{scope}.sandbox.net'],
    ['http://localhost:8080', 'https://{scope}.example.net'],
    ['https://review.example.com', 'http://{scope}.localhost:8081'],
    ['http://localhost.attacker.example', 'http://{scope}.localhost.attacker.example'],
  ])
    assert.throws(
      () => validateOrigins('development', host!, sandbox!),
      /Non-loopback development requires HTTPS/,
    );
  validateOrigins('production', 'https://review.example.com', 'https://{scope}.review-sandbox.net');
  validateOrigins('production', 'https://review.alpha.pages.dev', 'https://{scope}.beta.pages.dev');
  validateOrigins('production', 'https://review.example.com', 'https://{scope}.scope.example.net');
  for (const [host, sandbox] of [
    ['https://review.example.com', 'https://{scope}.example.com'],
    ['https://review.example.co.uk', 'https://{scope}.example.co.uk'],
    ['https://review.alpha.pages.dev', 'https://{scope}.alpha.pages.dev'],
    ['https://review.example.com', 'https://{scope}.com'],
    ['https://review.example.com', 'https://{scope}.pages.dev'],
    ['http://review.example.com', 'https://{scope}.sandbox.example.net'],
    ['https://127.0.0.1', 'https://{scope}.example.net'],
    ['https://review.example.com', 'https://prefix-{scope}.example.net'],
    ['https://review.example.com', 'https://scope.{scope}-app.net'],
    ['https://review.example.com', 'https://prefix-{scope}.scope.example.net'],
    ['https://review.example.com/path', 'https://{scope}.example.net'],
    ['https://review.example.com', 'https://{scope}.sandbox.example.'],
    ['https://review.example.com', 'https://{scope}.foo_bar.example'],
  ])
    assert.throws(
      () => validateOrigins('production', host!, sandbox!),
      /origins|origin|Production/,
    );
});

test('production requires explicit anchor configuration before database access, including bootstrap', async () => {
  const complete = {
    HAIP_AZURE_ACCOUNT_URL: 'https://fixture.blob.core.windows.net',
    HAIP_AZURE_CONTAINER: 'audit',
    HAIP_AZURE_SAFETY_CONTAINER: 'safety',
    HAIP_ANCHOR_INDEPENDENT_ADMIN: 'true',
  };
  requireProductionAnchor('development', {});
  requireProductionAnchor('production', complete);
  for (const field of Object.keys(complete)) {
    const missing = { ...complete } as NodeJS.ProcessEnv;
    delete missing[field];
    assert.throws(() => requireProductionAnchor('production', missing), /Production requires/);
  }
  assert.throws(
    () =>
      requireProductionAnchor('production', {
        ...complete,
        HAIP_AZURE_SAFETY_CONTAINER: complete.HAIP_AZURE_CONTAINER,
      }),
    /separate Azure containers/,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('HAIP_')),
  );
  for (const args of [[], ['--bootstrap']]) {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'haip-server/src/main.ts', ...args],
        {
          timeout: 10000,
          env: {
            ...env,
            HAIP_MODE: 'production',
            HAIP_ORIGIN: 'https://review.example.com',
            HAIP_SANDBOX_ORIGIN: 'https://{scope}.example.net',
            HAIP_DATABASE_URL: 'postgresql://unreachable.invalid/haip',
          },
        },
      ),
      (error: any) => {
        assert.match(error.stderr, /Production requires HAIP_AZURE_ACCOUNT_URL/);
        assert.doesNotMatch(
          error.stderr,
          /ENOTFOUND|ECONNREFUSED|HAIP_SIGNING_KEY_FILE is required/,
        );
        return true;
      },
    );
  }
});

test('production database TLS cannot be weakened by connection-string parameters or plain PostgreSQL', async () => {
  for (const query of [
    '',
    '?sslmode=verify-full',
    '?ssl=true',
    '?sslmode=verify-full&uselibpqcompat=false',
    '?sslnegotiation=direct',
    '?sslmode=verify-full&sslnegotiation=direct',
  ]) {
    const connection = databaseConnection(
      'production',
      'postgresql://user@db.example/haip' + query,
      'fixture CA',
    );
    const ssl = connection.options.ssl as import('node:tls').ConnectionOptions;
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.ca, 'fixture CA');
    assert.equal(
      ssl.checkServerIdentity!('ignored', { subjectaltname: 'DNS:db.example' } as any),
      undefined,
    );
    assert.ok(
      ssl.checkServerIdentity!('other.example', { subjectaltname: 'DNS:other.example' } as any),
    );
    assert.equal(new URL(connection.url).searchParams.has('sslmode'), false);
    assert.equal(new URL(connection.url).searchParams.has('ssl'), false);
    assert.equal(new URL(connection.url).searchParams.has('sslnegotiation'), false);
    const client = new pgClient.Client({ ...connection.options, connectionString: connection.url });
    assert.deepEqual(
      (client as any).connectionParameters.ssl,
      connection.options.ssl,
      'pg must retain the verified TLS options after parsing the URL',
    );
    if (query.includes('sslnegotiation=direct'))
      assert.equal((client as any).connectionParameters.sslnegotiation, 'direct');
  }
  for (const query of [
    'ssl=false',
    'ssl=no-verify',
    'sslmode=disable',
    'sslmode=require',
    'sslmode=verify-ca',
    'sslmode=no-verify',
    'sslmode=verify-full&sslmode=disable',
    'sslrootcert=local.pem',
    'sslcert=client.pem',
    'uselibpqcompat=true',
    'host=/tmp',
    'ssl[rejectUnauthorized]=false',
  ])
    assert.throws(
      () => databaseConnection('production', 'postgresql://user@db.example/haip?' + query),
      /Production database/,
    );
  assert.throws(() => databaseConnection('production', 'socket:/tmp'), /PostgreSQL TCP/);
  assert.throws(
    () => databaseConnection('production', 'postgresql://user@%2Ftmp/haip'),
    /PostgreSQL TCP/,
  );
  assert.deepEqual(databaseConnection('development', 'postgresql://localhost/haip').options, {});
  const pg = await postgres();
  const connection = databaseConnection('production', pg.url);
  const store = new Store(connection.url, { ...connection.options, connectionTimeoutMillis: 2000 });
  try {
    await assert.rejects(store.pool.query('SELECT 1'), /does not support SSL/);
  } finally {
    await store.close();
    await pg.close();
  }
});

test('startup rejects missing, mismatched, expired, revoked or private trust keys and accepts historical public keys', () => {
  const pair = generateKeyPairSync('ed25519'),
    other = generateKeyPairSync('ed25519');
  const now = new Date('2026-08-30T12:00:00Z');
  const trust = {
    issuer: 'https://review.example.com',
    protocol_revision: PROTOCOL_REVISION,
    keys: [
      {
        key_id: 'active',
        algorithm: 'Ed25519',
        public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        not_before: '2026-01-01T00:00:00Z',
        not_after: '2027-01-01T00:00:00Z',
      },
    ],
  };
  const check = (value: unknown, id = 'active') =>
    validateSigningTrust(value, trust.issuer, id, pair.privateKey, now);
  check(trust);
  assert.throws(() => check(trust, 'missing'), /missing/);
  for (const value of [
    { ...trust, issuer: 'https://other.example.com' },
    { ...trust, protocol_revision: '1.0.0' },
    { ...trust, keys: [] },
    { ...trust, keys: [trust.keys[0], trust.keys[0]] },
  ])
    assert.throws(() => check(value));
  for (const changed of [
    { public_key: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    { public_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    { public_key: 'not a public key' },
    { not_before: '2028-01-01T00:00:00Z' },
    { not_after: now.toISOString() },
    { revoked_at: now.toISOString() },
    { not_before: '2027-01-01T00:00:00Z', not_after: '2026-01-01T00:00:00Z' },
  ])
    assert.throws(() => check({ ...trust, keys: [{ ...trust.keys[0], ...changed }] }));
  check({
    ...trust,
    keys: [
      ...trust.keys,
      {
        ...trust.keys[0],
        key_id: 'historical',
        public_key: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        not_before: '2020-01-01T00:00:00Z',
        not_after: '2021-01-01T00:00:00Z',
        revoked_at: '2021-01-01T00:00:00Z',
      },
    ],
  });
});
