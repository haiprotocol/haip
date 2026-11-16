import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { parseJson, verifyRecord } from '@haip/protocol/crypto';
import {
  listAzureVersions,
  minimumAnchorRetention,
  minimumAnchorRetentionDays,
  readAzureVersion,
} from '../../haip-server/dist/anchor.js';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';
import {
  armUrl,
  azureReader,
  azureRequest,
  azureToken,
  boundedJson,
  managementOrigin,
  matches,
  regionName,
  runtimeIdentity,
  sameId,
  storageTarget,
  storageVersion,
  uuidPattern,
} from './azure-acceptance.mjs';

const checkId = 'immutable_storage';
const checkpointPath = new RegExp(`^(${uuidPattern})/(${uuidPattern})/([0-9]{16})\\.json$`);
const safetyPath = /^safety\/([a-f0-9]{64})\.json$/;
const digest = /^sha256:[a-f0-9]{64}$/;

function settingsFor(plan, settings) {
  const deployment = plan.deployment;
  const target = storageTarget(plan, settings);
  const { anchor_prefix, trust_manifest } = settings;
  const { checkpoint, safety } = settings;
  if (
    trust_manifest?.issuer !== deployment.trusted_origin ||
    trust_manifest?.protocol_revision !== deployment.protocol_revision ||
    !Array.isArray(trust_manifest?.keys) ||
    trust_manifest.keys.length < 1 ||
    trust_manifest.keys.length > 128
  )
    throw new Error('Invalid Azure storage acceptance settings');
  for (const [sample, path] of [
    [checkpoint, checkpointPath],
    [safety, safetyPath],
  ]) {
    if (
      typeof sample.key !== 'string' ||
      !sample.key.startsWith(`${anchor_prefix}/`) ||
      !matches(path, sample.key.slice(anchor_prefix.length + 1)) ||
      !matches(/^[a-zA-Z0-9:._-]{1,160}$/, sample.version_id) ||
      !matches(digest, sample.digest)
    )
      throw new Error('Invalid exact version sample');
  }
  return target;
}

async function managementResponse(id, token, request) {
  try {
    const response = await azureRequest(armUrl(id), token, request);
    if (response.status !== 200 && response.status !== 404) {
      await response.body?.cancel();
      return { status: response.status };
    }
    const body = await boundedJson(response);
    const bound = response.status === 200 && sameId(body?.id, id);
    const etag = response.headers.get('etag') ?? body?.etag;
    return {
      status: response.status,
      properties: bound ? body.properties : undefined,
      location: bound ? body.location : undefined,
      etagDigest: bound && typeof etag === 'string' ? sha256(etag) : undefined,
      absent:
        response.status === 404 &&
        ['ManagementPolicyNotFound', 'ResourceNotFound'].includes(body?.error?.code),
    };
  } catch {
    return { status: null };
  }
}

function lockedPolicy(policy) {
  return (
    policy?.state === 'Locked' &&
    policyDays(policy) >= minimumAnchorRetentionDays &&
    (policy.allowProtectedAppendWrites === undefined ||
      policy.allowProtectedAppendWrites === false) &&
    (policy.allowProtectedAppendWritesAll === undefined ||
      policy.allowProtectedAppendWritesAll === false)
  );
}

function policyDays(policy) {
  const days = policy?.immutabilityPeriodSinceCreationInDays;
  return Number.isSafeInteger(days) ? days : null;
}

function safeLifecycle(response, container) {
  if (response.absent) return true;
  const rules = response.properties?.policy?.rules;
  if (!Array.isArray(rules)) return false;
  const containerPath = `${container}/`;
  return rules.every((rule) => {
    if (rule?.enabled === false) return true;
    const { actions, filters } = rule?.definition ?? {};
    if (
      rule?.type !== 'Lifecycle' ||
      !actions ||
      Array.isArray(actions) ||
      typeof actions !== 'object'
    )
      return false;
    const groups = Object.values(actions);
    if (
      !groups.length ||
      groups.some((group) => !group || Array.isArray(group) || typeof group !== 'object')
    )
      return false;
    if (!groups.some((group) => Object.hasOwn(group, 'delete'))) return true;
    const prefixes = filters?.prefixMatch;
    return (
      Array.isArray(prefixes) &&
      prefixes.length > 0 &&
      prefixes.every(
        (prefix) =>
          typeof prefix === 'string' &&
          !prefix.startsWith(containerPath) &&
          !containerPath.startsWith(prefix),
      )
    );
  });
}

