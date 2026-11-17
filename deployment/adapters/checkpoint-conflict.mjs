import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_REVISION } from '@haip/protocol';
import { digest, verifyRecord } from '@haip/protocol/crypto';
import { AzureAnchor } from '../../haip-server/dist/anchor.js';
import { runtimeIdentity, storageTarget } from './azure-acceptance.mjs';
import {
  callApi,
  confirmedClaim,
  expect,
  label,
  operatorControl,
  permitInput,
  readCanary,
  refused,
  uuid,
} from './authority-probes.mjs';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';

const checkId = 'duplicate_conflict';
const backend = 'azure_blob_locked_worm';
const errors = {
  extra: 'anchor_deleted_version',
  missing: 'anchor_version_conflict',
  changed: 'anchor_version_conflict',
  deleted: 'anchor_deleted_version',
};
const variants = Object.keys(errors);
const credentials = (variant) =>
  ['producer', 'operator'].map(
    (role) => `HAIP_ACCEPTANCE_CONFLICT_${variant.toUpperCase()}_${role.toUpperCase()}_TOKEN`,
  );
const versionId = /^[a-zA-Z0-9:._-]{1,160}$/;

function validateSettings(plan, planDigest, settings) {
  const origin = new URL(plan.deployment.trusted_origin);
  expect(
    origin.protocol === 'https:' &&
      origin.origin === plan.deployment.trusted_origin &&
      plan.deployment.protocol_revision === PROTOCOL_REVISION &&
      settings?.plan_digest === planDigest &&
      typeof settings.storage_settings === 'string' &&
      isAbsolute(settings.storage_settings) &&
      Object.keys(settings.cases ?? {}).length === variants.length,
  );
  const cases = variants.map((variant) => settings.cases[variant]);
  for (const item of cases)
    expect(
      typeof item?.probe_id === 'string' &&
        uuid.test(item.probe_id) &&
        [item.tenant, item.producer].every((id) => typeof id === 'string' && label.test(id)) &&
        [item.fresh_request, item.preclaim_request].every(
          (id) => typeof id === 'string' && uuid.test(id),
        ),
    );
  for (const key of ['tenant', 'probe_id'])
    expect(new Set(cases.map((item) => item[key])).size === cases.length);
  expect(
    new Set(
      cases.flatMap(({ fresh_request, preclaim_request }) => [fresh_request, preclaim_request]),
    ).size ===
      2 * cases.length,
  );
  return origin;
}

async function observeVersions(container, pin) {
  const items = [];
  for await (const item of container.listBlobsFlat({
    prefix: pin.key,
    includeVersions: true,
    includeSnapshots: true,
    includeDeleted: true,
    includeDeletedWithVersions: true,
    abortSignal: AbortSignal.timeout(10_000),
  })) {
    expect(item.name === pin.key && items.length < 2 && !item.snapshot);
    items.push({
      id: item.versionId ?? null,
      current: item.isCurrentVersion === true,
      deleted: item.deleted === true,
      versions_only: item.hasVersionsOnly === true,
    });
  }
  return items;
}

function isConflict(variant, items, pinned) {
  const [one] = items;
  const replacement = (item) =>
    item.current &&
    !item.deleted &&
    !item.versions_only &&
    typeof item.id === 'string' &&
    versionId.test(item.id) &&
    item.id !== pinned;
  switch (variant) {
    case 'extra':
      return (
        items.length === 2 &&
        items.some(replacement) &&
        items.some(
          (item) => item.id === pinned && !item.current && !item.deleted && !item.versions_only,
        )
      );
    case 'missing':
      return items.length === 0;
    case 'changed':
      return items.length === 1 && replacement(one);
    case 'deleted':
      return (
        items.length > 0 &&
        items.every((item) => !item.current || item.deleted || item.versions_only) &&
        items.some((item) => item.id === pinned)
      );
  }
}

function validateContender(contender, checkpoint, trust) {
  const original = checkpoint.payload;
  expect(
    contender?.payload?.ledger_id === original.ledger_id &&
      contender.payload.generation === original.generation &&
      contender.payload.sequence === original.sequence &&
      /^sha256:[a-f0-9]{64}$/.test(contender.payload.head ?? '') &&
      contender.payload.head !== original.head,
  );
  verifyRecord(
    contender,
    trust,
    {
      issuer: trust.issuer,
      audience: 'haip.audit',
      tenant: original.ledger_id,
      purpose: 'service',
      type: 'AuditCheckpoint',
    },
    new Date(),
  );
}

async function proveReplay(anchor, canary, contender) {
  const { checkpoint, acceptance } = canary.anchor;
  const repeated = await anchor.accept(checkpoint);
  expect(
    repeated.version_id === acceptance.version_id &&
      repeated.key === acceptance.key &&
      repeated.digest === acceptance.digest &&
      repeated.backend === backend,
  );
  try {
    await anchor.accept(contender);
    throw new Error('Conflicting publication succeeded');
  } catch (error) {
    expect(error?.status === 503 && error.code === 'anchor_conflict');
  }
  await anchor.verifyAcceptance(checkpoint, acceptance);
}

