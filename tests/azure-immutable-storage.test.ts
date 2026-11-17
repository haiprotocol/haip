import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { canonicalise } from '@haip/protocol/crypto';
import {
  collectImmutableStorage,
  runImmutableStorage,
} from '../deployment/adapters/azure-immutable-storage.mjs';
import { sha256 } from '../deployment/adapters/evidence.mjs';
import { azureFixture } from './fixtures/azure-acceptance.js';

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