async function inspectVersion(storage, sample, settings, permanent, now) {
  const signal = AbortSignal.timeout(30_000);
  const container = storage.getContainerClient(sample.container);
  const [version] = await listAzureVersions(container, sample.key, {
    maxVersions: 1,
    abortSignal: signal,
  });
  if (version?.name !== sample.key || version.versionId !== sample.version_id)
    throw new Error('Unexpected current version');
  const actual = await readAzureVersion(
    container,
    sample.key,
    sample.version_id,
    permanent,
    signal,
  );
  if (sha256(actual.body) !== sample.digest) throw new Error('Stored content digest differs');
  const record = parseJson(actual.body);
  const key = sample.key.slice(settings.anchor_prefix.length + 1);
  const [, tenant, generation, sequence] = (permanent ? safetyPath : checkpointPath).exec(key);
  verifyRecord(
    record,
    settings.trust_manifest,
    {
      issuer: settings.trust_manifest.issuer,
      audience: permanent ? 'haip.recovery' : 'haip.audit',
      type: permanent ? 'RecoveryFence' : 'AuditCheckpoint',
      purpose: 'service',
      tenant,
    },
    now,
  );
  const payload = record.payload;
  const bound = permanent
    ? payload?.key === tenant && Object.hasOwn(payload, 'value')
    : payload?.ledger_id === tenant &&
      payload.generation === generation &&
      Number.isSafeInteger(payload.sequence) &&
      payload.sequence > 0 &&
      String(payload.sequence).padStart(16, '0') === sequence &&
      matches(digest, payload.head);
  const expiry = actual.retainedUntil.getTime();
  if (!bound || !(expiry >= minimumAnchorRetention(record) && expiry > now.getTime()))
    throw new Error('Stored record binding or retention differs');
  return {
    key_digest: sha256(sample.key),
    version_digest: sha256(sample.version_id),
    content_digest: sample.digest,
    issued_at: record.protected.issued_at,
    retained_until: actual.retainedUntil.toISOString(),
    legal_hold_required: permanent,
  };
}

export async function collectImmutableStorage(
  plan,
  settings,
  { managementCredential, runtimeCredential, request = fetch, blobHttpClient } = {},
) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('TLS verification is required');
  const now = new Date();
  const { accountId, origin, component, serviceId, checkpointId, safetyId } = settingsFor(
    plan,
    settings,
  );
  const { checkpoint, safety } = settings;
  const storage = new BlobServiceClient(
    origin,
    runtimeCredential ?? runtimeIdentity(settings, process.env),
    {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 10_000 },
      httpClient: blobHttpClient,
    },
  );
  const token = await azureToken(managementCredential ?? azureReader(settings), managementOrigin);
  const paths = {
    account: accountId,
    service: serviceId,
    checkpoint: checkpointId,
    safety: safetyId,
    checkpointPolicy: `${checkpointId}/immutabilityPolicies/default`,
    safetyPolicy: `${safetyId}/immutabilityPolicies/default`,
    lifecycle: `${accountId}/managementPolicies/default`,
  };
  const responses = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, id]) => [
        name,
        await managementResponse(id, token, request),
      ]),
    ),
  );
  const assertions = [];
  const assert = (name, condition, detail) => {
    const passed = Boolean(condition);
    assertions.push({ name, passed, detail });
    return passed;
  };
  const account = responses.account.properties;
  const endpoint = account?.primaryEndpoints?.blob;
  const accountMatches = assert(
    'azure_storage_account',
    (endpoint === origin || endpoint === `${origin}/`) &&
      regionName(responses.account.location) === regionName(component.region) &&
      account.allowSharedKeyAccess === false &&
      account.allowBlobPublicAccess === false &&
      account.supportsHttpsTrafficOnly === true,
    'The exact storage account in the configured region requires HTTPS and disables shared keys and public blobs.',
  );
  const versioning = assert(
    'azure_blob_versioning',
    responses.service.properties?.isVersioningEnabled === true,
    'The account has blob versioning enabled.',
  );
  assert(
    'azure_checkpoint_worm',
    responses.checkpoint.properties?.immutableStorageWithVersioning?.enabled === true &&
      responses.checkpoint.properties?.hasLegalHold !== true &&
      lockedPolicy(responses.checkpointPolicy.properties),
    'The checkpoint container has a locked default version policy without protected append writes.',
  );
  const safetyProperties = responses.safety.properties;
  assert(
    'azure_safety_worm',
    safetyProperties?.hasLegalHold === true &&
      safetyProperties.immutableStorageWithVersioning?.enabled !== true &&
      lockedPolicy(responses.safetyPolicy.properties),
    'The safety container has a locked container policy and a legal hold without protected append writes.',
  );
  assert(
    'azure_safety_lifecycle',
    safeLifecycle(responses.lifecycle, safety.container),
    'The account lifecycle policy has no enabled deletion rule that can cover the safety container.',
  );

  const samples = {};
  if (accountMatches && versioning) {
    const records = await Promise.allSettled([
      inspectVersion(storage, checkpoint, settings, false, now),
      inspectVersion(storage, safety, settings, true, now),
    ]);
    for (const [index, name] of ['checkpoint', 'safety'].entries()) {
      const result = records[index];
      assert(
        `azure_${name}_version`,
        result.status === 'fulfilled',
        name === 'checkpoint'
          ? 'The checkpoint signature, digest, listed version and retention match the pinned sample.'
          : 'The safety signature, digest, listed version, retention and legal hold match the pinned sample.',
      );
      if (result.status === 'fulfilled') samples[name] = result.value;
    }
  }
  return {
    assertions,
    passed: assertions.every((check) => check.passed),
    observations: {
      recorded_at: new Date().toISOString(),
      account_digest: sha256(accountId),
      runtime_client_digest: sha256(settings.runtime_client_id),
      anchor_revision: component.revision,
      storage_api_version: storageVersion,
      checkpoint_policy_days: policyDays(responses.checkpointPolicy.properties),
      safety_policy_days: policyDays(responses.safetyPolicy.properties),
      safety_container_legal_hold: safetyProperties?.hasLegalHold === true,
      management_status: Object.fromEntries(
        Object.entries(responses).map(([name, response]) => [name, response.status]),
      ),
      policy_etag_digests: Object.fromEntries(
        ['checkpointPolicy', 'safetyPolicy', 'lifecycle'].map((name) => [
          name,
          responses[name].etagDigest ?? null,
        ]),
      ),
      samples,
    },
  };
}

