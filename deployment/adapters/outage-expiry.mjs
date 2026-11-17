import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_REVISION } from '@haip/protocol';
import { digest } from '@haip/protocol/crypto';
import {
  callApi,
  confirmedClaim,
  confirmedPermit,
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

const checkId = 'outage_expiry';
const tokenName = 'HAIP_ACCEPTANCE_OUTAGE_PRODUCER_TOKEN';
const maximumWait = 180_000;
const restoreWindow = 60_000;

function readSettings(plan, planDigest, settings) {
  const origin = new URL(plan.deployment.trusted_origin);
  expect(
    origin.protocol === 'https:' &&
      origin.origin === plan.deployment.trusted_origin &&
      plan.deployment.protocol_revision === PROTOCOL_REVISION &&
      settings?.plan_digest === planDigest,
  );
  const { fresh, preclaim, control } = settings.requests ?? {};
  const ids = [fresh, preclaim, control];
  expect(
    ids.every((id) => typeof id === 'string' && uuid.test(id)) &&
      new Set(ids).size === ids.length &&
      typeof settings.probe_id === 'string' &&
      uuid.test(settings.probe_id) &&
      [settings.tenant, settings.producer].every(
        (value) => typeof value === 'string' && label.test(value),
      ),
  );
  expect(
    settings.trust_manifest?.issuer === origin.origin &&
      settings.trust_manifest.protocol_revision === PROTOCOL_REVISION &&
      Array.isArray(settings.trust_manifest.keys) &&
      settings.trust_manifest.keys.length > 0 &&
      settings.trust_manifest.keys.length <= 128,
  );
  return origin;
}

export async function collectOutageExpiry(
  planPath,
  evidenceDirectory,
  settingsPath,
  { environment = process.env, fixtureCa } = {},
) {
  const { plan, digest: planDigest } = await readAcceptancePlan(planPath);
  if (!fixtureCa && plan.deployment.independent_administration_asserted !== true)
    return {
      status: 'blocked',
      summary: 'The outage drill needs an independently administered isolated deployment.',
      assertions: [],
      evidence: [],
      facts: { scope: 'isolated_deployment' },
    };
  const { bytes, document: settings } = await readJsonDocument(settingsPath);
  const directory = await privateDirectory(evidenceDirectory);
  const assertions = [];
  const facts = { scope: fixtureCa ? 'local_fixture' : 'isolated_deployment' };
  const passed = (name, detail) => assertions.push({ name, passed: true, detail });
  let stage = 'settings';
  let status = 'failed';
  try {
    expect((environment.HAIP_ACCEPTANCE_CHECK_ID ?? checkId) === checkId);
    const origin = readSettings(plan, planDigest, settings);
    const token = environment[tokenName];
    expect(typeof token === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(token));
    const { trust_manifest: trust } = settings;
    const controlFault = operatorControl(settings, environment, [tokenName]);
    const call = callApi(origin, token, fixtureCa);
    const claim = (canary) =>
      call(canary.path + '/claims', canary.claimInput, canary.idempotencyKey);
    stage = 'bound_canaries';
    const namesOfCanaries = ['fresh', 'preclaim', 'control'];
    const [fresh, preclaim, control] = await Promise.all(
      namesOfCanaries.map(async (name) => {
        const id = settings.requests[name];
        const result = await call('/v2/requests/' + id);
        return readCanary(
          result,
          id,
          name,
          settings,
          checkId,
          fixtureCa ? 'test_filesystem' : 'azure_blob_locked_worm',
        );
      }),
    );
    const expires = Math.max(fresh.deadline, preclaim.deadline);
    expect(
      expires - Date.now() <= maximumWait &&
        control.deadline > expires + restoreWindow &&
        [preclaim, control].every(
          (canary) => canary.request.authority_namespace === fresh.request.authority_namespace,
        ) &&
        new Set(
          [fresh, preclaim, control].map(({ request }) => request.execution.action_occurrence_id),
        ).size === 3,
    );
    facts.fresh_deadline = fresh.receipt.payload.grant_deadline;
    facts.preclaim_deadline = preclaim.receipt.payload.grant_deadline;
    facts.control_deadline = control.receipt.payload.grant_deadline;
    passed(stage, 'Three distinct signed and anchored test grants matched the reviewed probe.');

    stage = 'claim_before_outage';
    const original = confirmedClaim(await claim(preclaim), preclaim, trust);
    const originalPermit = permitInput(original);
    expect(Math.min(fresh.deadline, preclaim.deadline) > Date.now());
    passed(
      stage,
      'The preclaim request was consumed against its original deadline before the outage.',
    );
    const latePermit = () => call(preclaim.path + '/admission', originalPermit);
    const probePair = async () => {
      const results = await Promise.allSettled([claim(fresh), latePermit()]);
      return results.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
    };

    const remaining = expires - Date.now();
    expect(remaining > 0 && remaining <= maximumWait);
    const waitUntil = performance.now() + remaining + 250;
    const leaseSeconds = Math.ceil((remaining + restoreWindow) / 1000);
    const setFault = (action) =>
      controlFault(action, settings.probe_id, planDigest, String(leaseSeconds));
    try {
      stage = 'start_outage';
      await setFault('begin');
      stage = 'refused_during_outage';
      const during = await probePair();
      for (const result of during) refused(result, 503, 'anchor_unavailable');
      passed(
        stage,
        'The checkpoint outage refused a fresh claim and fresh admission before expiry.',
      );
      stage = 'outage_crossed_expiry';
      await delay(Math.max(0, waitUntil - performance.now()));
      refused(await latePermit(), 409, 'grant_expired');
      const observedExpiry = await call(fresh.path);
      expect(observedExpiry.status === 200 && observedExpiry.body.grant_state === 'expired');
      refused(await claim(control), 503, 'anchor_unavailable');
      passed(stage, 'The longer grant still saw the outage after both short grants had expired.');
    } finally {
      try {
        await setFault('restore');
        passed(
          'restore_checkpoint_access',
          'The outage controller reported restored checkpoint access.',
        );
      } catch {
        stage = 'restore_checkpoint_access';
        throw new Error('Outage controller did not confirm restoration');
      }
    }

    stage = 'expired_after_restore';
    for (const result of await probePair()) refused(result, 409, 'grant_expired');
    const [freshAfter, preclaimAfter] = await Promise.all([call(fresh.path), call(preclaim.path)]);
    expect(
      freshAfter.status === 200 &&
        freshAfter.body.grant_state === 'expired' &&
        freshAfter.body.claim === null &&
        freshAfter.body.outcome === null &&
        digest(freshAfter.body.receipt) === fresh.receiptDigest &&
        preclaimAfter.status === 200 &&
        preclaimAfter.body.grant_state === 'consumed' &&
        preclaimAfter.body.execution_state === 'claimed' &&
        preclaimAfter.body.outcome === null &&
        digest(preclaimAfter.body.claim) === digest(original) &&
        digest(preclaimAfter.body.receipt) === preclaim.receiptDigest,
    );
    passed(
      stage,
      'Both expired operations returned grant_expired and both original receipts were preserved.',
    );

    stage = 'restored_control';
    const restored = confirmedClaim(await claim(control), control, trust);
    const restoredInput = permitInput(restored);
    confirmedPermit(
      await call(control.path + '/admission', restoredInput),
      control,
      restored,
      restoredInput,
      trust,
    );
    passed(
      stage,
      'The longer grant received a signed claim and fresh admission with its original deadline.',
    );
    status = fixtureCa ? 'blocked' : 'passed';
  } catch {
    assertions.push({
      name: stage,
      passed: false,
      detail: 'The outage step failed or its observations differed from the plan.',
    });
  }
  const evidence = await privateEvidence(directory, 'outage-expiry', 'outage_observations', {
    recorded_at: new Date().toISOString(),
    check_id: checkId,
    source_commit: plan.source.commit,
    service_artifact_digest: plan.deployment.service_artifact_digest,
    plan_digest: planDigest,
    settings_digest: sha256(bytes),
    assertions,
    facts,
    status,
  });
  const summary = {
    passed: 'Checkpoint outage and grant expiry passed on the isolated deployment.',
    blocked: 'The local checkpoint outage and expiry exercise passed.',
    failed: 'The checkpoint outage drill failed during ' + stage.replaceAll('_', ' ') + '.',
  }[status];
  return { status, summary, assertions, evidence: [evidence], facts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plan, evidence, settings, option, caPath, ...extra] = process.argv.slice(2);
  if (
    !plan ||
    !evidence ||
    !settings ||
    extra.length ||
    (option !== undefined && (option !== '--fixture-ca' || !caPath))
  ) {
    console.error(
      'Usage: node deployment/adapters/outage-expiry.mjs PLAN EVIDENCE_DIRECTORY SETTINGS [--fixture-ca CA_FILE]',
    );
    process.exitCode = 64;
  } else {
    try {
      console.log(
        JSON.stringify(
          await collectOutageExpiry(plan, evidence, settings, {
            fixtureCa: caPath ? await readFile(caPath) : undefined,
          }),
        ),
      );
    } catch {
      console.error('Checkpoint outage adapter did not complete.');
      process.exitCode = 1;
    }
  }
}
