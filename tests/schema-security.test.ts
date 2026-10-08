import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from '@haip/protocol/crypto';
import { validateResponseSchema } from '../haip-server/src/validation.js';
import { RESPONSE_SCHEMA_PROFILE } from '../haip-server/src/schema-worker.js';
import { environment } from './environment.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uniqueObjects = {
  type: 'array',
  uniqueItems: true,
  items: {
    type: 'object',
    properties: { value: { type: 'integer' } },
    required: ['value'],
    additionalProperties: false,
  },
};
const expensiveSchema = { allOf: Array.from({ length: 8 }, () => uniqueObjects) };
const expensiveResponse = () => Array.from({ length: 16000 }, (_, value) => ({ value }));
function repeatedReferences(levels: number) {
  const definitions: Record<string, unknown> = { level0: { type: 'string' } };
  for (let level = 1; level <= levels; level++)
    definitions['level' + level] = {
      allOf: Array.from({ length: 3 }, () => ({ $ref: '#/$defs/level' + (level - 1) })),
    };
  return { $defs: definitions, $ref: '#/$defs/level' + levels };
}

test('small schemas with exponentially repeated local references are refused before compilation', async () => {
  const schema = repeatedReferences(12);
  assert(Buffer.byteLength(JSON.stringify(schema)) < 2000);
  const started = Date.now();
  await assert.rejects(validateResponseSchema(schema), { status: 400, code: 'schema_complexity' });
  assert(Date.now() - started < RESPONSE_SCHEMA_PROFILE.timeoutMs);
  await validateResponseSchema(repeatedReferences(3), 'shared references work', true);
  await assert.rejects(validateResponseSchema(repeatedReferences(3), 17, true), {
    status: 400,
    code: 'response_schema_mismatch',
  });
});

test('local recursive data schemas work and references which consume no response depth are refused', async () => {
  const schema = {
    $defs: {
      node: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: { value: { type: 'integer' }, next: { $ref: '#/$defs/node' } },
            required: ['value', 'next'],
            additionalProperties: false,
          },
        ],
      },
    },
    $ref: '#/$defs/node',
  };
  await validateResponseSchema(schema, { value: 1, next: { value: 2, next: null } }, true);
  await assert.rejects(validateResponseSchema(schema, { value: 1, next: false }, true), {
    status: 400,
    code: 'response_schema_mismatch',
  });
  await assert.rejects(
    validateResponseSchema({ $defs: { cycle: { $ref: '#/$defs/cycle' } }, $ref: '#/$defs/cycle' }),
    { status: 400, code: 'schema_reference_cycle' },
  );
  const duplicatedRecursive = {
    $defs: {
      node: {
        type: 'object',
        allOf: Array.from({ length: 2 }, () => ({
          properties: { next: { $ref: '#/$defs/node' } },
        })),
      },
    },
    $ref: '#/$defs/node',
  };
  await assert.rejects(validateResponseSchema(duplicatedRecursive), {
    status: 400,
    code: 'schema_complexity',
  });
});

test('schema maps and literal values keep their user field names while unsupported executable keywords are refused', async () => {
  const schema = {
    type: 'object',
    properties: {
      format: { type: 'string' },
      $ref: { const: { pattern: 'literal', $id: 'literal' } },
      'a/b~c': { type: 'integer' },
      copy: { $ref: '#/properties/a~1b~0c' },
    },
    required: ['format', '$ref', 'copy'],
    additionalProperties: false,
  };
  await validateResponseSchema(
    schema,
    { format: 'literal', $ref: { pattern: 'literal', $id: 'literal' }, copy: 1 },
    true,
  );
  for (const [input, code] of [
    [{ type: 'string', pattern: '(a+)+$' }, 'unsupported_schema_keyword'],
    [{ type: 'string', format: 'email' }, 'unsupported_schema_keyword'],
    [{ $ref: 'https://example.invalid/schema' }, 'remote_schema_reference'],
    [{ $ref: '#/$defs/missing' }, 'invalid_response_schema'],
    [{ $dynamicRef: '#node' }, 'unsupported_schema_reference'],
  ] as const)
    await assert.rejects(validateResponseSchema(input), { status: 400, code });
});

