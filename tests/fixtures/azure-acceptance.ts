import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { toHttpHeadersLike } from '@azure/core-http-compat';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import type { IHttpClient } from '@azure/storage-blob';
import { canonicalise, signRecord } from '@haip/protocol/crypto';
import { sha256 } from '../../deployment/adapters/evidence.mjs';

type ReadFixture = {
  contents: string;
  version: string;
  listedVersion?: string;
  reportedVersion?: string;
  lock: string;
  hold: boolean;
  expiry: Date;
  extraVersion?: boolean;
};

export function azureFixture() {
  const issuer = 'https://review.fixture.test';
  const protocol = '2.0.0-draft.3';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const ledger = randomUUID(),
    generation = randomUUID();
  const safetyKey = '7'.repeat(64);
  const plan = {
    document_type: 'plan',
    schema_version: 'haip.deployment.acceptance.v1',
    source: { commit: 'a'.repeat(40) },
    deployment: {
      trusted_origin: issuer,
      protocol_revision: protocol,
      runtime_identity_label: 'fixture-runtime',
      service_artifact_digest: `sha256:${'b'.repeat(64)}`,
      configuration_revision: 'configuration-fixture',
      components: [
        {
          kind: 'anchor',
          provider: 'Azure Blob Storage',
          region: 'UK South',
          revision: 'storage-fixture',
          identity_label: 'fixture-runtime',
        },
      ],
    },
  };
  const sign = (type: string, tenant: string, audience: string, payload: unknown) =>
    canonicalise(
      signRecord(
        payload,
        {
          type,
          tenant,
          audience,
          issuer,
          purpose: 'service',
          profiles: {},
          protocol_revision: protocol,
          key_id: 'fixture-signing',
          issued_at: new Date().toISOString(),
        },
        privateKey,
      ),
    );
  const settings = {
    account: 'haipfixture',
    resource_group: 'haip-fixture',
    subscription_id: randomUUID(),
    tenant_id: randomUUID(),
    runtime_client_id: randomUUID(),
    runtime_credential: 'managed_identity',
    anchor_prefix: 'haip/acceptance',
    checkpoint: {
      container: 'haip-checkpoints',
      key: `haip/acceptance/${ledger}/${generation}/0000000000000001.json`,
      digest: '',
      version_id: '2026-11-16T00:00:01.0000000Z',
    },
    safety: {
      container: 'haip-safety',
      key: `haip/acceptance/safety/${safetyKey}.json`,
      digest: '',
      version_id: '2026-11-16T00:00:02.0000000Z',
    },
    trust_manifest: {
      issuer,
      protocol_revision: protocol,
      keys: [
        {
          key_id: 'fixture-signing',
          algorithm: 'Ed25519',
          public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          not_before: '2025-01-01T00:00:00.000Z',
          not_after: '2099-01-01T00:00:00.000Z',
        },
      ],
    },
  };
  const sample = (permanent: boolean, mutate?: (payload: Record<string, unknown>) => void) => {
    const payload: Record<string, unknown> = permanent
      ? { key: safetyKey, value: 'private fixture marker' }
      : { ledger_id: ledger, generation, sequence: 1, head: `sha256:${'f'.repeat(64)}` };
    mutate?.(payload);
    return permanent
      ? sign('RecoveryFence', safetyKey, 'haip.recovery', payload)
      : sign('AuditCheckpoint', ledger, 'haip.audit', payload);
  };
  const expiry = new Date(Date.now() + 91 * 86_400_000);
  const records: Record<'checkpoint' | 'safety', ReadFixture> = {
    checkpoint: {
      contents: sample(false),
      version: settings.checkpoint.version_id,
      lock: 'locked',
      hold: false,
      expiry,
    },
    safety: {
      contents: sample(true),
      version: settings.safety.version_id,
      lock: 'Locked',
      hold: true,
      expiry,
    },
  };
  settings.checkpoint.digest = sha256(records.checkpoint.contents);
  settings.safety.digest = sha256(records.safety.contents);

  const account = `/subscriptions/${settings.subscription_id}/resourceGroups/${settings.resource_group}/providers/Microsoft.Storage/storageAccounts/${settings.account}`;
  const origin = `https://${settings.account}.blob.core.windows.net`;
  const service = `${account}/blobServices/default`;
  const checkpoint = `${service}/containers/${settings.checkpoint.container}`;
  const safety = `${service}/containers/${settings.safety.container}`;
  const lifecycle = `${account}/managementPolicies/default`;
  const policy = { state: 'Locked', immutabilityPeriodSinceCreationInDays: 91 };
  const resources: Record<string, Record<string, any>> = {
    [account]: {
      location: 'uksouth',
      properties: {
        primaryEndpoints: { blob: `${origin}/` },
        allowSharedKeyAccess: false,
        allowBlobPublicAccess: false,
        supportsHttpsTrafficOnly: true,
      },
    },
    [service]: { properties: { isVersioningEnabled: true } },
    [checkpoint]: {
      properties: { immutableStorageWithVersioning: { enabled: true }, hasLegalHold: false },
    },
    [safety]: { properties: { hasLegalHold: true } },
    [`${checkpoint}/immutabilityPolicies/default`]: { properties: { ...policy } },
    [`${safety}/immutabilityPolicies/default`]: { properties: { ...policy } },
  };
  let lifecycleStatus = 404;
  let absenceCode = 'ManagementPolicyNotFound';
  const armCalls: string[] = [];
  const blobCalls: { method: string; container: string; version: string | null }[] = [];
  const fixtureToken = (scope: string, token: string) => ({
    async getToken(requested: string | string[]) {
      assert.deepEqual([requested].flat(), [scope]);
      return { token, expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  });
  const transport: IHttpClient = {
    async sendRequest(request) {
      const url = new URL(request.url);
      assert.equal(url.origin, origin);
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-runtime-token');
      const [, container, ...path] = url.pathname.split('/');
      const kind = container === settings.safety.container ? 'safety' : 'checkpoint';
      const blob = records[kind],
        expected = settings[kind];
      assert.equal(container, expected.container);
      blobCalls.push({
        method: request.method,
        container,
        version: url.searchParams.get('versionid'),
      });
      if (url.searchParams.get('comp') === 'list') {
        assert.equal(request.method, 'GET');
        assert.equal(url.searchParams.get('prefix'), expected.key);
        const include = url.searchParams.getAll('include').flatMap((value) => value.split(','));
        assert.deepEqual(
          new Set(include),
          new Set(['deleted', 'snapshots', 'versions', 'deletedwithversions']),
        );
        const item = (version: string, current: boolean) =>
          `<Blob><Name>${expected.key}</Name><VersionId>${version}</VersionId><IsCurrentVersion>${current}</IsCurrentVersion><Properties><BlobType>BlockBlob</BlobType></Properties></Blob>`;
        return {
          request,
          status: 200,
          headers: toHttpHeadersLike(createHttpHeaders({ 'content-type': 'application/xml' })),
          bodyAsText: `<EnumerationResults><Blobs>${item(blob.listedVersion ?? blob.version, true)}${blob.extraVersion ? item('2026-11-15T00:00:00.0000000Z', false) : ''}</Blobs><NextMarker/></EnumerationResults>`,
        };
      }
      assert.equal(path.join('/'), expected.key);
      assert.equal(url.searchParams.get('versionid'), expected.version_id);
      const bytes = Buffer.from(blob.contents);
      const headers = createHttpHeaders({
        etag: '"fixture-version-etag"',
        'content-length': String(bytes.length),
        'x-ms-version-id': blob.reportedVersion ?? blob.version,
        'x-ms-immutability-policy-mode': blob.lock,
        'x-ms-immutability-policy-until-date': blob.expiry.toUTCString(),
        'x-ms-legal-hold': String(blob.hold),
      });
      if (request.method === 'HEAD')
        return { request, status: 200, headers: toHttpHeadersLike(headers) };
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('if-match'), '"fixture-version-etag"');
      assert.equal(
        request.headers.get('x-ms-range') ?? request.headers.get('range'),
        `bytes=0-${bytes.length - 1}`,
      );
      headers.set('content-range', `bytes 0-${bytes.length - 1}/${bytes.length}`);
      return {
        request,
        status: 206,
        headers: toHttpHeadersLike(headers),
        readableStreamBody: Readable.from([bytes]),
      };
    },
  };
  const options = {
    managementCredential: fixtureToken(
      'https://management.azure.com/.default',
      'fixture-arm-token',
    ),
    runtimeCredential: fixtureToken('https://storage.azure.com/.default', 'fixture-runtime-token'),
    async request(address: string, init: RequestInit) {
      const url = new URL(address);
      assert.equal(url.origin, 'https://management.azure.com');
      assert.equal(url.searchParams.get('api-version'), '2025-08-01');
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-arm-token');
      armCalls.push(url.pathname);
      if (url.pathname === lifecycle && !resources[lifecycle])
        return Response.json(
          { error: { code: absenceCode, message: 'private fixture marker' } },
          { status: lifecycleStatus },
        );
      const resource = resources[url.pathname];
      assert.ok(resource, 'The probe addresses only configured ARM resources');
      return Response.json(
        { id: url.pathname.toLowerCase(), ...resource },
        { headers: { etag: '"fixture-policy"' } },
      );
    },
    blobHttpClient: transport,
  };
  return {
    plan,
    settings,
    records,
    options,
    armCalls,
    blobCalls,
    resources,
    lifecycle,
    account,
    service,
    safety,
    sample,
    lifecycleError(status: number, code: string) {
      lifecycleStatus = status;
      absenceCode = code;
    },
    setRules(rules: unknown) {
      resources[lifecycle] = { properties: { policy: { rules } } };
    },
  };
}
