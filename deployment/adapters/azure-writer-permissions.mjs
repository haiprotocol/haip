import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { canonicalise } from '@haip/protocol/crypto';
import {
  listAzureVersions,
  minimumAnchorRetentionDays,
  readAzureVersion,
} from '../../haip-server/dist/anchor.js';
import { collectImmutableStorage } from './azure-immutable-storage.mjs';
import {
  armUrl,
  azureReader,
  azureRequest,
  azureToken,
  boundedJson,
  getAzureJson,
  graphOrigin,
  managementOrigin,
  matches,
  runtimeIdentity,
  sameId,
  storageTarget,
  uuid,
  uuidPattern,
} from './azure-acceptance.mjs';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';

const checkId = 'writer_permissions';
const rbacVersion = '2022-04-01';
const blobActions = ['read', 'add/action'].map(
  (action) => `microsoft.storage/storageaccounts/blobservices/containers/blobs/${action}`,
);
const providerId = '[a-zA-Z0-9_.()-]{1,90}';
const identityPath = new RegExp(
  `^/subscriptions/(${uuidPattern})/resourceGroups/${providerId}/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[a-zA-Z0-9_-]{3,128}$`,
  'i',
);
const roleId = new RegExp(
  `^(?:/subscriptions/(${uuidPattern})(?:/resourceGroups/${providerId})?)?/providers/Microsoft\\.Authorization/roleDefinitions/${uuidPattern}$`,
  'i',
);
const blobDenied = new Set(['AuthorizationPermissionMismatch']);
const policyDenied = new Set(['BlobImmutableDueToPolicy', 'BlobImmutableDueToLegalHold']);
const armDenied = new Set(['AuthorizationFailed', 'DenyAssignmentAuthorizationFailed']);

async function selectPrincipal(settings, readerToken, runtime, request) {
  if (settings.runtime_credential === 'client_secret') {
    const token = await azureToken(runtime, graphOrigin);
    const url = new URL(
      `${graphOrigin}/v1.0/servicePrincipals(appId='${settings.runtime_client_id}')`,
    );
    url.searchParams.set('$select', 'id,appId,appOwnerOrganizationId,accountEnabled');
    const view = await getAzureJson(url, token, request);
    if (
      sameId(view?.appId, settings.runtime_client_id) &&
      sameId(view.appOwnerOrganizationId, settings.tenant_id) &&
      view.accountEnabled === true &&
      matches(uuid, view.id)
    )
      return view.id;
  } else {
    const id = settings.runtime_identity_resource_id;
    if (
      !matches(identityPath, id) ||
      !sameId(identityPath.exec(id)[1], settings.subscription_id) ||
      id.split('/')[4].endsWith('.')
    )
      throw new Error('Invalid runtime identity resource');
    const result = await getAzureJson(armUrl(id, '2023-01-31'), readerToken, request);
    const view = result?.properties;
    if (
      sameId(result?.id, id) &&
      sameId(view?.clientId, settings.runtime_client_id) &&
      sameId(view.tenantId, settings.tenant_id) &&
      matches(uuid, view.principalId)
    )
      return view.principalId;
  }
  throw new Error('The runtime principal could not be bound to the reviewed identity');
}

async function scopedAssignments(scope, principal, token, request) {
  const prefix = `${scope}/providers/Microsoft.Authorization/roleAssignments`;
  const url = armUrl(prefix, rbacVersion);
  const filter = `atScope() and assignedTo('${principal}')`;
  url.searchParams.set('$filter', filter);
  const assigned = [];
  let next = url;
  for (let page = 0; page < 32; page++) {
    const body = await getAzureJson(next, token, request);
    if (!Array.isArray(body?.value) || assigned.length + body.value.length > 512)
      throw new Error('Azure assignment response exceeds the audit bounds');
    assigned.push(...body.value);
    if (!body.nextLink) return assigned;
    next = new URL(body.nextLink);
    const nextFilter = next.searchParams.get('$filter');
    const skip = [...next.searchParams].find(([key]) => key.toLowerCase() === '$skiptoken')?.[1];
    if (
      next.origin !== managementOrigin ||
      !sameId(next.pathname, prefix) ||
      next.searchParams.get('api-version') !== rbacVersion ||
      (nextFilter !== null && nextFilter !== filter) ||
      !skip
    )
      throw new Error('Unexpected Azure assignment continuation');
  }
  throw new Error('Azure role audit has too many pages');
}

