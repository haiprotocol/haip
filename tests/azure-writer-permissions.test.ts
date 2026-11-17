import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { toHttpHeadersLike } from '@azure/core-http-compat';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import type { IHttpClient } from '@azure/storage-blob';
import {
  collectWriterPermissions,
  runWriterPermissions,
} from '../deployment/adapters/azure-writer-permissions.mjs';
import { sha256 } from '../deployment/adapters/evidence.mjs';
import { azureFixture } from './fixtures/azure-acceptance.js';

type Fault =
  | 'inherited'
  | 'wildcard'
  | 'foreign_page'
  | 'drift'
  | 'overwrite'
  | 'account_key_read'
  | 'wrong_denial';

function writerFixture({ fault, clientSecret }: { fault?: Fault; clientSecret?: boolean } = {}) {
  const original = azureFixture();
  const { account, service, safety } = original;
  const plan = {
    ...original.plan,
    deployment: { ...original.plan.deployment, independent_administration_asserted: true },
  };
  const resourceGroup = account.split('/providers/')[0];
  const principal = randomUUID(),
    group = randomUUID();
  const settings = {
    ...original.settings,
    runtime_credential: clientSecret ? 'client_secret' : 'managed_identity',
    runtime_identity_resource_id: `${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/haip-fixture`,
    writer_probe_id: randomUUID(),
  };
  const origin = `https://${settings.account}.blob.core.windows.net`;
  const checkpoint = `${service}/containers/${settings.checkpoint.container}`;
  const roleRoot = '/providers/Microsoft.Authorization';
  const role = `${resourceGroup}${roleRoot}/roleDefinitions/${randomUUID()}`;
  const actionPrefix = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/';
  const key = `haip-acceptance/writer-probes/${settings.writer_probe_id}.json`;
  const existingTag = 'fixturehold';
  original.resources[safety].properties.legalHold = { tags: [{ tag: existingTag }] };
  const canaries = new Map<string, { version: string; bytes: Buffer }>();
  const blobWrites: string[] = [],
    armProbes: string[] = [],
    scopeRequests: URL[] = [],
    identityRequests: URL[] = [];
  const expiry = new Date(Date.now() + 91 * 86_400_000).toUTCString();
  const etag = '"fixture-canary"';
  const transport: IHttpClient = {
    async sendRequest(request) {
      const url = new URL(request.url);
      const [, container, ...parts] = url.pathname.split('/');
      if (parts.join('/') !== key && url.searchParams.get('prefix') !== key)
        return original.options.blobHttpClient.sendRequest(request);
      assert.equal(url.origin, origin);
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-runtime-token');
      const held = container === settings.safety.container;
      assert.ok(held || container === settings.checkpoint.container);
      const canary = canaries.get(container);
      const comp = url.searchParams.get('comp');
      const version = url.searchParams.get('versionid');
      const response = (status: number, fields: Record<string, string> = {}) => ({
        request,
        status,
        headers: toHttpHeadersLike(createHttpHeaders(fields)),
      });
      const reject = (status: number, code: string) => ({
        ...response(status, { 'content-type': 'application/xml', 'x-ms-error-code': code }),
        bodyAsText: `<Error><Code>${code}</Code><Message>fixture response</Message></Error>`,
      });
      if (request.method === 'PUT' && request.headers.get('if-none-match') === '*') {
        assert.equal(comp, null);
        assert.equal(version, null);
        assert.equal(request.headers.get('x-ms-blob-type'), 'BlockBlob');
        assert.equal(request.headers.get('x-ms-legal-hold'), undefined);
        assert.equal(request.headers.get('x-ms-immutability-policy-until-date'), undefined);
        blobWrites.push(`${container}:${canary ? 'duplicate' : 'create'}`);
        if (canary) return reject(412, 'ConditionNotMet');
        const input = request.body;
        assert.ok(typeof input === 'string' || input instanceof Uint8Array);
        const bytes = Buffer.from(input);
        assert.deepEqual(JSON.parse(bytes.toString('utf8')), {
          check: 'writer_permissions',
          probe: settings.writer_probe_id,
        });
        const created = `2026-11-16T00:00:0${held ? 4 : 3}.0000000Z`;
        canaries.set(container, { version: created, bytes });
        return response(201, { 'x-ms-version-id': created, etag });
      }
      assert.ok(canary, 'The adapter only probes its newly created canary');
      if (request.method === 'PUT' && comp === null) {
        assert.equal(version, null);
        assert.equal(request.headers.get('if-match'), etag);
        blobWrites.push(`${container}:replace`);
        if (fault === 'overwrite')
          return response(201, { 'x-ms-version-id': canary.version, etag });
        return held
          ? reject(409, 'BlobImmutableDueToPolicy')
          : reject(403, 'AuthorizationPermissionMismatch');
      }
      if (request.method === 'PUT' || request.method === 'DELETE') {
        assert.equal(version, canary.version);
        if (request.method === 'PUT') {
          assert.equal(comp, 'legalhold');
          assert.equal(request.headers.get('x-ms-legal-hold'), 'false');
        } else if (comp === null) {
          assert.equal(request.headers.get('if-match'), etag);
        } else assert.equal(comp, 'immutabilityPolicies');
        blobWrites.push(`${container}:${comp ?? 'delete-version'}`);
        return reject(403, 'AuthorizationPermissionMismatch');
      }
      if (comp === 'list') {
        assert.equal(request.method, 'GET');
        return {
          ...response(200, { 'content-type': 'application/xml' }),
          bodyAsText: `<EnumerationResults><Blobs><Blob><Name>${key}</Name><VersionId>${canary.version}</VersionId><IsCurrentVersion>true</IsCurrentVersion><Properties><BlobType>BlockBlob</BlobType></Properties></Blob></Blobs><NextMarker/></EnumerationResults>`,
        };
      }
      assert.equal(version, canary.version);
      const length = canary.bytes.length;
      const headers = {
        etag,
        'content-length': String(length),
        'x-ms-version-id': canary.version,
        'x-ms-immutability-policy-mode': 'locked',
        'x-ms-immutability-policy-until-date': expiry,
        'x-ms-legal-hold': String(held),
      };
      if (request.method === 'HEAD') return response(200, headers);
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('if-match'), etag);
      return {
        ...response(206, { ...headers, 'content-range': `bytes 0-${length - 1}/${length}` }),
        readableStreamBody: Readable.from([canary.bytes]),
      };
    },
  };
  const assignments = new Map(
    [checkpoint, safety].map((scope) => {
      const id = `${scope}${roleRoot}/roleAssignments/${randomUUID()}`;
      const roleDefinitionId = role;
      return [
        scope,
        { id, properties: { scope, roleDefinitionId, principalId: group, principalType: 'Group' } },
      ];
    }),
  );
  const options = {
    managementCredential: original.options.managementCredential,
    runtimeCredential: {
      async getToken(scopes: string | string[]) {
        const [scope] = [scopes].flat();
        const token = {
          'https://storage.azure.com/.default': 'fixture-runtime-token',
          'https://management.azure.com/.default': 'fixture-runtime-arm-token',
          'https://graph.microsoft.com/.default': 'fixture-graph-token',
        }[scope];
        assert.ok(token);
        return { token, expiresOnTimestamp: Date.now() + 3_600_000 };
      },
    },
    blobHttpClient: transport,
    async request(address: string, init: RequestInit) {
      const url = new URL(address);
      const headers = new Headers(init.headers);
      const token = headers.get('authorization');
      assert.equal(init.redirect, 'error');
      if (url.origin === 'https://graph.microsoft.com') {
        assert.equal(token, 'Bearer fixture-graph-token');
        assert.equal(
          url.pathname,
          `/v1.0/servicePrincipals(appId='${settings.runtime_client_id}')`,
        );
        identityRequests.push(url);
        return Response.json({
          id: principal,
          appId: settings.runtime_client_id,
          appOwnerOrganizationId: settings.tenant_id,
          accountEnabled: true,
        });
      }
      assert.equal(url.origin, 'https://management.azure.com');
      if (token === 'Bearer fixture-runtime-arm-token') {
        armProbes.push(url.pathname);
        assert.equal(url.searchParams.get('api-version'), '2025-08-01');
        if (url.pathname === `${account}/listKeys`) {
          assert.equal(init.method, 'POST');
          if (fault === 'account_key_read')
            return Response.json({ keys: [{ value: 'private account marker' }] });
        } else {
          const body = JSON.parse(String(init.body));
          if (url.pathname === account) {
            assert.equal(init.method, 'PATCH');
            assert.deepEqual(body.properties, {
              allowSharedKeyAccess: false,
              allowBlobPublicAccess: false,
            });
          } else if (url.pathname === safety) {
            assert.equal(init.method, 'PATCH');
            assert.deepEqual(body.properties, { publicAccess: 'None' });
          } else if (url.pathname === `${safety}/clearLegalHold`) {
            assert.equal(init.method, 'POST');
            assert.equal(body.tags.length, 1);
            assert.match(body.tags[0], /^haip[a-f0-9]{18}$/);
            assert.notEqual(body.tags[0], existingTag);
          } else {
            assert.equal(url.pathname, `${safety}/immutabilityPolicies/default/extend`);
            assert.equal(init.method, 'POST');
            assert.match(headers.get('if-match') ?? '', /^"haip-[a-f0-9]{24}"$/);
            assert.equal(body.properties.immutabilityPeriodSinceCreationInDays, 91);
          }
        }
        return Response.json(
          { error: { code: fault === 'wrong_denial' ? 'NetworkDenied' : 'AuthorizationFailed' } },
          { status: 403 },
        );
      }
      assert.equal(token, 'Bearer fixture-arm-token');
      assert.equal(init.method, 'GET');
      if (url.pathname === settings.runtime_identity_resource_id) {
        assert.equal(url.searchParams.get('api-version'), '2023-01-31');
        identityRequests.push(url);
        return Response.json({
          id: url.pathname,
          properties: {
            clientId: settings.runtime_client_id,
            tenantId: settings.tenant_id,
            principalId: principal,
          },
        });
      }
      if (url.pathname === role)
        return Response.json({
          id: role,
          properties: {
            permissions: [
              {
                actions: fault === 'wildcard' ? ['*'] : [],
                dataActions: [`${actionPrefix}read`, `${actionPrefix}add/action`],
              },
            ],
          },
        });
      if (url.pathname.endsWith(`${roleRoot}/roleAssignments`)) {
        scopeRequests.push(url);
        assert.equal(url.searchParams.get('api-version'), '2022-04-01');
        const assigned = assignments.get(
          url.pathname.slice(0, -`${roleRoot}/roleAssignments`.length),
        );
        assert.ok(assigned);
        if (url.searchParams.get('$skipToken')) return Response.json({ value: [assigned] });
        assert.equal(url.searchParams.get('$filter'), `atScope() and assignedTo('${principal}')`);
        if (fault === 'inherited' || (fault === 'drift' && canaries.size === 2))
          return Response.json({
            value: [{ ...assigned, properties: { ...assigned.properties, scope: account } }],
          });
        if (fault === 'foreign_page')
          return Response.json({ value: [], nextLink: 'https://foreign.fixture.test/page' });
        const next = new URL(url);
        next.searchParams.delete('$filter');
        next.searchParams.set('$skipToken', 'opaque-fixture-page');
        return Response.json({ value: [], nextLink: next.href });
      }
      return original.options.request(address, init);
    },
  };
  return {
    plan,
    settings,
    options,
    blobWrites,
    armProbes,
    scopeRequests,
    identityRequests,
    canaries,
    original,
  };
}

