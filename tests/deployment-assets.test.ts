import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runner = join(root, 'deployment/run-acceptance.mjs');
const sample = join(root, 'deployment/acceptance.plan.example.json');

async function sourceCommit() {
  return (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
}

async function plan() {
  const input = JSON.parse(await readFile(sample, 'utf8'));
  input.source.commit = await sourceCommit();
  return input;
}

test('acceptance reports mask secrets, retain safe facts and refuse an incomplete result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haip-deployment-acceptance-'));
  try {
    const input = await plan();
    const secret = 'deployment-secret-value';
    input.adapter_env.push('HAIP_TEST_SECRET');
    input.secret_env.push('HAIP_TEST_SECRET');
    input.checks[0].command = [
      process.execPath,
      '-e',
      `const secret=process.env.HAIP_TEST_SECRET;process.stdout.write(JSON.stringify({status:'passed',summary:'Bearer '+secret,assertions:[{name:'secret_masked',passed:true,detail:'postgresql://user:'+secret+'@db.example/haip?token='+secret}],evidence:[{name:'fixture',digest:'sha256:'+'1'.repeat(64),recorded_at:new Date().toISOString(),reference:'https://evidence.example/?sig='+secret}],facts:{token_rejected:true,unrelated_secret_present:Object.hasOwn(process.env,'HAIP_UNRELATED_SECRET'),client_secret:secret}}))`,
    ];
    delete input.checks[0].unrun_reason;
    input.checks[1].command = [
      process.execPath,
      '-e',
      `console.error('AccountKey='+process.env.HAIP_TEST_SECRET);process.exit(3)`,
    ];
    delete input.checks[1].unrun_reason;
    const planPath = join(directory, 'plan.json');
    const reportPath = join(directory, 'report.json');
    await writeFile(planPath, JSON.stringify(input));
    await execute(
      process.execPath,
      [runner, planPath, reportPath, '--allow-dirty', '--allow-incomplete'],
      {
        cwd: root,
        env: {
          ...process.env,
          HAIP_TEST_SECRET: secret,
          HAIP_UNRELATED_SECRET: 'must-not-reach-adapter',
        },
      },
    );
    const body = await readFile(reportPath, 'utf8');
    const report = JSON.parse(body);
    assert.doesNotMatch(body, new RegExp(secret));
    assert.equal(report.checks[0].status, 'passed');
    assert.equal(report.checks[0].summary, '[REDACTED AUTHORIZATION]');
    assert.equal(report.checks[0].facts.token_rejected, true);
    assert.equal(report.checks[0].facts.unrelated_secret_present, false);
    assert.equal(report.checks[0].facts.client_secret, '[REDACTED]');
    assert.equal(report.adapter_env.includes('HAIP_TEST_SECRET'), true);
    assert.equal(report.adapter_env.includes('HAIP_UNRELATED_SECRET'), false);
    assert.equal(report.checks[1].status, 'failed');
    assert.match(report.checks[1].diagnostic, /AccountKey=\[REDACTED\]/);
    assert.deepEqual(report.summary, {
      passed: 1,
      failed: 1,
      blocked: 0,
      unrun: 8,
      accepted: false,
    });
    assert.ok(report.redactions.count >= 6);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    const validated = await execute(process.execPath, [runner, '--validate', reportPath], {
      cwd: root,
    });
    assert.deepEqual(JSON.parse(validated.stdout), { valid: true, accepted: false });
    const contradictoryReport = structuredClone(report);
    contradictoryReport.checks[0].assertions[0].passed = false;
    const contradictoryPath = join(directory, 'contradictory-report.json');
    await writeFile(contradictoryPath, JSON.stringify(contradictoryReport));
    await assert.rejects(
      execute(process.execPath, [runner, '--validate', contradictoryPath], { cwd: root }),
      /does not match acceptance.schema.json|only passing assertions/,
    );
    const unassertedReport = structuredClone(report);
    unassertedReport.source.dirty = false;
    unassertedReport.checks = unassertedReport.checks.map((check: any) => ({
      ...structuredClone(unassertedReport.checks[0]),
      id: check.id,
    }));
    unassertedReport.summary = {
      passed: 10,
      failed: 0,
      blocked: 0,
      unrun: 0,
      accepted: true,
    };
    const unassertedPath = join(directory, 'unasserted-report.json');
    await writeFile(unassertedPath, JSON.stringify(unassertedReport));
    await assert.rejects(
      execute(process.execPath, [runner, '--validate', unassertedPath], { cwd: root }),
      /wrong accepted value/,
    );
    report.summary.accepted = true;
    const invalidReport = join(directory, 'invalid-report.json');
    await writeFile(invalidReport, JSON.stringify(report));
    await assert.rejects(
      execute(process.execPath, [runner, '--validate', invalidReport], { cwd: root }),
      /wrong accepted value/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('acceptance plans require each check and deployment component once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haip-deployment-plan-'));
  try {
    const duplicateCheck = await plan();
    duplicateCheck.checks[9].id = duplicateCheck.checks[0].id;
    const duplicatePath = join(directory, 'duplicate.json');
    await writeFile(duplicatePath, JSON.stringify(duplicateCheck));
    await assert.rejects(
      execute(
        process.execPath,
        [runner, duplicatePath, join(directory, 'duplicate-report.json'), '--allow-dirty'],
        { cwd: root },
      ),
      /each required value exactly once/,
    );
    const sameSite = await plan();
    sameSite.deployment.sandbox_origin_pattern = 'https://{scope}.example.com';
    const sameSitePath = join(directory, 'same-site.json');
    await writeFile(sameSitePath, JSON.stringify(sameSite));
    await assert.rejects(
      execute(
        process.execPath,
        [runner, sameSitePath, join(directory, 'same-site-report.json'), '--allow-dirty'],
        { cwd: root },
      ),
      /distinct registrable sites/,
    );
    const repositoryPlan = await plan();
    const repositoryPlanPath = join(directory, 'repository-output.json');
    await writeFile(repositoryPlanPath, JSON.stringify(repositoryPlan));
    const repositoryOutput = join(root, 'deployment', 'acceptance-test-report.json');
    await assert.rejects(
      execute(
        process.execPath,
        [runner, repositoryPlanPath, repositoryOutput, '--allow-dirty', '--allow-incomplete'],
        { cwd: root },
      ),
      /outside the repository/,
    );
    const shortSecret = await plan();
    const shortSecretPath = join(directory, 'short-secret.json');
    shortSecret.adapter_env.push('HAIP_SHORT_SECRET');
    shortSecret.secret_env.push('HAIP_SHORT_SECRET');
    await writeFile(shortSecretPath, JSON.stringify(shortSecret));
    await assert.rejects(
      execute(
        process.execPath,
        [runner, shortSecretPath, join(directory, 'short-secret-report.json'), '--allow-dirty'],
        { cwd: root, env: { ...process.env, HAIP_SHORT_SECRET: 'abc' } },
      ),
      /at least four characters/,
    );
    const undeclaredSecret = await plan();
    undeclaredSecret.secret_env.push('HAIP_UNDECLARED_SECRET');
    const undeclaredSecretPath = join(directory, 'undeclared-secret.json');
    await writeFile(undeclaredSecretPath, JSON.stringify(undeclaredSecret));
    await assert.rejects(
      execute(
        process.execPath,
        [
          runner,
          undeclaredSecretPath,
          join(directory, 'undeclared-secret-report.json'),
          '--allow-dirty',
        ],
        { cwd: root },
      ),
      /Every declared secret must be included in adapter_env/,
    );
    const wrongRevision = await plan();
    wrongRevision.deployment.protocol_revision = '2.0.0-draft.2';
    const wrongRevisionPath = join(directory, 'wrong-revision.json');
    await writeFile(wrongRevisionPath, JSON.stringify(wrongRevision));
    await assert.rejects(
      execute(
        process.execPath,
        [runner, wrongRevisionPath, join(directory, 'wrong-revision-report.json'), '--allow-dirty'],
        { cwd: root },
      ),
      /must be equal to constant/,
    );
    const wrongIdentity = await plan();
    wrongIdentity.deployment.components.find(
      (component: any) => component.kind === 'anchor',
    ).identity_label = 'another-runtime';
    const wrongIdentityPath = join(directory, 'wrong-identity.json');
    await writeFile(wrongIdentityPath, JSON.stringify(wrongIdentity));
    await assert.rejects(
      execute(
        process.execPath,
        [runner, wrongIdentityPath, join(directory, 'wrong-identity-report.json'), '--allow-dirty'],
        { cwd: root },
      ),
      /Anchor component identity must match the runtime identity/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Azure and Caddy templates preserve the deployment boundaries', async () => {
  const bicep = await readFile(join(root, 'deployment/azure/main.bicep'), 'utf8');
  const anchor = await readFile(join(root, 'haip-server/src/anchor.ts'), 'utf8');
  assert.match(bicep, /allowSharedKeyAccess: false/);
  assert.match(bicep, /defaultToOAuthAuthentication: true/);
  assert.match(bicep, /isHnsEnabled: false/);
  assert.match(bicep, /isVersioningEnabled: true/);
  assert.equal((bicep.match(/immutableStorageWithVersioning:/g) ?? []).length, 1);
  const checkpointContainer = bicep.match(
    /resource checkpointEvidenceContainer[\s\S]*?\n}\n\nresource checkpointRetention/,
  )?.[0];
  const safetyContainer = bicep.match(
    /resource safetyEvidenceContainer[\s\S]*?\n}\n\nresource safetyRetention/,
  )?.[0];
  assert.ok(checkpointContainer);
  assert.ok(safetyContainer);
  assert.match(checkpointContainer, /immutableStorageWithVersioning:/);
  assert.doesNotMatch(safetyContainer, /immutableStorageWithVersioning:/);
  assert.equal((bicep.match(/immutabilityPeriodSinceCreationInDays: 90/g) ?? []).length, 2);
  assert.match(bicep, /defaultAction: 'Deny'/);
  assert.match(bicep, /param checkpointContainerName string = 'haip-checkpoints'/);
  assert.match(bicep, /param safetyContainerName string = 'haip-safety'/);
  assert.match(bicep, /scope: checkpointEvidenceContainer/);
  assert.match(bicep, /scope: safetyEvidenceContainer/);
  assert.match(bicep, /output accountUrl string = storage\.properties\.primaryEndpoints\.blob/);
  const actions = bicep.match(/dataActions: \[([\s\S]*?)\n\s*\]/)?.[1];
  assert.ok(actions);
  assert.match(actions, /containers\/blobs\/read/);
  assert.match(actions, /containers\/blobs\/add\/action/);
  assert.doesNotMatch(actions, /\/write|delete|runAsSuperUser|containers\/write/);
  assert.match(bicep, /notDataActions: \[\]/);
  assert.doesNotMatch(anchor, /immutabilityPolicy:/);
  assert.doesNotMatch(anchor, /legalHold: true/);
  assert.match(anchor, /properties\.immutabilityPolicyMode === 'Locked'/);
  assert.match(anchor, /properties\.legalHold === true/);
  assert.doesNotMatch(actions, /immutableStorage\/runAsSuperUser\/action/);
  const caddy = await readFile(join(root, 'deployment/Caddyfile'), 'utf8');
  assert.match(caddy, /\{\$HAIP_TRUSTED_HOST\}/);
  assert.match(caddy, /\*\.\{\$HAIP_SANDBOX_SITE\}/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:\{\$PORT:8080\}/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:\{\$HAIP_SANDBOX_PORT:8081\}/);
  assert.equal((caddy.match(/header_up Host \{host\}/g) ?? []).length, 2);
  assert.match(caddy, /frame-ancestors https:\/\/\{\$HAIP_TRUSTED_HOST\}/);
  assert.doesNotMatch(caddy, /reverse_proxy (?!127\.0\.0\.1)/);
});