const claim = (call, canary) =>
  call(canary.path + '/claims', canary.claimInput, canary.idempotencyKey);
const exactCheckpoint = (store, canary) =>
  store.verifyAcceptance(canary.anchor.checkpoint, canary.anchor.acceptance);

async function prepareCase(origin, variant, item, trust, environment, fixture, anchor) {
  const [producer, operator] = credentials(variant).map((name) => environment[name]);
  const call = callApi(origin, producer, fixture?.ca);
  const inspect = callApi(origin, operator, fixture?.ca);
  const context = { ...item, trust_manifest: trust };
  const [fresh, preclaim, before, adminRead] = await Promise.all([
    call('/v2/requests/' + item.fresh_request).then((result) =>
      readCanary(result, item.fresh_request, 'fresh', context, checkId, backend),
    ),
    call('/v2/requests/' + item.preclaim_request).then((result) =>
      readCanary(result, item.preclaim_request, 'preclaim', context, checkId, backend),
    ),
    inspect('/v2/admin/metrics'),
    inspect('/v2/requests/' + item.fresh_request),
  ]);
  const { checkpoint, acceptance } = fresh.anchor;
  expect(
    before.status === 200 &&
      before.body.admission_fenced === false &&
      Array.isArray(before.body.incidents) &&
      adminRead.status === 200 &&
      adminRead.body.request_digest === fresh.requestDigest &&
      adminRead.body.request?.tenant === item.tenant &&
      preclaim.request.authority_namespace === fresh.request.authority_namespace &&
      preclaim.anchor.checkpoint.payload.ledger_id === checkpoint.payload.ledger_id &&
      preclaim.request.execution.action_occurrence_id !==
        fresh.request.execution.action_occurrence_id &&
      preclaim.anchor.acceptance.key !== acceptance.key &&
      typeof acceptance.version_id === 'string' &&
      versionId.test(acceptance.version_id),
  );
  await Promise.all([exactCheckpoint(anchor, fresh), exactCheckpoint(anchor, preclaim)]);
  return { fresh, preclaim, call, inspect, before: before.body };
}

