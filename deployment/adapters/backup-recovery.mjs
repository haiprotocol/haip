import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { digest, digestBytes, verifyRecord } from '@haip/protocol/crypto';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';
import { stageExactFile, stageServerPackage } from './recovery-artifact.mjs';
import { storageTarget } from './azure-acceptance.mjs';

const execute = promisify(execFile);
const checkId = 'backup_recovery';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^sha256:[a-f0-9]{64}$/;
const window = 120_000;
const runtimeVariables = [
  'PATH',
  'HAIP_DATABASE_CA_FILE',
  'HAIP_BACKUP_KEY_FILE',
  'HAIP_PG_BIN',
  'HAIP_SIGNING_KEY_FILE',
  'HAIP_SIGNING_KEY_ID',
  'HAIP_TRUST_MANIFEST_FILE',
  'HAIP_OIDC_ISSUER',
  'HAIP_OIDC_CLIENT_ID',
  'HAIP_OIDC_CLIENT_SECRET',
  'HAIP_OIDC_DISCOVERY',
  'HAIP_OIDC_CLIENT_AUTH',
  'HAIP_AZURE_ACCOUNT_URL',
  'HAIP_AZURE_CONTAINER',
  'HAIP_AZURE_SAFETY_CONTAINER',
  'HAIP_ANCHOR_PREFIX',
  'IDENTITY_ENDPOINT',
  'IDENTITY_HEADER',
  'MSI_ENDPOINT',
  'MSI_SECRET',
];

function requireCheck(condition) {
  if (!condition) throw new Error('Recovery observation did not match the plan');
}

function validatedSettings(plan, planDigest, settings) {
  requireCheck(settings?.plan_digest === planDigest);
  requireCheck(
    [settings.server_archive, settings.node_modules, settings.backup].every(
      (value) => typeof value === 'string' && isAbsolute(value),
    ),
  );
  requireCheck(
    sha.test(settings.backup_digest) && sha.test(plan.deployment.service_artifact_digest),
  );
  requireCheck(
    [settings.generation, settings.ledger_id, settings.request_id].every(
      (id) => typeof id === 'string' && uuid.test(id),
    ),
  );
  requireCheck(
    typeof settings.tenant === 'string' && /^[A-Za-z0-9_.:@/-]{1,160}$/.test(settings.tenant),
  );
  requireCheck(
    typeof settings.target_database === 'string' &&
      settings.target_database.length > 0 &&
      settings.target_database.length <= 63,
  );
}

async function storageEnvironment(plan, planDigest, settings, environment) {
  requireCheck(
    typeof settings.storage_settings === 'string' && isAbsolute(settings.storage_settings),
  );
  const { bytes, document: storage } = await readJsonDocument(settings.storage_settings);
  requireCheck(
    storage.plan_digest === planDigest && sha256(bytes) === settings.storage_settings_digest,
  );
  const target = storageTarget(plan, storage);
  const credential = storage.runtime_credential;
  const secret = environment.HAIP_ACCEPTANCE_AZURE_RUNTIME_CLIENT_SECRET;
  if (credential === 'client_secret') requireCheck(typeof secret === 'string' && secret.length > 0);
  return {
    HAIP_AZURE_ACCOUNT_URL: target.origin,
    HAIP_AZURE_CONTAINER: storage.checkpoint.container,
    HAIP_AZURE_SAFETY_CONTAINER: storage.safety.container,
    HAIP_ANCHOR_PREFIX: storage.anchor_prefix,
    AZURE_CLIENT_ID: storage.runtime_client_id,
    AZURE_TENANT_ID: storage.tenant_id,
    AZURE_TOKEN_CREDENTIALS:
      credential === 'managed_identity' ? 'ManagedIdentityCredential' : 'EnvironmentCredential',
    ...(credential === 'client_secret' ? { AZURE_CLIENT_SECRET: secret } : {}),
  };
}

async function databaseCanary(store, settings) {
  const { rows: tenants } = await store.pool.query(
    'SELECT id,ledger_id,generation,fenced FROM haip_tenants LIMIT 2',
  );
  requireCheck(
    tenants.length === 1 &&
      tenants[0].id === settings.tenant &&
      tenants[0].ledger_id === settings.ledger_id &&
      tenants[0].fenced,
  );
  const {
    rows: [request],
  } = await store.pool.query(
    'SELECT producer,data,material IS NOT NULL AS has_material FROM haip_requests WHERE tenant=$1 AND id=$2',
    [settings.tenant, settings.request_id],
  );
  requireCheck(request);
  return { tenant: tenants[0], request };
}