async function inspectRoles(target, principal, subscription, token, request) {
  const definitions = new Map();
  async function inspect(scope) {
    const assignments = await scopedAssignments(scope, principal, token, request);
    const allowed = new Set();
    const evidence = [];
    for (const row of assignments) {
      const grant = row?.properties;
      const id = grant?.roleDefinitionId;
      const assignmentId = row?.id;
      if (
        !sameId(grant?.scope, scope) ||
        !matches(roleId, id) ||
        (roleId.exec(id)[1] && !sameId(roleId.exec(id)[1], subscription)) ||
        !matches(uuid, grant.principalId) ||
        (grant.principalType !== 'Group' && !sameId(grant.principalId, principal)) ||
        typeof assignmentId !== 'string' ||
        !sameId(
          assignmentId.slice(0, assignmentId.lastIndexOf('/')),
          `${scope}/providers/Microsoft.Authorization/roleAssignments`,
        ) ||
        !matches(uuid, assignmentId.slice(assignmentId.lastIndexOf('/') + 1))
      )
        throw new Error('An effective assignment falls outside the two evidence containers');
      const key = id.toLowerCase();
      if (!definitions.has(key))
        definitions.set(key, getAzureJson(armUrl(id, rbacVersion), token, request));
      const definition = await definitions.get(key);
      const permissions = definition?.properties?.permissions;
      if (!sameId(definition?.id, id) || !Array.isArray(permissions) || !permissions.length)
        throw new Error('An effective role definition is unavailable');
      for (const permission of permissions) {
        if (
          !Array.isArray(permission?.actions) ||
          permission.actions.length ||
          !Array.isArray(permission.dataActions) ||
          !permission.dataActions.every(
            (action) => typeof action === 'string' && blobActions.includes(action.toLowerCase()),
          )
        )
          throw new Error('The runtime role permits management or extra data actions');
        for (const action of permission.dataActions) allowed.add(action.toLowerCase());
      }
      evidence.push(sha256(canonicalise({ id: assignmentId, grant, definition: permissions })));
    }
    if (!blobActions.every((action) => allowed.has(action)))
      throw new Error('The scoped roles lack the required add or read action');
    return { scope_digest: sha256(scope), assignment_digests: evidence.sort() };
  }
  return Promise.all([inspect(target.checkpointId), inspect(target.safetyId)]);
}

function codedError(error) {
  return {
    status: Number.isSafeInteger(error?.statusCode) ? error.statusCode : null,
    code: matches(/^[A-Za-z0-9_]{1,80}$/, error?.code) ? error.code : null,
  };
}

async function blobOutcome(operation) {
  try {
    const result = await operation();
    const status = result?._response?.status;
    return { status: Number.isSafeInteger(status) ? status : null, code: null, accepted: true };
  } catch (error) {
    return codedError(error);
  }
}

async function managementOutcome(url, token, request, init) {
  try {
    const response = await azureRequest(url, token, request, init);
    if (response.status !== 403) {
      await response.body?.cancel();
      return { status: response.status, code: null };
    }
    const body = await boundedJson(response);
    return {
      status: response.status,
      code: matches(/^[A-Za-z0-9_]{1,80}$/, body?.error?.code) ? body.error.code : null,
    };
  } catch {
    return { status: null, code: null };
  }
}

const dataRefused = ({ status, code }) =>
  (status === 403 && blobDenied.has(code)) || (status === 409 && policyDenied.has(code));

