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
import { checkRecoveredStart, checkRestartRefused } from './recovery-restart.mjs';

const execute = promisify(execFile);
const backupCheck = 'backup_recovery';
const restartCheck = 'restart_rollback';
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
}

function databaseUrlFor(raw, name) {
  requireCheck(
    typeof raw === 'string' && typeof name === 'string' && name.length > 0 && name.length <= 63,
  );
  const url = new URL(raw);
  requireCheck(decodeURIComponent(url.pathname.slice(1)) === name);
  requireCheck(
    [...url.searchParams.keys()].every((option) =>
      ['sslmode', 'sslnegotiation', 'ssl', 'uselibpqcompat'].includes(option),
    ),
  );
  return raw;
}

async function databaseIdentity(store, name) {
  const {
    rows: [identity],
  } = await store.pool.query(
    'SELECT current_database() AS name, inet_server_addr()::text AS address, inet_server_port() AS port, current_user AS role FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl',
  );
  requireCheck(identity?.name === name);
  return identity;
}

async function verifyRuntimeDatabase(createRuntimeStore, env, name, expected) {
  const store = createRuntimeStore(env);
  try {
    const { role, ...endpoint } = await databaseIdentity(store, name);
    const { role: admin, ...adminEndpoint } = expected;
    requireCheck(role !== admin && digest(endpoint) === digest(adminEndpoint));
    const {
      rows: [identity],
    } = await store.pool.query(
      `SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
         OR pg_has_role(rolname, $1::name, 'MEMBER')) AS restricted
       FROM pg_roles WHERE rolname=current_user`,
      [admin],
    );
    requireCheck(identity?.restricted === true);
  } finally {
    await store.close();
  }
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
      data.request.metadata?.haip_acceptance_fixture === backupCheck &&
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

async function restoreCanary(dist, backup, env, store, settings, trust) {
  const restored = await execute(
    process.execPath,
    [join(dist, 'backup-command.js'), 'restore', backup],
    {
      env,
      timeout: window,
      maxBuffer: 32 * 1024,
    },
  );
  const report = JSON.parse(restored.stdout);
  requireCheck(
    report.restored === true && report.admission === 'fenced' && report.recovery_required === true,
  );
  await store.migrate();
  const before = await databaseCanary(store, settings);
  const receiptDigest = verifyCanary(before, settings, trust, env.HAIP_ORIGIN);
  return { canary: before.request.data.request, receiptDigest };
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
  const routes = await store.pool.query(
    "SELECT 1 FROM haip_routes WHERE tenant=$1 AND (config->'reviewers' IS DISTINCT FROM '[]'::jsonb OR config->'allowed_producers' IS DISTINCT FROM '[]'::jsonb) LIMIT 1",
    [settings.tenant],
  );
  requireCheck(!routes.rowCount);
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

async function producerBeforeRecovery(store, canary, oldToken) {
  const {
    rows: [producer],
  } = await store.pool.query(
    "SELECT config,token_hash FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='producer'",
    [canary.tenant, canary.producer],
  );
  requireCheck(producer?.config.enabled === true && producer.token_hash === digestBytes(oldToken));
  const { publisher, owner, routes } = producer.config;
  return { enabled: true, publisher, owner, routes };
}

function processEnvironment(env, dist, fixture, offline) {
  return {
    ...env,
    ...fixture?.environment,
    ...(fixture
      ? { HAIP_TEST_SERVER_DIST: dist, HAIP_TEST_EXPECT_OFFLINE: offline ? '1' : '0' }
      : {}),
  };
}

async function verifyRefusedStart(args, env, store, settings, generation) {
  const incidents = async () =>
    Number(
      (
        await store.pool.query(
          "SELECT count(*) AS count FROM haip_incidents WHERE tenant=$1 AND code='namespace_recovery_required'",
          [settings.tenant],
        )
      ).rows[0].count,
    );
  const before = await incidents();
  await checkRestartRefused(args, env);
  const { tenant } = await databaseCanary(store, settings);
  requireCheck(tenant.generation === generation && (await incidents()) === before + 1);
}

export async function collectBackupRecovery(
  planPath,
  evidenceDirectory,
  settingsPath,
  { environment = process.env, fixture, checkId = backupCheck } = {},
) {
  requireCheck(checkId === backupCheck || checkId === restartCheck);
  const restart = checkId === restartCheck;
  const { plan, digest: planDigest } = await readAcceptancePlan(planPath);
  const { bytes, document: settings } = await readJsonDocument(settingsPath);
  const directory = await privateDirectory(evidenceDirectory);
  const scope = fixture ? 'local_fixture' : 'isolated_deployment';
  const assertions = [];
  const facts = { scope };
  let stage = 'settings';
  let status = 'failed';
  let scratch, store, rollbackStore;
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
    const databaseUrl = databaseUrlFor(
      restart
        ? environment.HAIP_ACCEPTANCE_RESTART_DATABASE_URL
        : environment.HAIP_ACCEPTANCE_RESTORE_DATABASE_URL,
      settings.target_database,
    );
    const oldToken = environment.HAIP_ACCEPTANCE_PRE_RECOVERY_PRODUCER_TOKEN;
    let recoveredRuntimeUrl, rollbackUrl, rollbackRuntimeUrl;
    if (restart) {
      requireCheck(settings.target_database !== settings.rollback_database);
      requireCheck(typeof oldToken === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(oldToken));
      recoveredRuntimeUrl = databaseUrlFor(
        environment.HAIP_ACCEPTANCE_RECOVERED_RUNTIME_DATABASE_URL,
        settings.target_database,
      );
      rollbackUrl = databaseUrlFor(
        environment.HAIP_ACCEPTANCE_ROLLBACK_DATABASE_URL,
        settings.rollback_database,
      );
      rollbackRuntimeUrl = databaseUrlFor(
        environment.HAIP_ACCEPTANCE_ROLLBACK_RUNTIME_DATABASE_URL,
        settings.rollback_database,
      );
    }
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
    const { createRuntime, createRuntimeStore } = await import(
      pathToFileURL(join(dist, 'runtime.js')).href
    );
    const { service } = createRuntime(env, { databaseAccess: 'administrative' });
    store = service.store;
    const identity = await databaseIdentity(store, settings.target_database);
    let rollbackAdmin, recoveredEnv, rollbackEnv, producerConfig;
    if (restart) {
      rollbackAdmin = { ...env, HAIP_DATABASE_URL: rollbackUrl };
      rollbackStore = createRuntimeStore(rollbackAdmin, 'administrative');
      const rollbackIdentity = await databaseIdentity(rollbackStore, settings.rollback_database);
      recoveredEnv = { ...env, HAIP_DATABASE_URL: recoveredRuntimeUrl };
      rollbackEnv = { ...env, HAIP_DATABASE_URL: rollbackRuntimeUrl };
      await verifyRuntimeDatabase(
        createRuntimeStore,
        recoveredEnv,
        settings.target_database,
        identity,
      );
      await verifyRuntimeDatabase(
        createRuntimeStore,
        rollbackEnv,
        settings.rollback_database,
        rollbackIdentity,
      );
    }
    passed(
      stage,
      restart
        ? 'Both database targets used verified TLS. Each runtime login was separate from the restore role and had no administrative role flags.'
        : 'The database connection used the expected target and verified TLS.',
    );

    stage = 'encrypted_restore';
    const { canary, receiptDigest } = await restoreCanary(
      dist,
      backup,
      env,
      store,
      settings,
      service.config.trust,
    );
    passed(
      stage,
      'An authenticated restore fenced the isolated tenant and retained the signed canary and its private material.',
    );

    const main = [...(fixture?.preload ?? []), join(dist, 'main.js')];
    if (restart) {
      stage = 'rollback_restore';
      const prior = await restoreCanary(
        dist,
        backup,
        rollbackAdmin,
        rollbackStore,
        settings,
        service.config.trust,
      );
      requireCheck(prior.receiptDigest === receiptDigest);
      producerConfig = await producerBeforeRecovery(store, canary, oldToken);
      passed(
        stage,
        'The rollback target retained the same original receipt and the original producer credential matched the restored record.',
      );
    }

    stage = 'offline_recovery';
    const operator = 'recovery-' + randomUUID();
    const token = randomBytes(32).toString('base64url');
    const result = await execute(process.execPath, [...main, '--recover'], {
      env: {
        ...processEnvironment(env, dist, fixture, true),
        HAIP_RECOVERY_TENANT: settings.tenant,
        HAIP_RECOVERY_OPERATOR: operator,
        HAIP_RECOVERY_TOKEN: token,
      },
      timeout: window,
      maxBuffer: 32 * 1024,
    });
    const recovery = JSON.parse(result.stdout);
    await verifyRecovered(store, settings, recovery, receiptDigest, operator, token);
    passed(
      stage,
      'Recovery retired the old generation against retained history and left the new generation fenced with redacted material and fresh credentials.',
    );
    facts.recovered_generation_digest = sha256(recovery.generation);
    facts.receipt_digest = receiptDigest;
    if (restart) {
      stage = 'recovered_start';
      const observed = await checkRecoveredStart({
        args: main,
        env: processEnvironment(recoveredEnv, dist, fixture, false),
        request: canary,
        operatorToken: token,
        oldToken,
        producerConfig,
      });
      facts.old_claim_status = observed.oldClaimStatus;
      facts.fresh_claim_status = observed.freshClaimStatus;
      passed(
        stage,
        'Both listeners opened on the recovered generation. The original credential and a reprovisioned producer could not claim the old grant.',
      );

      stage = 'restart_refused';
      await verifyRefusedStart(
        main,
        processEnvironment(recoveredEnv, dist, fixture, true),
        store,
        settings,
        recovery.generation,
      );
      passed(
        stage,
        'The recovered process generation refused a second start before opening listeners.',
      );

      stage = 'rollback_refused';
      await verifyRefusedStart(
        main,
        processEnvironment(rollbackEnv, dist, fixture, true),
        rollbackStore,
        settings,
        settings.generation,
      );
      passed(
        stage,
        'The old database copy stayed fenced and the retired generation refused to open either listener.',
      );
    }
    status = fixture ? 'blocked' : 'passed';
  } catch {
    assertions.push({
      name: stage,
      passed: false,
      detail: 'The recovery step failed or its observations differed from the plan.',
    });
  } finally {
    await Promise.all([store?.close(), rollbackStore?.close()]);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
  const evidence = await privateEvidence(directory, 'backup-recovery', checkId + '_observations', {
    recorded_at: new Date().toISOString(),
    scope,
    status,
    check_id: checkId,
    source_commit: plan.source.commit,
    service_artifact_digest: plan.deployment.service_artifact_digest,
    plan_digest: planDigest,
    settings_digest: sha256(bytes),
    assertions,
    facts,
  });
  const summary = {
    passed: restart
      ? 'Restart and database rollback checks passed on the isolated deployment.'
      : 'Encrypted restoration and offline recovery passed on the isolated deployment.',
    blocked: 'The local recovery exercise passed with fixture storage.',
    failed: 'The backup recovery drill failed during ' + stage.replaceAll('_', ' ') + '.',
  }[status];
  return { status, summary, assertions, evidence: [evidence], facts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plan, evidence, settings, ...extra] = process.argv.slice(2);
  const checkId = process.env.HAIP_ACCEPTANCE_CHECK_ID ?? backupCheck;
  if (
    !plan ||
    !evidence ||
    !settings ||
    extra.length ||
    ![backupCheck, restartCheck].includes(checkId)
  ) {
    console.error(
      'Usage: node deployment/adapters/backup-recovery.mjs PLAN EVIDENCE_DIRECTORY SETTINGS',
    );
    process.exitCode = 64;
  } else {
    try {
      console.log(
        JSON.stringify(await collectBackupRecovery(plan, evidence, settings, { checkId })),
      );
    } catch {
      console.error('Backup recovery adapter could not record evidence.');
      process.exitCode = 1;
    }
  }
}