function verifyCanary(before, settings, trust, issuer) {
  const { request, tenant } = before;
  const data = request.data;
  requireCheck(tenant.generation === settings.generation && request.has_material);
  requireCheck(
    data.request.id === settings.request_id &&
      data.request.tenant === settings.tenant &&
      data.request.producer === request.producer &&
      data.request.authority_namespace === settings.generation &&
      data.request.purpose === 'authorise_execution' &&
      data.request.metadata?.haip_acceptance_fixture === checkId &&
      data.grant_state === 'available' &&
      data.audit_state === 'anchored' &&
      digest(data.request) === data.request_digest &&
      data.receipt?.payload?.request_digest === data.request_digest &&
      data.receipt.payload.decision === 'authorise' &&
      data.receipt.payload.request_id === settings.request_id &&
      data.receipt.payload.purpose === 'authorise_execution',
  );
  verifyRecord(data.receipt, trust, {
    issuer,
    tenant: settings.tenant,
    audience: request.producer,
    purpose: 'authorise_execution',
    type: 'DecisionReceipt',
  });
  return digest(data.receipt);
}

async function verifyRecovered(store, settings, recovery, receiptDigest, operator, token) {
  requireCheck(
    recovery.tenant === settings.tenant &&
      recovery.retired_generation === settings.generation &&
      uuid.test(recovery.generation) &&
      recovery.generation !== settings.generation &&
      recovery.history_state === 'matching_retained_prefix' &&
      recovery.admission === 'fenced_until_startup_and_fresh_provisioning',
  );
  const { tenant, request } = await databaseCanary(store, settings);
  requireCheck(
    tenant.generation === recovery.generation &&
      !request.has_material &&
      request.data.material_deleted === true &&
      request.data.invalidated === 'namespace_retired' &&
      request.data.grant_state === 'revoked' &&
      request.data.execution_state === 'uncertain' &&
      !request.data.candidate &&
      !request.data.review_claim &&
      digest(request.data.receipt) === receiptDigest,
  );
  const { rows: principals } = await store.pool.query(
    "SELECT id,kind,token_hash FROM haip_principals WHERE tenant=$1 AND (token_hash IS NOT NULL OR config->'enabled'='true'::jsonb) LIMIT 2",
    [settings.tenant],
  );
  requireCheck(
    principals.length === 1 &&
      principals[0].id === operator &&
      principals[0].kind === 'operator' &&
      principals[0].token_hash === digestBytes(token),
  );
  const { rowCount } = await store.pool.query(
    `SELECT 1 FROM haip_outbox WHERE tenant=$1 AND
       (state='pending' OR (kind='smtp' AND (body<>'{}'::jsonb OR destination IS NOT NULL OR accepted IS NOT NULL OR claim_until IS NOT NULL))) LIMIT 1`,
    [settings.tenant],
  );
  requireCheck(!rowCount);
  const { rows: recorded } = await store.pool.query(
    'SELECT new_generation,history_state FROM haip_recoveries WHERE tenant=$1 AND old_generation=$2',
    [settings.tenant, settings.generation],
  );
  requireCheck(
    recorded.length === 1 &&
      recorded[0].new_generation === recovery.generation &&
      recorded[0].history_state === recovery.history_state,
  );
}

