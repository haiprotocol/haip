import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { environment } from './environment.js';

const directory = fileURLToPath(new URL('../conformance/python/', import.meta.url));
const script = directory + 'haip_conformance.py';
const vectorPath = directory + 'draft-3-vectors.json';

function canonicalise(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalise).join(',') + ']';
  assert.equal(typeof value, 'object');
  return (
    '{' +
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => canonicalise(key) + ':' + canonicalise((value as Record<string, unknown>)[key]))
      .join(',') +
    '}'
  );
}

function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalise(value)).digest('hex');
}

async function pythonProcess(args: string[], input?: unknown) {
  const child = spawn(process.env.HAIP_TEST_PYTHON ?? 'python3', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  if (input === undefined) child.stdin.end();
  else child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

async function python(command: string, input?: unknown, path?: string): Promise<any> {
  const result = await pythonProcess([script, command, ...(path ? [path] : [])], input);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function pythonFailure(command: string, input: unknown): Promise<string> {
  const result = await pythonProcess([script, command], input);
  assert.notEqual(result.code, 0, result.stdout);
  return result.stderr;
}

async function requestBindingFailure(input: unknown): Promise<string> {
  const source = [
    'import importlib.util,json,sys',
    "spec=importlib.util.spec_from_file_location('haip_conformance',sys.argv[1])",
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'value=json.load(sys.stdin)',
    'try:',
    ' module._verify_execution_request(value["config"],value["request"])',
    'except module.ConformanceError as error:',
    ' print(str(error))',
    ' raise SystemExit(0)',
    'raise SystemExit(1)',
  ].join('\n');
  const result = await pythonProcess(['-c', source, script], input);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function recordVerificationFailure(input: unknown): Promise<string> {
  const source = [
    'import importlib.util,json,sys',
    "spec=importlib.util.spec_from_file_location('haip_conformance',sys.argv[1])",
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'value=json.load(sys.stdin)',
    'try:',
    ' module.verify_record(value["record"],value["trust"],value["expected"])',
    'except module.ConformanceError as error:',
    ' print(str(error))',
    ' raise SystemExit(0)',
    'raise SystemExit(1)',
  ].join('\n');
  const result = await pythonProcess(['-c', source, script], input);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function encodedRequestPath(requestId: string): Promise<string> {
  const source = [
    'import importlib.util,sys',
    "spec=importlib.util.spec_from_file_location('haip_conformance',sys.argv[1])",
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(module._request_path(sys.argv[2]))',
  ].join('\n');
  const result = await pythonProcess(['-c', source, script, requestId]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('Python refuses bearer credentials over non-loopback HTTP', async () => {
  const error = await pythonFailure('review-start', {
    origin: 'http://localhost.attacker.example',
    producer_token: 'test-token',
    route: 'review',
  });
  assert.match(error, /HAIP requires HTTPS outside exact loopback hosts/);
  assert.equal(
    await encodedRequestPath('tenant/request:1@producer'),
    '/v2/requests/tenant%2Frequest%3A1%40producer',
  );
});

test('Python verifies the frozen draft-3 wire and tamper vectors without HAIP packages', async () => {
  const [source, fixtureText, schemaText] = await Promise.all([
    readFile(script, 'utf8'),
    readFile(vectorPath, 'utf8'),
    readFile(new URL('../protocol/draft-2.0.0-3/schema.json', import.meta.url), 'utf8'),
  ]);
  assert.equal(source.includes('@haip/'), false);
  const fixture = JSON.parse(fixtureText);
  const schema = JSON.parse(schemaText);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
    ownProperties: true,
  });
  (addFormats as unknown as (value: Ajv2020) => void)(ajv);
  ajv.addSchema(schema);
  for (const vector of fixture.vectors) {
    const check = ajv.getSchema(schema.$id + '#/$defs/' + vector.schema)!;
    assert(check(vector.value), `${vector.name}: ${ajv.errorsText(check.errors)}`);
    if (vector.payload_schema) {
      const payloadCheck = ajv.getSchema(schema.$id + '#/$defs/' + vector.payload_schema)!;
      assert(
        payloadCheck(vector.value.payload),
        `${vector.name} payload: ${ajv.errorsText(payloadCheck.errors)}`,
      );
    }
    assert.equal(canonicalise(vector.value), vector.canonical, vector.name);
    assert.equal(digest(vector.value), vector.digest, vector.name);
    if (vector.expected) {
      const body = canonicalise({
        protected: vector.value.protected,
        payload: vector.value.payload,
      });
      assert(
        verify(
          null,
          Buffer.from(body),
          createPublicKey(fixture.trust.keys[0].public_key),
          Buffer.from(vector.value.signature, 'base64url'),
        ),
        vector.name,
      );
    }
  }
  const receipt = fixture.vectors.find((vector: any) => vector.name === 'receipt');
  const invalidTrust = structuredClone(fixture.trust);
  invalidTrust.keys[0].revoked_at = '';
  assert.equal(
    await recordVerificationFailure({
      record: receipt.value,
      trust: invalidTrust,
      expected: receipt.expected,
    }),
    'Invalid signed-record time',
  );
  assert.deepEqual(await python('vectors', undefined, vectorPath), {
    protocol_revision: '2.0.0-draft.3',
    result: 'passed',
    tamper_cases: 5,
    vectors: 6,
  });
});

test('Python completes a review through public HTTP endpoints and verifies signed output', async () => {
  const env = await environment();
  try {
    const started = await python('review-start', {
      origin: env.origin,
      producer_token: env.credentials.producer,
      route: 'review',
    });
    assert.equal(started.result, 'ready');
    assert.equal(started.review_link, env.origin + '/review/' + started.request_id);
    const stored = await env.api('/v2/requests/' + started.request_id);
    assert.equal(started.request_digest, digest(stored.body.request));
    const human = await env.login();
    const candidate = await human.call(`/v2/requests/${started.request_id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201);
    const candidateDigest = await python('digest', candidate.body);
    const confirmation = await human.call(`/v2/requests/${started.request_id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: candidateDigest.digest,
    });
    assert.equal(confirmation.status, 200);
    const finished = await python('review-finish', {
      origin: env.origin,
      producer_token: env.credentials.producer,
      tenant: 'test-tenant',
      producer: 'producer',
      request_id: started.request_id,
      trust: env.trust,
    });
    assert.deepEqual(finished, {
      execution_authority: false,
      purpose: 'review',
      request_id: started.request_id,
      result: 'passed',
    });
  } finally {
    await env.close();
  }
});

test('Python verifies execution authority and fences one durable SQLite counter effect', async () => {
  const env = await environment();
  const counterDirectory = await mkdtemp(join(tmpdir(), 'haip-python-counter-'));
  try {
    const started = await python('execution-start', {
      origin: env.origin,
      producer_token: env.credentials.producer,
      route: 'review',
    });
    assert.equal(started.result, 'ready');
    const stored = await env.api('/v2/requests/' + started.request_id);
    assert.equal(started.request_digest, digest(stored.body.request));
    assert.equal(started.execution_binding_digest, digest(stored.body.request.execution));
    assert.equal(
      await requestBindingFailure({
        config: {
          request_id: '00000000-0000-0000-0000-000000000000',
          tenant: 'test-tenant',
          producer: 'producer',
        },
        request: stored.body.request,
      }),
      'Execution request binding mismatch',
    );
    const human = await env.login();
    const candidate = await human.call(`/v2/requests/${started.request_id}/candidates`, {
      decision: 'authorise',
      response: { choice: 'authorise' },
    });
    assert.equal(candidate.status, 201);
    const candidateDigest = await python('digest', candidate.body);
    const confirmation = await human.call(`/v2/requests/${started.request_id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: candidateDigest.digest,
    });
    assert.equal(confirmation.status, 200);
    await env.flush();
    const input = {
      origin: env.origin,
      producer_token: env.credentials.producer,
      tenant: 'test-tenant',
      producer: 'producer',
      request_id: started.request_id,
      trust: env.trust,
      database: join(counterDirectory, 'counter.sqlite3'),
      allow_test_filesystem_anchor: true,
    };
    const interrupted = await pythonFailure('execution-finish', {
      ...input,
      test_stop_after_effect_commit: true,
    });
    assert.match(
      interrupted,
      /Stopped after the committed counter effect for a loopback replay test/,
    );
    const discarded = await env.api('/v2/requests/' + started.request_id + '/discard', {});
    assert.equal(discarded.status, 200);
    assert.equal(
      (await env.api('/v2/requests/' + started.request_id + '/export')).body.material,
      null,
    );
    const first = await python('execution-finish', {
      ...input,
      test_stop_after_effect_commit: true,
    });
    assert.equal(first.count, 1);
    assert.equal(first.replayed, true);
    const second = await python('execution-finish', input);
    assert.equal(second.count, 1);
    assert.equal(second.replayed, true);
    assert.equal(second.outcome_digest, first.outcome_digest);
    assert.equal(
      (await env.api('/v2/requests/' + started.request_id)).body.execution_state,
      'completed',
    );
  } finally {
    await env.close();
    await rm(counterDirectory, { recursive: true, force: true });
  }
});
