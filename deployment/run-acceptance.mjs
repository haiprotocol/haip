#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { getDomain } from 'tldts';

const exec = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const root = await realpath(resolve(directory, '..'));
const schema = JSON.parse(await readFile(resolve(directory, 'acceptance.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(schema);
const validatePlanSchema = ajv.getSchema(`${schema.$id}#/$defs/plan`);
const validateReportSchema = ajv.getSchema(`${schema.$id}#/$defs/report`);
const validateAdapterSchema = ajv.getSchema(`${schema.$id}#/$defs/adapterResult`);
const checkIds = [
  'origins_tls',
  'external_identity',
  'writer_permissions',
  'immutable_storage',
  'duplicate_conflict',
  'outage_expiry',
  'backup_recovery',
  'notifications',
  'operations',
  'restart_rollback',
];
const componentKinds = [
  'runtime',
  'database',
  'identity',
  'anchor',
  'backup',
  'notifications',
  'monitoring',
];
const maximumDocumentBytes = 1024 * 1024;
const automaticSecretName =
  /(?:^|_)(?:CLIENT_SECRET|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|BEARER_TOKEN|COOKIE|AUTHORIZATION|PRIVATE_KEY|DATABASE_URL|CONNECTION_STRING|ACCOUNT_KEY|SAS_TOKEN)$/i;

function usage() {
  console.error(
    'Usage: node deployment/run-acceptance.mjs PLAN OUTPUT [--allow-dirty] [--allow-incomplete]',
  );
  console.error('       node deployment/run-acceptance.mjs --validate REPORT');
}

function schemaError(name, validator) {
  const details = (validator.errors ?? [])
    .slice(0, 12)
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join(', ');
  return new Error(`${name} does not match acceptance.schema.json: ${details}`);
}

async function document(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumDocumentBytes) throw new Error('Acceptance document exceeds 1 MiB');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Acceptance document is not valid JSON');
  }
}

function validateOrigins(deployment) {
  const trusted = new URL(deployment.trusted_origin);
  if (trusted.protocol !== 'https:' || trusted.origin !== deployment.trusted_origin)
    throw new Error('Trusted origin must be one exact HTTPS origin');
  const parts = deployment.sandbox_origin_pattern.split('{scope}');
  if (
    parts.length !== 2 ||
    !(parts[0].endsWith('://') || parts[0].endsWith('.')) ||
    !/^(?:\.|:|$)/.test(parts[1])
  )
    throw new Error('Sandbox scope must occupy one complete DNS label');
  const sampleText = deployment.sandbox_origin_pattern.replace('{scope}', 'scope');
  const otherText = deployment.sandbox_origin_pattern.replace('{scope}', 'other-scope');
  const sample = new URL(sampleText);
  const other = new URL(otherText);
  if (
    sample.protocol !== 'https:' ||
    sample.origin !== sampleText ||
    other.origin !== otherText ||
    sample.hostname === trusted.hostname
  )
    throw new Error('Sandbox pattern must produce separate exact HTTPS origins');
  const trustedSite = getDomain(trusted.hostname, { allowPrivateDomains: true });
  const sandboxSite = getDomain(sample.hostname, { allowPrivateDomains: true });
  const otherSite = getDomain(other.hostname, { allowPrivateDomains: true });
  if (!trustedSite || !sandboxSite || trustedSite === sandboxSite || sandboxSite !== otherSite)
    throw new Error('Trusted and sandbox origins must use distinct registrable sites');
}

function exactSet(values, expected, name) {
  if (
    values.length !== expected.length ||
    new Set(values).size !== values.length ||
    expected.some((value) => !values.includes(value))
  )
    throw new Error(`${name} must contain each required value exactly once`);
}

function within(directory, path) {
  const local = relative(directory, path);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function validatePlan(plan) {
  if (!validatePlanSchema(plan)) throw schemaError('Acceptance plan', validatePlanSchema);
  exactSet(
    plan.checks.map((check) => check.id),
    checkIds,
    'Acceptance checks',
  );
  exactSet(
    plan.deployment.components.map((component) => component.kind),
    componentKinds,
    'Deployment components',
  );
  if (plan.deployment.runtime_identity_label === plan.deployment.storage_administrator_label)
    throw new Error('Runtime and storage administrator labels must differ');
  const anchor = plan.deployment.components.find((component) => component.kind === 'anchor');
  if (anchor.identity_label !== plan.deployment.runtime_identity_label)
    throw new Error('Anchor component identity must match the runtime identity');
  if (plan.secret_env.some((name) => !plan.adapter_env.includes(name)))
    throw new Error('Every declared secret must be included in adapter_env');
  validateOrigins(plan.deployment);
}

function validateReport(report) {
  if (!validateReportSchema(report)) throw schemaError('Acceptance report', validateReportSchema);
  exactSet(
    report.checks.map((check) => check.id),
    checkIds,
    'Acceptance checks',
  );
  exactSet(
    report.deployment.components.map((component) => component.kind),
    componentKinds,
    'Deployment components',
  );
  if (report.deployment.runtime_identity_label === report.deployment.storage_administrator_label)
    throw new Error('Runtime and storage administrator labels must differ');
  const anchor = report.deployment.components.find((component) => component.kind === 'anchor');
  if (anchor.identity_label !== report.deployment.runtime_identity_label)
    throw new Error('Anchor component identity must match the runtime identity');
  validateOrigins(report.deployment);
  for (const check of report.checks) {
    if (check.status !== 'passed') continue;
    if (check.assertions.length === 0 || check.assertions.some((assertion) => !assertion.passed))
      throw new Error(`Passing check ${check.id} must contain only passing assertions`);
    if (check.evidence.length === 0)
      throw new Error(`Passing check ${check.id} must contain an evidence digest`);
  }
  const counts = Object.fromEntries(
    ['passed', 'failed', 'blocked', 'unrun'].map((status) => [
      status,
      report.checks.filter((check) => check.status === status).length,
    ]),
  );
  for (const [status, count] of Object.entries(counts))
    if (report.summary[status] !== count)
      throw new Error(`Acceptance summary has the wrong ${status} count`);
  if (
    report.summary.accepted !==
    (!report.source.dirty &&
      report.deployment.independent_administration_asserted &&
      counts.passed === checkIds.length)
  )
    throw new Error('Acceptance summary has the wrong accepted value');
}

function adapterEnvironment(names) {
  const selected = {};
  for (const name of new Set(['PATH', ...names]))
    if (process.env[name] !== undefined) selected[name] = process.env[name];
  return selected;
}

function redactor(secretNames, environment) {
  const declaredSecretValues = secretNames
    .map((name) => environment[name])
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (declaredSecretValues.some((value) => value.length < 4))
    throw new Error('Declared acceptance secrets must contain at least four characters');
  const secretValues = [
    ...new Set(
      [
        ...Object.keys(environment)
          .filter((name) => automaticSecretName.test(name))
          .map((name) => environment[name]),
        ...declaredSecretValues,
      ].filter((value) => typeof value === 'string' && value.length >= 4),
    ),
  ].sort((left, right) => right.length - left.length);
  let count = 0;
  const replace = (input, expression, replacement) =>
    input.replace(expression, (...match) => {
      count++;
      return typeof replacement === 'function' ? replacement(...match) : replacement;
    });
  const text = (input) => {
    let output = input;
    output = replace(
      output,
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    );
    output = replace(
      output,
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      '[REDACTED AUTHORIZATION]',
    );
    output = replace(
      output,
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[REDACTED TOKEN]',
    );
    for (const secret of secretValues) {
      if (!output.includes(secret)) continue;
      count += output.split(secret).length - 1;
      output = output.split(secret).join('[REDACTED]');
    }
    output = replace(
      output,
      /\b(AccountKey|SharedAccessSignature)=([^;\s]+)/gi,
      (_match, name) => `${name}=[REDACTED]`,
    );
    output = replace(
      output,
      /([?&](?:code|sig|secret|password|token|client_secret|access_token|refresh_token)=)[^&#\s]+/gi,
      (_match, prefix) => `${prefix}[REDACTED]`,
    );
    output = replace(
      output,
      /\b(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi,
      (_match, prefix) => `${prefix}[REDACTED]@`,
    );
    return output;
  };
  const value = (input, key = '') => {
    if (automaticSecretName.test(key)) {
      count++;
      return '[REDACTED]';
    }
    if (typeof input === 'string') return text(input);
    if (Array.isArray(input)) return input.map((item) => value(item));
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input).map(([name, item]) => [name, value(item, name)]),
      );
    return input;
  };
  return {
    value,
    text,
    get count() {
      return count;
    },
    secretValues,
  };
}

function run(command, timeoutMs, environment) {
  return new Promise((resolveRun) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exceeded = false;
    let timedOut = false;
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength <= maximumDocumentBytes) return next;
      exceeded = true;
      child.kill('SIGKILL');
      return next.subarray(0, maximumDocumentBytes);
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr, error, exceeded, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, exceeded, timedOut });
    });
  });
}