export async function collectCheckpointConflict(
  planPath,
  evidencePath,
  settingsPath,
  { environment = process.env, fixture } = {},
) {
  const { plan, digest: planDigest } = await readAcceptancePlan(planPath);
  const scope = fixture ? 'local_fixture' : 'isolated_deployment';
  if (!fixture && plan.deployment.independent_administration_asserted !== true)
    return {
      status: 'blocked',
      summary: 'Conflict injection needs an independently administered isolated deployment.',
      assertions: [],
      evidence: [],
      facts: { scope },
    };
  const { bytes, document: settings } = await readJsonDocument(settingsPath);
  const directory = await privateDirectory(evidencePath);
  const assertions = [];
  const proved = {};
  let replay;
  let stage = 'settings';
  let status = 'failed';
  const pass = (name, detail) => assertions.push({ name, passed: true, detail });
  try {
    expect((environment.HAIP_ACCEPTANCE_CHECK_ID ?? checkId) === checkId);
    const origin = validateSettings(plan, planDigest, settings);
    if (fixture) expect(Buffer.isBuffer(fixture.ca) && fixture.anchor?.container);
    const tokenNames = variants.flatMap(credentials);
    const tokens = tokenNames.map((name) => environment[name]);
    expect(
      tokens.every((token) => typeof token === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(token)) &&
        new Set(tokens).size === tokens.length,
    );
    const control = operatorControl(settings, environment, [
      ...tokenNames,
      'HAIP_ACCEPTANCE_AZURE_RUNTIME_CLIENT_SECRET',
      'IDENTITY_HEADER',
      'MSI_SECRET',
    ]);
    const { bytes: storageBytes, document: storage } = await readJsonDocument(
      settings.storage_settings,
    );
    expect(
      storage.plan_digest === planDigest &&
        sha256(storageBytes) === settings.storage_settings_digest,
    );
    expect(environment.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    const target = storageTarget(plan, storage);
    const trust = storage.trust_manifest;
    const container = storage.checkpoint.container;
    expect(
      trust?.issuer === origin.origin &&
        trust.protocol_revision === PROTOCOL_REVISION &&
        Array.isArray(trust.keys) &&
        trust.keys.length > 0 &&
        trust.keys.length <= 128,
    );
    const anchor = fixture
      ? fixture.anchor
      : new AzureAnchor(
          target.origin,
          container,
          storage.anchor_prefix,
          trust,
          runtimeIdentity(storage, environment),
        );

    stage = 'bound_canaries';
    const cases = {};
    for (const variant of variants)
      cases[variant] = await prepareCase(
        origin,
        variant,
        settings.cases[variant],
        trust,
        environment,
        fixture,
        anchor,
      );
    const originals = Object.values(cases).map(({ fresh }) => fresh.anchor.checkpoint.payload);
    for (const key of ['ledger_id', 'generation'])
      expect(new Set(originals.map((checkpoint) => checkpoint[key])).size === variants.length);
    validateContender(settings.conflicting_checkpoint, cases.extra.fresh.anchor.checkpoint, trust);
    pass(
      stage,
      'The signed test requests, fresh grants and pinned storage matched four distinct tenant namespaces.',
    );

    stage = 'conditional_replay';
    await proveReplay(anchor, cases.extra.fresh, settings.conflicting_checkpoint);
    replay = {
      version_digest: sha256(cases.extra.fresh.anchor.acceptance.version_id),
      original_digest: cases.extra.fresh.anchor.acceptance.digest,
      contender_digest: digest(settings.conflicting_checkpoint),
    };
    pass(
      stage,
      'An identical publication recovered its original version and a signed conflicting head was refused.',
    );

    for (const variant of variants) {
      const { call, fresh, preclaim, inspect, before } = cases[variant];
      const pin = fresh.anchor.acceptance;
      stage = variant + '_preclaim';
      const original = confirmedClaim(await claim(call, preclaim), preclaim, trust);
      const admission = permitInput(original);
      expect(Math.min(preclaim.deadline, fresh.deadline) > Date.now());

      stage = variant + '_observed';
      await control(
        variant,
        settings.cases[variant].probe_id,
        planDigest,
        target.origin,
        container,
        pin.key,
        pin.version_id,
      );
      const versions = await observeVersions(anchor.container, pin);
      expect(isConflict(variant, versions, pin.version_id));
      await exactCheckpoint(anchor, preclaim);
      pass(
        stage,
        'The provider read showed the requested version fault and the other checkpoint remained readable.',
      );

      stage = variant + '_fenced';
      refused(await claim(call, fresh), 503, errors[variant]);
      refused(await claim(call, fresh), 503, 'admission_fenced');
      refused(await call(preclaim.path + '/admission', admission), 503, 'admission_fenced');
      const [after, freshAfter, preclaimAfter] = await Promise.all([
        inspect('/v2/admin/metrics'),
        call(fresh.path),
        call(preclaim.path),
      ]);
      const previous = new Set(before.incidents.map(({ id }) => id));
      expect(
        after.status === 200 &&
          after.body.admission_fenced === true &&
          Array.isArray(after.body.incidents) &&
          after.body.incidents.some(
            ({ id, code }) => id != null && !previous.has(id) && code === errors[variant],
          ),
      );
      expect(
        freshAfter.status === 200 &&
          freshAfter.body.audit_state === 'conflict' &&
          freshAfter.body.claim === null &&
          digest(freshAfter.body.receipt) === fresh.receiptDigest &&
          preclaimAfter.status === 200 &&
          preclaimAfter.body.audit_state === 'conflict' &&
          preclaimAfter.body.execution_state === 'claimed' &&
          digest(preclaimAfter.body.claim) === digest(original) &&
          digest(preclaimAfter.body.receipt) === preclaim.receiptDigest,
      );
      proved[variant] = {
        error: errors[variant],
        original_version_digest: sha256(pin.version_id),
        listing_digest: digest(versions),
        versions: versions.map(({ id, ...state }) => ({
          version_digest: id === null ? null : sha256(id),
          ...state,
        })),
      };
      pass(
        stage,
        'HAIP recorded the incident and refused a fresh claim and fresh admission under the tenant fence.',
      );
    }
    status = fixture ? 'blocked' : 'passed';
  } catch {
    assertions.push({
      name: stage,
      passed: false,
      detail: 'The checkpoint conflict observation differed from the plan.',
    });
  }
  const evidence = await privateEvidence(
    directory,
    'checkpoint-conflict',
    'conflict_observations',
    {
      recorded_at: new Date().toISOString(),
      check_id: checkId,
      status,
      scope,
      source_commit: plan.source.commit,
      service_artifact_digest: plan.deployment.service_artifact_digest,
      plan_digest: planDigest,
      settings_digest: sha256(bytes),
      assertions,
      replay,
      variants: proved,
    },
  );
  return {
    status,
    summary: {
      passed: 'Checkpoint replay and all four version faults passed on the isolated deployment.',
      blocked: 'The local checkpoint replay and version fault exercise passed.',
      failed: 'The checkpoint conflict drill failed during ' + stage.replaceAll('_', ' ') + '.',
    }[status],
    assertions,
    evidence: [evidence],
    facts: { scope, variants_fenced: Object.keys(proved).length },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plan, evidence, settings, ...extra] = process.argv.slice(2);
  if (!plan || !evidence || !settings || extra.length) {
    console.error(
      'Usage: node deployment/adapters/checkpoint-conflict.mjs PLAN EVIDENCE_DIRECTORY SETTINGS',
    );
    process.exitCode = 64;
  } else {
    try {
      console.log(JSON.stringify(await collectCheckpointConflict(plan, evidence, settings)));
    } catch {
      console.error('Checkpoint conflict adapter did not complete.');
      process.exitCode = 1;
    }
  }
}
