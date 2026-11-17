import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_REVISION } from '@haip/protocol';
import { digest, parseJson } from '@haip/protocol/crypto';
import { callApi, expect, label, operatorControl, uuid } from './authority-probes.mjs';
import {
  privateDirectory,
  privateEvidence,
  readAcceptancePlan,
  readJsonDocument,
  sha256,
} from './evidence.mjs';

const checkId = 'operations';
const operatorName = 'HAIP_ACCEPTANCE_OPERATIONS_OPERATOR_TOKEN';
const monitorName = 'HAIP_ACCEPTANCE_OPERATIONS_MONITOR_TOKEN';
const thresholds = { outbox: 300_000, retention: 1_800_000 };
const rules = {
  HAIPOutboxWorkerStalled: 'time() - haip_operation_last_success_seconds{operation="outbox"} > 300',
  HAIPRetentionWorkerStalled:
    'time() - haip_operation_last_success_seconds{operation="retention"} > 1800',
  HAIPScrapeUnavailable: 'up{job=~"haip(-.+)?"} == 0',
};
const sha = /^sha256:[a-f0-9]{64}$/;
const maxEvidence = 1024 * 1024;

function https(value) {
  const url = new URL(value);
  expect(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search);
  return url;
}

function settingsFor(plan, planDigest, settings, fixture) {
  const origin = https(plan.deployment.trusted_origin);
  const monitor = https(settings.prometheus_origin);
  const { runtime, canary } = settings.targets;
  expect(
    origin.origin === plan.deployment.trusted_origin &&
      monitor.origin === settings.prometheus_origin &&
      monitor.origin !== origin.origin &&
      plan.deployment.protocol_revision === PROTOCOL_REVISION &&
      planDigest === settings.plan_digest &&
      typeof settings.probe_id === 'string' &&
      uuid.test(settings.probe_id) &&
      typeof settings.receiver === 'string' &&
      label.test(settings.receiver),
  );
  for (const target of [runtime, canary])
    expect(
      typeof target?.job === 'string' &&
        /^haip(?:-[A-Za-z0-9_.-]+)?$/.test(target.job) &&
        typeof target.instance === 'string' &&
        label.test(target.instance) &&
        typeof target.scrape_url === 'string' &&
        https(target.scrape_url).href === target.scrape_url,
    );
  expect(
    runtime.scrape_url !== canary.scrape_url &&
      (runtime.job !== canary.job || runtime.instance !== canary.instance),
  );
  if (fixture)
    expect(
      Buffer.isBuffer(fixture.ca) &&
        origin.hostname.endsWith('.test') &&
        monitor.hostname.endsWith('.test') &&
        [runtime, canary].every((target) => https(target.scrape_url).hostname === '127.0.0.1') &&
        https(runtime.scrape_url).pathname === '/v2/admin/metrics.prom',
    );
  else expect(runtime.scrape_url === new URL('/v2/admin/metrics.prom', origin).href);
  return { origin, monitor, runtime, canary };
}

async function retainedControl(directory, item, name) {
  expect(
    typeof item?.file === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,160}$/.test(item.file) &&
      typeof item.digest === 'string' &&
      sha.test(item.digest) &&
      typeof item.recorded_at === 'string' &&
      Number.isFinite(Date.parse(item.recorded_at)) &&
      Date.parse(item.recorded_at) <= Date.now() + 30_000,
  );
  const file = await open(
    join(directory, item.file),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    expect(stat.isFile() && !(stat.mode & 0o077) && stat.size > 0 && stat.size <= maxEvidence);
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    expect(bytesRead === stat.size && sha256(bytes.subarray(0, bytesRead)) === item.digest);
  } finally {
    await file.close();
  }
  return {
    name,
    digest: item.digest,
    reference: 'private-evidence:' + item.file,
    recorded_at: new Date(item.recorded_at).toISOString(),
  };
}