test('quadratic response validation is terminated and the worker queue stays bounded', async () => {
  await assert.rejects(
    validateResponseSchema({ const: 'x'.repeat(RESPONSE_SCHEMA_PROFILE.jobBytes) }),
    { status: 413, code: 'schema_validation_too_large' },
  );
  await validateResponseSchema(expensiveSchema);
  let turns = 0;
  const heartbeat = setInterval(() => turns++, 20);
  try {
    const response = expensiveResponse();
    const started = Date.now();
    const count = RESPONSE_SCHEMA_PROFILE.workers + RESPONSE_SCHEMA_PROFILE.queued;
    const jobs = Array.from({ length: count }, () =>
      validateResponseSchema(expensiveSchema, response, true).then(
        () => 'accepted',
        (error: { code: string }) => error.code,
      ),
    );
    await assert.rejects(validateResponseSchema({ type: 'string' }, 'queued', true), {
      status: 503,
      code: 'schema_validation_busy',
    });
    const results = await Promise.all(jobs);
    assert(results.includes('schema_validation_timeout'));
    assert(
      results.every(
        (code) => code === 'schema_validation_timeout' || code === 'schema_validation_busy',
      ),
    );
    assert(Date.now() - started < RESPONSE_SCHEMA_PROFILE.timeoutMs + 1000);
    assert(turns >= 10, 'the parent event loop continues while workers validate');
    await validateResponseSchema({ type: 'string' }, 'worker slots recovered', true);
  } finally {
    clearInterval(heartbeat);
  }
});

test('production-built validation starts its emitted worker without a TypeScript loader', async () => {
  const script = `import { validateResponseSchema } from ${JSON.stringify(new URL('../haip-server/dist/validation.js', import.meta.url).href)}; await validateResponseSchema({type:'string'}, 'built worker', true); console.log('worker passed');`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { timeout: 5000 },
  );
  assert.equal(result.stdout.trim(), 'worker passed');
});

test('process heap flags cannot silently replace the worker memory bound', async () => {
  const script = `import { validateResponseSchema } from ${JSON.stringify(new URL('../haip-server/dist/validation.js', import.meta.url).href)}; try { await validateResponseSchema({type:'string'}, 'configured worker', true); process.exitCode=1; } catch(error) { console.log(JSON.stringify({status:error.status,code:error.code})); }`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      timeout: 5000,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), { status: 503, code: 'schema_worker_configuration' });
});

test('schemas, responses and proposals are frozen before asynchronous validation', async () => {
  const schema = {
    type: 'object',
    properties: { choice: { type: 'string' } },
    required: ['choice'],
  };
  const response = { choice: 'original' };
  const validation = validateResponseSchema(schema, response, true);
  schema.properties.choice.type = 'boolean';
  delete (response as { choice?: string }).choice;
  await validation;
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const p = (
      await env.store.pool.query(
        "SELECT * FROM haip_principals WHERE tenant='test-tenant' AND id='reviewer'",
      )
    ).rows[0];
    const input = { decision: 'answer' as const, response: { choice: 'accept' } };
    const pending = env.service.propose(p, created.body.request.id, input, 'proposal-snapshot');
    input.response.choice = 'decline';
    const candidate = await pending;
    assert.deepEqual(candidate.response, { choice: 'accept' });
    assert.equal(candidate.response_digest, digest({ choice: 'accept' }));
  } finally {
    await env.close();
  }
});

test('candidate idempotency remains available while schema workers are busy', async () => {
  const env = await environment();
  try {
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const human = await env.login();
    const path = `/v2/requests/${created.body.request.id}/candidates`;
    const input = { decision: 'answer', response: { choice: 'accept' } };
    const headers = { 'Idempotency-Key': 'candidate-replay' };
    const first = await human.call(path, input, headers);
    assert.equal(first.status, 201);
    const response = expensiveResponse();
    const jobs = Array.from(
      { length: RESPONSE_SCHEMA_PROFILE.workers + RESPONSE_SCHEMA_PROFILE.queued },
      () => validateResponseSchema(expensiveSchema, response, true).catch(() => undefined),
    );
    try {
      const replay = await human.call(path, input, headers);
      assert.equal(replay.status, 201);
      assert.deepEqual(replay.body, first.body);
      const changed = await human.call(
        path,
        { decision: 'answer', response: { choice: 17 } },
        headers,
      );
      assert.equal(changed.status, 409);
      assert.equal(changed.body.error, 'idempotency_conflict');
    } finally {
      await Promise.all(jobs);
    }
  } finally {
    await env.close();
  }
});