async function probeCanary(storage, containerName, key, contents, permanent, record, observe) {
  const container = storage.getContainerClient(containerName);
  const writer = container.getBlockBlobClient(key);
  const abortSignal = AbortSignal.timeout(45_000);
  const minimumExpiry = Date.now() + minimumAnchorRetentionDays * 86_400_000;
  const create = () =>
    writer.upload(contents, Buffer.byteLength(contents), {
      abortSignal,
      conditions: { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });
  const uploaded = await create();
  if (!uploaded.versionId || !uploaded.etag)
    throw new Error('Canary creation did not return its version and ETag');
  record.version_digest = sha256(uploaded.versionId);
  const exact = writer.withVersion(uploaded.versionId);
  const label = permanent ? 'safety' : 'checkpoint';
  async function read() {
    const [listed] = await listAzureVersions(container, key, { maxVersions: 1, abortSignal });
    if (listed?.name !== key || listed.versionId !== uploaded.versionId)
      throw new Error('Canary version differed');
    const result = await readAzureVersion(
      container,
      key,
      uploaded.versionId,
      permanent,
      abortSignal,
    );
    if (result.body !== contents || !(result.retainedUntil.getTime() >= minimumExpiry))
      throw new Error('Canary data or retention differed');
    record.retained_until = result.retainedUntil.toISOString();
  }
  await read();
  observe(
    `${label}_create_read`,
    true,
    'The runtime conditionally created, listed and read the exact retained canary version.',
  );
  const duplicate = await blobOutcome(create);
  if (
    !observe(
      `${label}_duplicate`,
      (duplicate.status === 412 && duplicate.code === 'ConditionNotMet') ||
        (duplicate.status === 409 && duplicate.code === 'BlobAlreadyExists'),
      'A repeat of the conditional create was refused.',
      duplicate,
    )
  )
    return false;
  const overwrite = await blobOutcome(() =>
    writer.upload(`${contents}\n`, Buffer.byteLength(contents) + 1, {
      abortSignal,
      conditions: { ifMatch: uploaded.etag },
    }),
  );
  if (
    !observe(
      `${label}_overwrite`,
      dataRefused(overwrite),
      'Azure refused replacement of the versioned canary.',
      overwrite,
    )
  )
    return false;
  const deletion = await blobOutcome(() =>
    exact.delete({ abortSignal, conditions: { ifMatch: uploaded.etag } }),
  );
  if (
    !observe(
      `${label}_deletion`,
      dataRefused(deletion),
      'Azure refused deletion of the exact canary version.',
      deletion,
    )
  )
    return false;
  if (!permanent) {
    const hold = await blobOutcome(() => exact.setLegalHold(false, { abortSignal }));
    if (
      !observe(
        'blob_hold_clear',
        dataRefused(hold),
        'Azure refused the blob legal-hold operation on the checkpoint canary.',
        hold,
      )
    )
      return false;
    const retention = await blobOutcome(() => exact.deleteImmutabilityPolicy({ abortSignal }));
    if (
      !observe(
        'blob_retention_delete',
        dataRefused(retention),
        'Azure refused removal of the checkpoint canary retention policy.',
        retention,
      )
    )
      return false;
  }
  await read();
  return observe(
    `${label}_preserved`,
    true,
    'The original version and content remained readable after the denials.',
  );
}

export async function collectWriterPermissions(
  plan,
  settings,
  { managementCredential, runtimeCredential, request = fetch, blobHttpClient } = {},
) {
  const target = storageTarget(plan, settings);
  if (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    plan.deployment.independent_administration_asserted !== true ||
    !matches(uuid, settings.writer_probe_id)
  )
    throw new Error(
      'The writer probe requires verified TLS and an approved isolated acceptance plan',
    );
  const runtime = runtimeCredential ?? runtimeIdentity(settings, process.env);
  const assertions = [],
    attempts = {},
    canaries = {};
  const observe = (name, passed, detail, response) => {
    assertions.push({ name, passed, detail });
    if (response) attempts[name] = response;
    return passed;
  };
  let stage = 'policy_reader';
  let principal;
  let assignments;
  try {
    const token = await azureToken(managementCredential ?? azureReader(settings), managementOrigin);
    stage = 'runtime_principal';
    principal = await selectPrincipal(settings, token, runtime, request);
    observe(
      stage,
      true,
      'Azure resolved the runtime client to the local principal used in the role queries.',
    );
    stage = 'effective_roles';
    assignments = await inspectRoles(target, principal, settings.subscription_id, token, request);
    observe(
      stage,
      true,
      'Effective assignments include only the scoped add and read data actions.',
    );
    stage = 'immutable_preflight';
    const preflight = await collectImmutableStorage(plan, settings, {
      managementCredential: {
        async getToken() {
          return { token };
        },
      },
      runtimeCredential: runtime,
      request,
      blobHttpClient,
    });
    if (!preflight.passed) throw new Error('Storage protection preflight failed');
    observe(
      stage,
      true,
      'Both scoped storage policies and original signed records passed before canary creation.',
    );
    stage = 'management_probe_scope';
    const safety = await getAzureJson(armUrl(target.safetyId), token, request);
    const tags = safety.properties?.legalHold?.tags;
    if (
      !sameId(safety.id, target.safetyId) ||
      safety.properties?.hasLegalHold !== true ||
      !Array.isArray(tags) ||
      !tags.length ||
      tags.some((item) => !matches(/^[a-z0-9]{3,23}$/i, item?.tag))
    )
      throw new Error('Azure did not return the current safety hold tags');
    const absentTag = `haip${randomBytes(9).toString('hex')}`;
    if (tags.some((item) => sameId(item.tag, absentTag)))
      throw new Error('Canary hold tag already exists');
    const runtimeArm = await azureToken(runtime, managementOrigin);
    const probeKey = `haip-acceptance/writer-probes/${settings.writer_probe_id.toLowerCase()}.json`;
    const contents = canonicalise({
      check: checkId,
      probe: settings.writer_probe_id.toLowerCase(),
    });
    const storage = new BlobServiceClient(target.origin, runtime, {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 10_000 },
      httpClient: blobHttpClient,
    });
    let blobChecks = true;
    for (const [name, permanent] of [
      ['checkpoint', false],
      ['safety', true],
    ]) {
      stage = `${name}_canary`;
      const record = { key_digest: sha256(probeKey), content_digest: sha256(contents) };
      canaries[name] = record;
      blobChecks = await probeCanary(
        storage,
        settings[name].container,
        probeKey,
        contents,
        permanent,
        record,
        observe,
      );
      if (!blobChecks) break;
    }
    if (blobChecks) {
      stage = 'management_probes';
      const unusedEtag = `"haip-${randomBytes(12).toString('hex')}"`;
      const probes = [
        ['account_keys', `${target.accountId}/listKeys`, { method: 'POST' }],
        [
          'account_update',
          target.accountId,
          {
            method: 'PATCH',
            body: { properties: { allowSharedKeyAccess: false, allowBlobPublicAccess: false } },
          },
        ],
        [
          'container_update',
          target.safetyId,
          { method: 'PATCH', body: { properties: { publicAccess: 'None' } } },
        ],
        [
          'container_hold_clear',
          `${target.safetyId}/clearLegalHold`,
          { method: 'POST', body: { tags: [absentTag] } },
        ],
        [
          'container_retention_extend',
          `${target.safetyId}/immutabilityPolicies/default/extend`,
          {
            method: 'POST',
            headers: { 'If-Match': unusedEtag },
            body: {
              properties: {
                immutabilityPeriodSinceCreationInDays: preflight.observations.safety_policy_days,
              },
            },
          },
        ],
      ];
      for (const [name, id, init] of probes) {
        const result = await managementOutcome(armUrl(id), runtimeArm, request, init);
        if (
          !observe(
            name,
            result.status === 403 && armDenied.has(result.code),
            'Azure Resource Manager returned an explicit authorisation denial.',
            result,
          )
        )
          break;
      }
      if (assertions.every((item) => item.passed)) {
        stage = 'roles_after_probes';
        const finalRoles = await inspectRoles(
          target,
          principal,
          settings.subscription_id,
          token,
          request,
        );
        observe(
          stage,
          canonicalise(finalRoles) === canonicalise(assignments),
          'The effective role and assignment digests agree before and after the probes.',
        );
      }
    }
  } catch {
    observe(stage, false, 'The writer probe could not establish this required observation.');
  }
  return {
    assertions,
    passed: assertions.length > 0 && assertions.every((item) => item.passed),
    observations: {
      recorded_at: new Date().toISOString(),
      account_digest: sha256(target.accountId),
      principal_digest: principal ? sha256(principal) : null,
      anchor_revision: target.component.revision,
      assignments: assignments ?? null,
      attempts,
      canaries,
    },
  };
}