async function sourceState() {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD'], { cwd: root }),
    exec('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root }),
  ]);
  return { commit: commit.trim(), dirty: status.trim().length > 0 };
}

async function checkResult(check, redact, environment) {
  const started = new Date().toISOString();
  if (check.command === null) {
    return {
      id: check.id,
      status: 'unrun',
      summary: redact.text(check.unrun_reason),
      started_at: started,
      completed_at: new Date().toISOString(),
      assertions: [],
      evidence: [],
      facts: {},
    };
  }
  if (redact.secretValues.some((secret) => check.command.some((part) => part.includes(secret))))
    throw new Error(`Acceptance command for ${check.id} contains a secret value`);
  const outcome = await run(check.command, check.timeout_ms, {
    ...environment,
    HAIP_ACCEPTANCE_CHECK_ID: check.id,
  });
  const completed = new Date().toISOString();
  const failure = (diagnostic) => ({
    id: check.id,
    status: 'failed',
    summary: 'The acceptance adapter did not return a passing result.',
    started_at: started,
    completed_at: completed,
    assertions: [],
    evidence: [],
    facts: {},
    diagnostic: redact.text(diagnostic).slice(0, 4096),
  });
  if (outcome.timedOut) return failure(`Adapter exceeded ${check.timeout_ms} ms`);
  if (outcome.exceeded) return failure('Adapter output exceeded 1 MiB');
  if (outcome.error) return failure(`Adapter could not start: ${outcome.error.message}`);
  if (outcome.code !== 0)
    return failure(
      `Adapter exited with code ${outcome.code}${outcome.stderr.length ? `: ${outcome.stderr.toString('utf8')}` : ''}`,
    );
  let adapter;
  try {
    adapter = JSON.parse(outcome.stdout.toString('utf8'));
  } catch {
    return failure('Adapter stdout was not one JSON document');
  }
  if (!validateAdapterSchema(adapter))
    return failure(schemaError('Adapter result', validateAdapterSchema).message);
  const safe = redact.value(adapter);
  if (!validateAdapterSchema(safe)) return failure('Redaction made the adapter result invalid');
  if (
    safe.status === 'passed' &&
    (safe.assertions.length === 0 || safe.assertions.some((assertion) => !assertion.passed))
  )
    return failure('A passing adapter must contain only passing assertions');
  if (safe.status === 'passed' && safe.evidence.length === 0)
    return failure('A passing adapter must contain an evidence digest');
  return {
    id: check.id,
    ...safe,
    started_at: started,
    completed_at: completed,
  };
}