export async function collectBackupRecovery(
  planPath,
  evidenceDirectory,
  settingsPath,
  { environment = process.env, fixture } = {},
) {
  const { plan, digest: planDigest } = await readAcceptancePlan(planPath);
  const { bytes, document: settings } = await readJsonDocument(settingsPath);
  const directory = await privateDirectory(evidenceDirectory);
  const scope = fixture ? 'local_fixture' : 'isolated_deployment';
  const assertions = [];
  const facts = { scope };
  let stage = 'settings';
  let status = 'failed';
  let scratch, store;
  const passed = (name, detail) => assertions.push({ name, passed: true, detail });
  try {
    validatedSettings(plan, planDigest, settings);
    if (!fixture && plan.deployment.independent_administration_asserted !== true) {
      return {
        status: 'blocked',
        summary: 'The recovery drill needs an independently administered test namespace.',
        assertions: [],
        evidence: [],
        facts,
      };
    }
    const databaseUrl = environment.HAIP_ACCEPTANCE_RESTORE_DATABASE_URL;
    requireCheck(typeof databaseUrl === 'string');
    const targetUrl = new URL(databaseUrl);
    requireCheck(decodeURIComponent(targetUrl.pathname.slice(1)) === settings.target_database);
    requireCheck(
      [...targetUrl.searchParams.keys()].every((name) =>
        ['sslmode', 'sslnegotiation', 'ssl', 'uselibpqcompat'].includes(name),
      ),
    );
    const env = Object.fromEntries(
      runtimeVariables
        .filter((name) => environment[name] !== undefined)
        .map((name) => [name, environment[name]]),
    );
    Object.assign(env, {
      HAIP_MODE: 'production',
      HAIP_DATABASE_URL: databaseUrl,
      HAIP_ORIGIN: plan.deployment.trusted_origin,
      HAIP_SANDBOX_ORIGIN: plan.deployment.sandbox_origin_pattern,
      HAIP_ANCHOR_INDEPENDENT_ADMIN: 'true',
    });
    if (!fixture)
      Object.assign(env, await storageEnvironment(plan, planDigest, settings, environment));
    stage = 'artifact';
    scratch = await mkdtemp(join(directory, 'backup-recovery-'));
    env.TMPDIR = scratch;
    const dist = await stageServerPackage(settings, plan.deployment, scratch);
    const backup = await stageExactFile(
      settings.backup,
      join(scratch, 'snapshot.haipbak'),
      settings.backup_digest,
    );
    passed(stage, 'The staged server archive and encrypted backup matched the reviewed digests.');

    stage = 'restore_target';
    const { createRuntime } = await import(pathToFileURL(join(dist, 'runtime.js')).href);
    const { service } = createRuntime(env, { databaseAccess: 'administrative' });
    store = service.store;
    const identity = await store.pool.query('SELECT current_database() AS name');
    requireCheck(identity.rows[0].name === settings.target_database);
    passed(stage, 'The database connection used the expected target and verified TLS.');

    stage = 'encrypted_restore';
    const restored = await execute(
      process.execPath,
      [join(dist, 'backup-command.js'), 'restore', backup],
      { env, timeout: window, maxBuffer: 32 * 1024 },
    );
    const report = JSON.parse(restored.stdout);
    requireCheck(
      report.restored === true &&
        report.admission === 'fenced' &&
        report.recovery_required === true,
    );
    await store.migrate();
    const before = await databaseCanary(store, settings);
    const receiptDigest = verifyCanary(
      before,
      settings,
      service.config.trust,
      plan.deployment.trusted_origin,
    );
    passed(
      stage,
      'An authenticated restore fenced the isolated tenant and retained the signed canary and its private material.',
    );

    stage = 'offline_recovery';
    const operator = 'recovery-' + randomUUID();
    const token = randomBytes(32).toString('base64url');
    const result = await execute(
      process.execPath,
      [...(fixture?.preload ?? []), join(dist, 'main.js'), '--recover'],
      {
        env: {
          ...env,
          ...fixture?.environment,
          ...(fixture ? { HAIP_TEST_SERVER_DIST: dist } : {}),
          HAIP_RECOVERY_TENANT: settings.tenant,
          HAIP_RECOVERY_OPERATOR: operator,
          HAIP_RECOVERY_TOKEN: token,
        },
        timeout: window,
        maxBuffer: 32 * 1024,
      },
    );
    const recovery = JSON.parse(result.stdout);
    await verifyRecovered(store, settings, recovery, receiptDigest, operator, token);
    passed(
      stage,
      'Recovery retired the old generation against retained history and left the new generation fenced with redacted material and fresh credentials.',
    );
    facts.recovered_generation_digest = sha256(recovery.generation);
    facts.receipt_digest = receiptDigest;
    status = fixture ? 'blocked' : 'passed';
  } catch {
    assertions.push({
      name: stage,
      passed: false,
      detail: 'The recovery step failed or its observations differed from the plan.',
    });
  } finally {
    await store?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
  const evidence = await privateEvidence(
    directory,
    'backup-recovery',
    'backup_recovery_observations',
    {
      recorded_at: new Date().toISOString(),
      scope,
      status,
      source_commit: plan.source.commit,
      service_artifact_digest: plan.deployment.service_artifact_digest,
      plan_digest: planDigest,
      settings_digest: sha256(bytes),
      assertions,
      facts,
    },
  );
  const summary = {
    passed: 'Encrypted restoration and offline recovery passed on the isolated deployment.',
    blocked: 'The local recovery exercise passed with fixture storage.',
    failed: 'The backup recovery drill failed during ' + stage.replaceAll('_', ' ') + '.',
  }[status];
  return { status, summary, assertions, evidence: [evidence], facts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plan, evidence, settings, ...extra] = process.argv.slice(2);
  if (
    !plan ||
    !evidence ||
    !settings ||
    extra.length ||
    (process.env.HAIP_ACCEPTANCE_CHECK_ID && process.env.HAIP_ACCEPTANCE_CHECK_ID !== checkId)
  ) {
    console.error(
      'Usage: node deployment/adapters/backup-recovery.mjs PLAN EVIDENCE_DIRECTORY SETTINGS',
    );
    process.exitCode = 64;
  } else {
    try {
      console.log(JSON.stringify(await collectBackupRecovery(plan, evidence, settings)));
    } catch {
      console.error('Backup recovery adapter could not record evidence.');
      process.exitCode = 1;
    }
  }
}