export async function runWriterPermissions(planPath, directoryPath, settingsPath, options) {
  const [{ plan, digest }, { document: settings, bytes }] = await Promise.all([
    readAcceptancePlan(planPath),
    readJsonDocument(settingsPath),
  ]);
  if (settings?.plan_digest !== digest)
    throw new Error('Writer settings refer to a different acceptance plan');
  const directory = await privateDirectory(directoryPath);
  const result = await collectWriterPermissions(plan, settings, options);
  const fixture = options !== undefined;
  const evidence = await privateEvidence(directory, 'azure-writer', checkId, {
    format: 'haip.azure-writer.v1',
    evidence_kind: fixture ? 'local_fixture' : 'live_azure_probes',
    source_commit: plan.source.commit,
    service_artifact_digest: plan.deployment.service_artifact_digest,
    configuration_revision: plan.deployment.configuration_revision,
    plan_digest: digest,
    settings_digest: sha256(bytes),
    ...result.observations,
    assertions: result.assertions,
  });
  return {
    status: !result.passed ? 'failed' : fixture ? 'blocked' : 'passed',
    summary: !result.passed
      ? 'One or more Azure writer checks failed.'
      : fixture
        ? 'The local writer fixture passed. Live Azure evidence remains pending.'
        : 'The scoped writer and the Azure denial probes passed.',
    assertions: result.assertions,
    evidence: [evidence],
    facts: {
      canaries_recorded: Object.values(result.observations.canaries).filter(
        (item) => item.version_digest,
      ).length,
    },
  };
}

async function main() {
  const [plan, directory, settings, ...rest] = process.argv.slice(2);
  if (
    !plan ||
    !directory ||
    !settings ||
    rest.length ||
    (process.env.HAIP_ACCEPTANCE_CHECK_ID && process.env.HAIP_ACCEPTANCE_CHECK_ID !== checkId)
  )
    throw new Error('Supply a writer plan, private evidence directory and storage settings');
  console.log(JSON.stringify(await runWriterPermissions(plan, directory, settings)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.log(
      JSON.stringify({
        status: 'failed',
        summary: 'The Azure writer adapter could not start.',
        assertions: [
          {
            name: 'adapter_completed',
            passed: false,
            detail: 'Check the approved plan, private directory and scoped Azure credentials.',
          },
        ],
        evidence: [],
        facts: {},
      }),
    );
  });
}