test('the writer check audits inherited scope and then observes real SDK requests on disposable versions', async () => {
  for (const clientSecret of [false, true]) {
    const fixture = writerFixture({ clientSecret });
    const result = await collectWriterPermissions(fixture.plan, fixture.settings, fixture.options);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(fixture.scopeRequests.length, 8);
    assert.equal(
      fixture.identityRequests[0].origin,
      clientSecret ? 'https://graph.microsoft.com' : 'https://management.azure.com',
    );
    assert.equal(fixture.blobWrites.length, 10);
    assert.equal(fixture.armProbes.length, 5);
    assert.equal(fixture.canaries.size, 2);
    assert.equal(result.observations.attempts.checkpoint_duplicate.code, 'ConditionNotMet');
    assert.equal(result.observations.attempts.safety_overwrite.code, 'BlobImmutableDueToPolicy');
    assert.equal(result.observations.attempts.container_hold_clear.code, 'AuthorizationFailed');
    assert.equal(result.observations.assignments?.[0].assignment_digests.length, 1);
  }
});

test('broader roles, untrusted continuation and unprotected storage stop the writer before any blob write', async () => {
  for (const fault of ['inherited', 'wildcard', 'foreign_page'] as const) {
    const fixture = writerFixture({ fault });
    const result = await collectWriterPermissions(fixture.plan, fixture.settings, fixture.options);
    assert.equal(result.passed, false);
    assert.equal(result.assertions.at(-1)?.name, 'effective_roles');
    assert.deepEqual(fixture.blobWrites, []);
    assert.deepEqual(fixture.armProbes, []);
  }
  const fixture = writerFixture();
  fixture.original.records.safety.hold = false;
  const result = await collectWriterPermissions(fixture.plan, fixture.settings, fixture.options);
  assert.equal(result.passed, false);
  assert.equal(result.assertions.at(-1)?.name, 'immutable_preflight');
  assert.deepEqual(fixture.blobWrites, []);
});