async function readControls(directory, control, planDigest) {
  const { plan_digest, observer, keys, disks, backups } = control;
  expect(
    plan_digest === planDigest &&
      typeof observer === 'string' &&
      label.test(observer) &&
      typeof keys?.custodian === 'string' &&
      label.test(keys.custodian) &&
      keys.trust_out_of_band === true &&
      keys.historical_keys_retained === true &&
      keys.backup_key_separate === true &&
      typeof keys.trust_manifest_digest === 'string' &&
      sha.test(keys.trust_manifest_digest) &&
      disks?.runtime_encrypted === true &&
      disks.database_encrypted === true &&
      disks.scratch_encrypted === true &&
      backups?.private === true &&
      backups.encrypted === true &&
      backups.prune_observed === true &&
      Number.isSafeInteger(backups.maximum_age_days) &&
      backups.maximum_age_days > 0 &&
      backups.maximum_age_days <= 30 &&
      Number.isSafeInteger(backups.interval_hours) &&
      backups.interval_hours > 0 &&
      backups.interval_hours <= 24,
  );
  const observed = [
    ['key_custody', keys.evidence],
    ['encrypted_disks', disks.evidence],
    ['backup_retention', backups.evidence],
  ];
  const evidence = [];
  for (const [name, item] of observed) evidence.push(await retainedControl(directory, item, name));
  expect(new Set(evidence.map(({ reference }) => reference)).size === observed.length);
  return {
    evidence,
    trustDigest: keys.trust_manifest_digest,
    maximumAge: backups.maximum_age_days,
  };
}

async function waitFor(probe, window = 120_000) {
  const deadline = performance.now() + window;
  while (performance.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(1000);
  }
  throw new Error('No matching monitoring observation before the deadline');
}

const sameTarget = (record, expected) =>
  record?.labels?.job === expected.job && record.labels.instance === expected.instance;

async function prometheus(call, path) {
  const { status, body } = await call(path);
  expect(status === 200 && body?.status === 'success' && body.data);
  return body.data;
}

async function targets(call, runtime, canary) {
  const data = await prometheus(call, '/api/v1/targets?state=active');
  expect(Array.isArray(data.activeTargets));
  return [runtime, canary].map((expected) => {
    const matches = data.activeTargets.filter((item) => sameTarget(item, expected));
    if (!matches.length) return null;
    expect(matches.length === 1 && matches[0].scrapeUrl === expected.scrape_url);
    return matches[0].health;
  });
}

async function workerTimes(call) {
  const { status, body } = await call('/v2/admin/metrics');
  expect(status === 200 && Array.isArray(body?.operations));
  return Object.fromEntries(
    Object.keys(thresholds).map((name) => [
      name,
      Date.parse(body.operations.find((item) => item.name === name)?.succeeded_at),
    ]),
  );
}

function timesMatch(times, fresh) {
  const now = Date.now();
  return Object.entries(thresholds).every(
    ([name, threshold]) =>
      Number.isFinite(times[name]) &&
      times[name] <= now + 30_000 &&
      (fresh ? now - times[name] <= threshold : now - times[name] > threshold),
  );
}

function currentReceipts(items, alerts, receiver, state, since, firing) {
  expect(Array.isArray(items) && items.length <= 100);
  return alerts.map((alert, index) =>
    items.find(
      (item) =>
        item?.receiver === receiver &&
        item.status === state &&
        item.labels?.alertname === alert.name &&
        sameTarget(item, alert.target) &&
        typeof item.fingerprint === 'string' &&
        /^[a-f0-9]{16}$/.test(item.fingerprint) &&
        Date.parse(item.received_at) >= since &&
        Date.parse(item.received_at) <= Date.now() + 30_000 &&
        Date.parse(item.starts_at) >= alert.started &&
        Date.parse(item.starts_at) <= Date.parse(item.received_at) &&
        (state === 'firing' ||
          (item.fingerprint === firing[index].fingerprint &&
            item.starts_at === firing[index].starts_at &&
            Date.parse(item.ends_at) >= since - 30_000 &&
            Date.parse(item.ends_at) <= Date.parse(item.received_at))),
    ),
  );
}

