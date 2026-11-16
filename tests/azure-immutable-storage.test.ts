import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { toHttpHeadersLike } from '@azure/core-http-compat';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import type { IHttpClient } from '@azure/storage-blob';
import { canonicalise, signRecord } from '@haip/protocol/crypto';
import {
  collectImmutableStorage,
  runImmutableStorage,
} from '../deployment/adapters/azure-immutable-storage.mjs';
import { sha256 } from '../deployment/adapters/evidence.mjs';

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

function azureFixture() {
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

function deletion(prefixes?: string[], enabled?: boolean, target = 'baseBlob') {
  return {
    enabled,
    name: 'fixture-rule',
    type: 'Lifecycle',
    definition: {
      actions: { [target]: { delete: { daysAfterCreationGreaterThan: 30 } } },
      filters: { blobTypes: ['blockBlob'], prefixMatch: prefixes },
    },
  };
}

test('the Azure check reads exact policies and both signed versions through separate identities', async () => {
  const fixture = azureFixture();
  const result = await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options);
  assert.equal(result.passed, true, JSON.stringify(result.assertions));
  assert.equal(result.assertions.length, 7);
  assert.equal(fixture.armCalls.length, 7);
  assert.equal(fixture.blobCalls.length, 6);
  assert.deepEqual(Object.keys(result.observations.samples), ['checkpoint', 'safety']);
  assert.equal(
    result.observations.samples.checkpoint.version_digest,
    sha256(fixture.settings.checkpoint.version_id),
  );
  assert.equal(result.observations.samples.safety.legal_hold_required, true);
  assert.ok(result.observations.policy_etag_digests.safetyPolicy);
  assert.equal(result.observations.safety_policy_days, 91);
  assert.equal(result.observations.safety_container_legal_hold, true);
});

test('the Azure CLI Reader selects the reviewed subscription', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The acceptance runner uses POSIX process groups');
  const directory = await mkdtemp(join(tmpdir(), 'haip-azure-cli-'));
  const previousPath = process.env.PATH;
  try {
    const fixture = azureFixture();
    const argumentsPath = join(directory, 'arguments.json');
    await writeFile(
      join(directory, 'az'),
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args));
if (args.includes('--tenant') && args.includes('--subscription')) process.exit(2);
process.stdout.write(JSON.stringify({ accessToken: 'fixture-arm-token', expires_on: Math.floor(Date.now() / 1000) + 3600 }));
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
    const result = await collectImmutableStorage(fixture.plan, fixture.settings, {
      ...fixture.options,
      managementCredential: undefined,
    });
    assert.equal(result.passed, true);
    assert.deepEqual(JSON.parse(await readFile(argumentsPath, 'utf8')), [
      'account',
      'get-access-token',
      '--output',
      'json',
      '--resource',
      'https://management.azure.com',
      '--subscription',
      fixture.settings.subscription_id,
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('only lifecycle rules outside the safety scope or explicitly disabled pass', async () => {
  const fixture = azureFixture();
  fixture.setRules([deletion(['private-backups/']), deletion(['haip-safety'], false)]);
  assert.equal(
    (await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options)).passed,
    true,
  );
  for (const rules of [
    [deletion()],
    [deletion(['haip-'])],
    [deletion(['haip-safety/anything'], true, 'version')],
    [deletion(['haip-safety/'], true, 'snapshot')],
    [deletion([])],
    [null],
  ]) {
    fixture.setRules(rules);
    const result = await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options);
    assert.equal(result.passed, false);
    assert.equal(
      result.assertions.find((row) => row.name === 'azure_safety_lifecycle')?.passed,
      false,
    );
  }
  delete fixture.resources[fixture.lifecycle];
  for (const [status, code] of [
    [403, 'AuthorizationFailed'],
    [404, 'AuthorizationFailed'],
  ] as const) {
    fixture.lifecycleError(status, code);
    assert.equal(
      (await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options)).passed,
      false,
    );
  }
});

test('an account outside the reviewed scope and disabled versioning stop data reads', async () => {
  const fixture = azureFixture();
  fixture.resources[fixture.account].id = fixture.account + 'other';
  assert.equal(
    (await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options)).passed,
    false,
  );
  delete fixture.resources[fixture.account].id;
  fixture.resources[fixture.account].location = 'westus';
  assert.equal(
    (await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options)).passed,
    false,
  );
  fixture.resources[fixture.account].location = 'uksouth';
  fixture.resources[fixture.service].properties.isVersioningEnabled = false;
  assert.equal(
    (await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options)).passed,
    false,
  );
  assert.deepEqual(fixture.blobCalls, []);
});