async function writeReport(path, report) {
  const body = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  if (body.byteLength > maximumDocumentBytes) throw new Error('Acceptance report exceeds 1 MiB');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--validate' && args.length === 2) {
    const report = await document(resolve(args[1]));
    validateReport(report);
    console.log(JSON.stringify({ valid: true, accepted: report.summary.accepted }));
    return;
  }
  const options = new Set(args.filter((argument) => argument.startsWith('--')));
  const positional = args.filter((argument) => !argument.startsWith('--'));
  if (
    positional.length !== 2 ||
    [...options].some((option) => !['--allow-dirty', '--allow-incomplete'].includes(option))
  ) {
    usage();
    process.exitCode = 64;
    return;
  }
  const plan = await document(resolve(positional[0]));
  validatePlan(plan);
  const requestedOutput = resolve(positional[1]);
  const outputPath = resolve(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  if (within(root, outputPath)) throw new Error('Acceptance report must be outside the repository');
  const source = await sourceState();
  if (source.commit !== plan.source.commit)
    throw new Error(
      `Plan expects source commit ${plan.source.commit}, current source is ${source.commit}`,
    );
  if (source.dirty && plan.source.require_clean && !options.has('--allow-dirty'))
    throw new Error('Source tree is dirty');
  const environment = adapterEnvironment(plan.adapter_env);
  const redact = redactor(plan.secret_env, environment);
  const checks = [];
  for (const check of plan.checks) checks.push(await checkResult(check, redact, environment));
  const completedSource = await sourceState();
  if (completedSource.commit !== source.commit)
    throw new Error(`Source commit changed during acceptance from ${source.commit}`);
  source.dirty ||= completedSource.dirty;
  const deployment = redact.value(plan.deployment);
  const summary = Object.fromEntries(
    ['passed', 'failed', 'blocked', 'unrun'].map((status) => [
      status,
      checks.filter((check) => check.status === status).length,
    ]),
  );
  summary.accepted =
    !source.dirty &&
    deployment.independent_administration_asserted &&
    summary.passed === checkIds.length;
  const report = {
    document_type: 'report',
    schema_version: plan.schema_version,
    generated_at: new Date().toISOString(),
    source,
    deployment,
    adapter_env: Object.keys(environment).sort(),
    checks,
    summary,
    redactions: { count: redact.count },
  };
  validateReport(report);
  const digest = await writeReport(outputPath, report);
  console.log(JSON.stringify({ digest, accepted: summary.accepted }));
  if (!summary.accepted && !options.has('--allow-incomplete')) process.exitCode = 2;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Acceptance runner failed');
  process.exitCode = 1;
});