export async function runImmutableStorage(planPath, evidencePath, settingsPath, options) {
  const [{ plan, digest: planDigest }, { bytes: settingsBytes, document: settings }] =
    await Promise.all([readAcceptancePlan(planPath), readJsonDocument(settingsPath)]);
  if (settings.plan_digest !== planDigest)
    throw new Error('Storage settings refer to a different acceptance plan');
  const directory = await privateDirectory(evidencePath);
  const result = await collectImmutableStorage(plan, settings, options);
  const fixture = options !== undefined;
  const evidence = await privateEvidence(directory, 'azure-storage', 'azure-immutable-storage', {
    format: 'haip.azure-immutable-storage.v1',
    evidence_kind: fixture ? 'local_fixture' : 'live_azure_reads',
    source_commit: plan.source.commit,
    service_artifact_digest: plan.deployment.service_artifact_digest,
    configuration_revision: plan.deployment.configuration_revision,
    plan_digest: planDigest,
    settings_digest: sha256(settingsBytes),
    ...result.observations,
    assertions: result.assertions,
  });
  return {
    status: !result.passed ? 'failed' : fixture ? 'blocked' : 'passed',
    summary: !result.passed
      ? 'One or more Azure storage probes failed.'
      : fixture
        ? 'The local storage fixture passed. Live Azure evidence remains pending.'
        : 'The Azure policy and both pinned versions passed.',
    assertions: result.assertions,
    evidence: [evidence],
    facts: { pinned_versions_verified: Object.keys(result.observations.samples).length },
  };
}

async function main() {
  const [planPath, evidencePath, settingsPath, ...rest] = process.argv.slice(2);
  if (
    !planPath ||
    !evidencePath ||
    !settingsPath ||
    rest.length ||
    (process.env.HAIP_ACCEPTANCE_CHECK_ID && process.env.HAIP_ACCEPTANCE_CHECK_ID !== checkId)
  )
    throw new Error(
      'Supply an immutable storage plan, private evidence directory and storage settings',
    );
  console.log(JSON.stringify(await runImmutableStorage(planPath, evidencePath, settingsPath)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.log(
      JSON.stringify({
        status: 'failed',
        summary: 'The Azure immutable storage adapter could not complete its probes.',
        assertions: [
          {
            name: 'adapter_completed',
            passed: false,
            detail: 'Check the plan, private directory and scoped Azure credentials.',
          },
        ],
        evidence: [],
        facts: {},
      }),
    );
  });
}