test('policy and record defects prevent Azure acceptance', async () => {
  const examples: [string, (fixture: ReturnType<typeof azureFixture>) => void][] = [
    [
      'azure_safety_worm',
      (f) => {
        f.resources[f.safety].properties.hasLegalHold = false;
      },
    ],
    [
      'azure_safety_worm',
      (f) => {
        f.resources[`${f.safety}/immutabilityPolicies/default`].properties.state = 'Unlocked';
      },
    ],
    [
      'azure_safety_worm',
      (f) => {
        f.resources[
          `${f.safety}/immutabilityPolicies/default`
        ].properties.allowProtectedAppendWrites = true;
      },
    ],
    [
      'azure_checkpoint_version',
      (f) => {
        f.records.checkpoint.listedVersion = f.records.safety.version;
      },
    ],
    [
      'azure_checkpoint_version',
      (f) => {
        f.records.checkpoint.reportedVersion = f.records.safety.version;
      },
    ],
    [
      'azure_checkpoint_version',
      (f) => {
        f.records.checkpoint.extraVersion = true;
      },
    ],
    [
      'azure_checkpoint_version',
      (f) => {
        f.records.checkpoint.expiry = new Date(Date.now() + 89 * 86_400_000);
      },
    ],
    [
      'azure_safety_version',
      (f) => {
        f.records.safety.hold = false;
      },
    ],
    [
      'azure_safety_version',
      (f) => {
        f.records.safety.lock = 'unlocked';
      },
    ],
    [
      'azure_safety_version',
      (f) => {
        f.settings.safety.digest = sha256('changed content');
      },
    ],
    [
      'azure_safety_version',
      (f) => {
        f.records.safety.contents = f.sample(true, (payload) => {
          payload.key = '0'.repeat(64);
        });
        f.settings.safety.digest = sha256(f.records.safety.contents);
      },
    ],
    [
      'azure_checkpoint_version',
      (f) => {
        const record = JSON.parse(f.records.checkpoint.contents);
        record.signature = 'A'.repeat(86);
        f.records.checkpoint.contents = canonicalise(record);
        f.settings.checkpoint.digest = sha256(f.records.checkpoint.contents);
      },
    ],
  ];
  for (const [check, change] of examples) {
    const fixture = azureFixture();
    change(fixture);
    const result = await collectImmutableStorage(fixture.plan, fixture.settings, fixture.options);
    assert.equal(result.passed, false, check);
    assert.equal(result.assertions.find((row) => row.name === check)?.passed, false, check);
  }
});

test('the adapter binds private evidence to its inputs and fixtures stay blocked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haip-azure-acceptance-'));
  try {
    const fixture = azureFixture();
    const planPath = join(directory, 'plan.json');
    const settingsPath = join(directory, 'settings.json');
    const outputPath = join(directory, 'evidence');
    const planText = JSON.stringify(fixture.plan);
    const settingsText = JSON.stringify({ ...fixture.settings, plan_digest: sha256(planText) });
    await writeFile(planPath, planText);
    await writeFile(settingsPath, settingsText);
    const result = await runImmutableStorage(planPath, outputPath, settingsPath, fixture.options);
    assert.equal(result.status, 'blocked');
    assert.equal(result.facts.pinned_versions_verified, 2);
    assert.equal(result.evidence.length, 1);
    const evidence = result.evidence[0];
    const file = join(outputPath, evidence.reference.slice('private-evidence:'.length));
    const content = await readFile(file, 'utf8');
    const document = JSON.parse(content);
    assert.equal(document.evidence_kind, 'local_fixture');
    assert.equal(document.plan_digest, sha256(planText));
    assert.equal(document.settings_digest, sha256(settingsText));
    assert.equal(document.source_commit, fixture.plan.source.commit);
    assert.equal(document.service_artifact_digest, fixture.plan.deployment.service_artifact_digest);
    assert.equal(sha256(content), evidence.digest);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    for (const marker of [
      fixture.settings.account,
      fixture.settings.safety.key,
      fixture.settings.safety.version_id,
      'fixture-arm-token',
      'fixture-runtime-token',
      'private fixture marker',
    ])
      assert.equal(content.includes(marker), false);
    await writeFile(planPath, planText + '\n');
    const staleOutput = join(directory, 'stale');
    await assert.rejects(
      runImmutableStorage(planPath, staleOutput, settingsPath, fixture.options),
      /different acceptance plan/,
    );
    await assert.rejects(stat(staleOutput), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