test('slow response validation leaves health and confirmation available and creates no late candidate', async () => {
  const env = await environment();
  try {
    const costly = await env.api(
      '/v2/requests',
      env.request(false, { response_schema: expensiveSchema }),
    );
    assert.equal(costly.status, 201, JSON.stringify(costly.body));
    const normal = await env.api('/v2/requests', env.request());
    assert.equal(normal.status, 201);
    const human = await env.login();
    const candidate = await human.call(`/v2/requests/${normal.body.request.id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    assert.equal(candidate.status, 201);
    const key = 'timed-out-schema-response';
    const slow = human.call(
      `/v2/requests/${costly.body.request.id}/candidates`,
      { decision: 'answer', response: expensiveResponse() },
      { 'Idempotency-Key': key },
    );
    await pause(100);
    const started = Date.now();
    const [health, confirmation] = await Promise.all([
      fetch(env.origin + '/health'),
      human.call(`/v2/requests/${normal.body.request.id}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      }),
    ]);
    assert.equal(health.status, 200);
    assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
    assert(
      Date.now() - started < 1000,
      'schema validation holds no tenant write lock and does not stop HTTP handlers',
    );
    const rejected = await slow;
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error, 'schema_validation_timeout');
    await pause(100);
    const material = await human.call(`/v2/requests/${costly.body.request.id}/material`);
    assert.equal(material.body.candidate, null);
    const retry = await human.call(
      `/v2/requests/${costly.body.request.id}/candidates`,
      { decision: 'answer', response: [{ value: 1 }] },
      { 'Idempotency-Key': key },
    );
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
  } finally {
    await env.close();
  }
});

test('the locked candidate commit rechecks the exact schema after validation', async () => {
  const env = await environment();
  const lock = await env.store.pool.connect();
  try {
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const id = created.body.request.id;
    const human = await env.login();
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['test-tenant']);
    const pending = human.call(`/v2/requests/${id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting =
        (
          await env.store.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1",
          )
        ).rowCount! > 0;
      if (!waiting) await pause(10);
    }
    assert(waiting, 'validation completes before the candidate waits for the tenant lock');
    const row = (
      await lock.query('SELECT data,material FROM haip_requests WHERE tenant=$1 AND id=$2', [
        'test-tenant',
        id,
      ])
    ).rows[0];
    row.material.response_schema = { type: 'boolean' };
    row.data.request.review.response_schema_digest = digest(row.material.response_schema);
    row.data.request_digest = digest(row.data.request);
    await lock.query('UPDATE haip_requests SET data=$3,material=$4 WHERE tenant=$1 AND id=$2', [
      'test-tenant',
      id,
      JSON.stringify(row.data),
      JSON.stringify(row.material),
    ]);
    await lock.query('COMMIT');
    const rejected = await pending;
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'material_integrity_mismatch');
    assert.equal((await human.call(`/v2/requests/${id}/material`)).body.candidate, null);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    await env.close();
  }
});

test('cancellation and reviewer identity revocation during validation prevent the candidate commit', async () => {
  const env = await environment();
  try {
    const human = await env.login();
    for (const change of ['cancel', 'identity'] as const) {
      const created = await env.api('/v2/requests', env.request());
      assert.equal(created.status, 201);
      const id = created.body.request.id;
      const lock = await env.store.pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['test-tenant']);
        const changed =
          change === 'cancel'
            ? env.api(`/v2/requests/${id}/cancel`, {})
            : env.principal('reviewer', 'human', {
                enabled: true,
                identity_certain: false,
                oidc_issuer: env.service.config.oidc.issuer,
                oidc_subject: 'reviewer',
              });
        const waits = async (count: number) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const waiting = (
              await env.store.pool.query(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%'",
              )
            ).rows[0].count;
            if (Number(waiting) >= count) return;
            await pause(10);
          }
          assert.fail('public transactions did not reach the tenant lock');
        };
        await waits(1);
        const proposal = human.call(`/v2/requests/${id}/candidates`, {
          decision: 'answer',
          response: { choice: 'accept' },
        });
        await waits(2);
        await lock.query('COMMIT');
        await changed;
        const rejected = await proposal;
        assert.equal(rejected.status, change === 'cancel' ? 409 : 503);
        assert.equal(
          rejected.body.error,
          change === 'cancel' ? 'request_not_pending' : 'identity_uncertain',
        );
        const stored = (
          await env.store.pool.query('SELECT data FROM haip_requests WHERE tenant=$1 AND id=$2', [
            'test-tenant',
            id,
          ])
        ).rows[0];
        assert.equal(stored.data.candidate, undefined);
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
    }
  } finally {
    await env.close();
  }
});

test('review expiry is checked after validation and waiting for the tenant lock', async () => {
  const env = await environment();
  const lock = await env.store.pool.connect();
  try {
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: { ...env.route.limits, review_seconds: 2 },
    });
    const human = await env.login();
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const id = created.body.request.id;
    const deadline = Date.parse(created.body.request.review_deadline);
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['test-tenant']);
    const pending = human.call(`/v2/requests/${id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept' },
    });
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting =
        (
          await env.store.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1",
          )
        ).rowCount! > 0;
      if (!waiting) await pause(10);
    }
    assert(waiting);
    await pause(Math.max(0, deadline - Date.now() + 30));
    await lock.query('COMMIT');
    const rejected = await pending;
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'request_not_pending');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    await env.close();
  }
});