test('an unexpected mutation or inconclusive authorisation result stops subsequent writer probes', async () => {
  for (const [fault, stage] of [
    ['overwrite', 'checkpoint_overwrite'],
    ['account_key_read', 'account_keys'],
    ['wrong_denial', 'account_keys'],
    ['drift', 'roles_after_probes'],
  ] as const) {
    const fixture = writerFixture({ fault });
    const result = await collectWriterPermissions(fixture.plan, fixture.settings, fixture.options);
    assert.equal(result.passed, false);
    assert.equal(result.assertions.at(-1)?.name, stage);
    assert.equal(result.assertions.at(-1)?.passed, false);
    assert.equal(JSON.stringify(result).includes('private account marker'), false);
    if (fault === 'overwrite') {
      assert.equal(fixture.blobWrites.length, 3);
      assert.equal(fixture.armProbes.length, 0);
    } else if (stage === 'account_keys') assert.equal(fixture.armProbes.length, 1);
  }
});

test('writer probes require an approved plan and preserve private evidence for fixture runs', async () => {
  const fixture = writerFixture();
  const invalid = {
    ...fixture.plan,
    deployment: { ...fixture.plan.deployment, independent_administration_asserted: false },
  };
  await assert.rejects(
    collectWriterPermissions(invalid, fixture.settings, fixture.options),
    /approved isolated acceptance plan/,
  );
  assert.deepEqual(fixture.scopeRequests, []);
  const directory = await mkdtemp(join(tmpdir(), 'haip-writer-acceptance-'));
  try {
    const planFile = join(directory, 'plan.json'),
      settingsFile = join(directory, 'storage.json');
    const evidenceDir = join(directory, 'evidence');
    const planText = JSON.stringify(fixture.plan);
    await writeFile(planFile, planText);
    await writeFile(
      settingsFile,
      JSON.stringify({ ...fixture.settings, plan_digest: sha256(planText + ' ') }),
    );
    await assert.rejects(
      runWriterPermissions(planFile, evidenceDir, settingsFile, fixture.options),
      /different acceptance plan/,
    );
    await assert.rejects(stat(evidenceDir), { code: 'ENOENT' });
    await writeFile(
      settingsFile,
      JSON.stringify({ ...fixture.settings, plan_digest: sha256(planText) }),
    );
    const result = await runWriterPermissions(planFile, evidenceDir, settingsFile, fixture.options);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(result.facts.canaries_recorded, 2);
    const evidenceFile = join(
      evidenceDir,
      result.evidence[0].reference.slice('private-evidence:'.length),
    );
    const bytes = await readFile(evidenceFile, 'utf8');
    assert.equal((await stat(evidenceFile)).mode & 0o777, 0o600);
    assert.equal(sha256(bytes), result.evidence[0].digest);
    for (const marker of [
      'fixture-runtime-arm-token',
      'fixture-arm-token',
      fixture.settings.writer_probe_id,
      fixture.settings.account,
    ])
      assert.equal(bytes.includes(marker), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