export async function collectOperations(
  planPath,
  evidencePath,
  settingsPath,
  { environment = process.env, fixture } = {},
) {
  const { plan, digest: planDigest } = await readAcceptancePlan(planPath);
  const facts = { scope: fixture ? 'local_fixture' : 'isolated_deployment' };
  if (!fixture && plan.deployment.independent_administration_asserted !== true)
    return {
      status: 'blocked',
      summary: 'The operations drill needs an independently administered isolated deployment.',
      assertions: [],
      evidence: [],
      facts,
    };
  const { bytes, document: settings } = await readJsonDocument(settingsPath);
  const directory = await privateDirectory(evidencePath);
  const assertions = [];
  const records = [];
  const observed = {};
  const pass = (name, detail) => assertions.push({ name, passed: true, detail });
  let stage = 'settings';
  let status = 'failed';
  try {
    expect((environment.HAIP_ACCEPTANCE_CHECK_ID ?? checkId) === checkId);
    const { origin, monitor, runtime, canary } = settingsFor(plan, planDigest, settings, fixture);
    const operator = environment[operatorName];
    const readToken = environment[monitorName];
    expect(
      typeof operator === 'string' &&
        /^[A-Za-z0-9_-]{32,200}$/.test(operator) &&
        (readToken === undefined ||
          (typeof readToken === 'string' &&
            /^[\x21-\x7e]{1,4096}$/.test(readToken) &&
            readToken !== operator)),
    );
    const managed = operatorControl(settings, environment, [operatorName, monitorName]);
    const operate = (action) => managed(action, settings.probe_id, planDigest);
    const receipts = async () => parseJson((await operate('receipts')).stdout);
    const api = callApi(origin, operator, fixture?.ca);
    const prom = callApi(monitor, readToken, fixture?.ca);

    stage = 'operational_controls';
    const controls = await readControls(directory, settings.control_observations, planDigest);
    const trust = await callApi(origin, undefined, fixture?.ca)('/.well-known/haip-trust');
    expect(
      trust.status === 200 &&
        trust.body?.issuer === origin.origin &&
        trust.body.protocol_revision === PROTOCOL_REVISION &&
        digest(trust.body) === controls.trustDigest,
    );
    records.push(...controls.evidence);
    facts.trust_manifest_digest = controls.trustDigest;
    facts.backup_maximum_age_days = controls.maximumAge;
    pass(
      stage,
      'The independently supplied trust digest matched discovery and the referenced custody, disk and backup records matched their digests.',
    );

    stage = 'monitoring_baseline';
    await waitFor(async () => {
      try {
        const [healthy, spare] = await targets(prom, runtime, canary);
        return healthy === 'up' && spare === 'up';
      } catch (error) {
        if (error?.code === 'ECONNREFUSED') return false;
        throw error;
      }
    }, 30_000);
    const configured = await prometheus(prom, '/api/v1/rules?type=alert');
    const loaded = configured.groups.flatMap((group) => group.rules);
    for (const [name, query] of Object.entries(rules)) {
      const candidates = loaded.filter((rule) => rule.name === name);
      expect(
        candidates.length === 1 &&
          candidates[0].type === 'alerting' &&
          candidates[0].duration === 60 &&
          candidates[0].labels?.severity === 'critical' &&
          candidates[0].query.replace(/\s/g, '') === query.replace(/\s/g, ''),
      );
    }
    const baseline = await workerTimes(api);
    expect(timesMatch(baseline, true) && (await receipts()).length === 0);
    pass(
      stage,
      'Both exact scrape targets were healthy with current worker timestamps and the expected alert rules installed.',
    );

    let fired;
    let recoverAt;
    let stalled;
    const faultAt = Date.now();
    const alerts = Object.keys(rules).map((name) => ({
      name,
      target: name === 'HAIPScrapeUnavailable' ? canary : runtime,
      started: faultAt - 30_000,
    }));
    try {
      stage = 'stall_observed';
      await operate('stall');
      stalled = await workerTimes(api);
      expect(timesMatch(stalled, false));
      await waitFor(async () => {
        const [healthy, spare] = await targets(prom, runtime, canary);
        return healthy === 'up' && spare === 'down';
      }, 30_000);
      pass(
        stage,
        'The tested worker timestamps crossed their thresholds while only the disposable scrape target became unavailable.',
      );

      stage = 'alerts_routed';
      fired = await waitFor(async () => {
        const items = currentReceipts(
          await receipts(),
          alerts,
          settings.receiver,
          'firing',
          faultAt,
        );
        return items.every(Boolean) ? items : null;
      }, 180_000);
      const active = await prometheus(prom, '/api/v1/alerts');
      expect(
        alerts.every((alert) =>
          active.alerts.some(
            (item) =>
              item.state === 'firing' &&
              item.labels?.alertname === alert.name &&
              sameTarget(item, alert.target),
          ),
        ),
      );
      pass(
        stage,
        'Prometheus reported all three alerts firing and the incident receiver recorded delivery.',
      );
    } finally {
      recoverAt = Date.now();
      try {
        await operate('recover');
      } catch (error) {
        stage = 'restore_monitoring';
        throw error;
      }
    }

    stage = 'alerts_resolved';
    const resolved = await waitFor(async () => {
      const items = currentReceipts(
        await receipts(),
        alerts,
        settings.receiver,
        'resolved',
        recoverAt,
        fired,
      );
      return items.every(Boolean) ? items : null;
    });
    const [healthy, spare] = await targets(prom, runtime, canary);
    const now = await workerTimes(api);
    expect(
      healthy === 'up' &&
        spare === 'up' &&
        timesMatch(now, true) &&
        Object.keys(thresholds).every(
          (name) => now[name] > stalled[name] && now[name] >= recoverAt - 30_000,
        ),
    );
    const active = await prometheus(prom, '/api/v1/alerts');
    expect(
      alerts.every((alert) =>
        active.alerts.every(
          (item) => item.labels?.alertname !== alert.name || !sameTarget(item, alert.target),
        ),
      ),
    );
    facts.alerts_routed = fired.length;
    facts.alerts_resolved = resolved.length;
    observed.alerts = alerts.map(({ name }, index) => ({
      name,
      fingerprint_digest: sha256(fired[index].fingerprint),
      fired_at: fired[index].received_at,
      resolved_at: resolved[index].received_at,
    }));
    observed.worker_timestamps = { baseline, stalled, recovered: now };
    pass(
      stage,
      'Both scrape targets recovered, the worker timestamps advanced and the incident receiver recorded resolution of the same three alerts.',
    );
    status = fixture ? 'blocked' : 'passed';
  } catch {
    assertions.push({
      name: stage,
      passed: false,
      detail: 'The operations observation differed from the plan or did not arrive.',
    });
  }
  records.push(
    await privateEvidence(directory, 'operations', 'operations_observations', {
      recorded_at: new Date().toISOString(),
      check_id: checkId,
      status,
      source_commit: plan.source.commit,
      service_artifact_digest: plan.deployment.service_artifact_digest,
      plan_digest: planDigest,
      settings_digest: sha256(bytes),
      assertions,
      facts,
      observations: observed,
    }),
  );
  return {
    status,
    assertions,
    evidence: records,
    facts,
    summary: {
      passed:
        'The reviewed operations controls and monitoring exercise passed on the isolated deployment.',
      blocked: 'The local operations and incident routing exercise passed.',
      failed: 'The operations drill failed during ' + stage.replaceAll('_', ' ') + '.',
    }[status],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plan, evidence, settings, ...rest] = process.argv.slice(2);
  if (!plan || !evidence || !settings || rest.length) {
    console.error(
      'Usage: node deployment/adapters/operations.mjs PLAN EVIDENCE_DIRECTORY SETTINGS',
    );
    process.exitCode = 64;
  } else {
    try {
      console.log(JSON.stringify(await collectOperations(plan, evidence, settings)));
    } catch {
      console.error('Operations adapter did not complete.');
      process.exitCode = 1;
    }
  }
}
