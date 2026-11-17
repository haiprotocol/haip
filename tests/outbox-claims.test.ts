import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { digest } from '@haip/protocol/crypto';
import { OutboxWorker } from '../haip-server/src/worker.js';
import { environment } from './environment.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation_timeout')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type TestEnvironment = Awaited<ReturnType<typeof environment>>;

async function operator(env: TestEnvironment) {
  return (
    await env.store.pool.query(
      "SELECT * FROM haip_principals WHERE tenant='test-tenant' AND id='operator'",
    )
  ).rows[0];
}

async function appendAudit(env: TestEnvironment, count = 1) {
  const principal = await operator(env);
  return env.store.transaction('test-tenant', async (tx, now) => {
    let sequence = 0;
    for (let ordinal = 0; ordinal < count; ordinal++)
      sequence = await env.service.audit(tx, principal, now, 'ClaimFixture', { ordinal });
    return sequence;
  });
}

async function checkpoint(env: TestEnvironment) {
  const sequence = await appendAudit(env);
  return (
    await env.store.pool.query(
      "UPDATE haip_outbox SET next_at=clock_timestamp() WHERE tenant='test-tenant' AND kind='checkpoint' AND (body->'payload'->>'sequence')::bigint=$1 RETURNING id",
      [sequence],
    )
  ).rows[0].id as string;
}

async function drainSetup(env: TestEnvironment) {
  await env.store.pool.query(
    'UPDATE haip_outbox SET next_at=clock_timestamp() WHERE checkpoint_batch_count IS NOT NULL',
  );
  await env.flush();
}

async function checkpointJobs(env: TestEnvironment) {
  return (
    await env.store.pool.query(
      `SELECT id,body,request_id,state,attempts,created_at,next_at,checkpoint_batch_count
       FROM haip_outbox WHERE tenant='test-tenant' AND kind='checkpoint'
       ORDER BY (body->'payload'->>'sequence')::bigint`,
    )
  ).rows;
}

test('routine events keep their first deadline and publish at one hundred entries', async () => {
  const dispatched: string[] = [];
  const env = await environment({
    singleTenant: true,
    async dispatchOutbox(ids) {
      dispatched.push(...ids);
    },
  });
  try {
    const [original] = await checkpointJobs(env);
    assert.equal(original.next_at.getTime() - original.created_at.getTime(), 300_000);
    assert.equal(original.checkpoint_batch_count, original.body.payload.sequence);
    assert.deepEqual(dispatched, [original.id]);
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const [updated] = await checkpointJobs(env);
    assert.equal(updated.id, original.id);
    assert.deepEqual(updated.next_at, original.next_at);
    assert.equal(updated.checkpoint_batch_count, original.checkpoint_batch_count + 1);
    await appendAudit(env, 99 - updated.checkpoint_batch_count);
    const waiting = await checkpointJobs(env);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].checkpoint_batch_count, 99);
    assert.equal(waiting[0].body.payload.sequence, 99);
    assert.deepEqual(waiting[0].next_at, original.next_at);
    assert.deepEqual(await env.worker.readyJobs(), { ids: [] });
    assert.deepEqual(await env.worker.runJob(original.id), {
      state: 'pending',
      retry_at: original.next_at.toISOString(),
    });
    assert.deepEqual(dispatched, [original.id]);

    await Promise.all([appendAudit(env), appendAudit(env)]);
    const [sealed, following, ...extra] = await checkpointJobs(env);
    assert.equal(extra.length, 0);
    assert.equal(sealed.id, original.id);
    assert.equal(sealed.body.payload.sequence, 100);
    assert.equal(sealed.checkpoint_batch_count, null);
    assert.equal(following.body.payload.sequence, 101);
    assert.equal(following.checkpoint_batch_count, 1);
    assert.deepEqual(dispatched.slice(1).sort(), [sealed.id, following.id].sort());
    assert.deepEqual(await env.worker.readyJobs(), { ids: [sealed.id] });
    assert.deepEqual(await env.worker.runJob(sealed.id), { state: 'settled' });
    const { ledger_id, generation, sequence, head } = sealed.body.payload;
    assert.deepEqual(await env.anchor.history(ledger_id, generation), [{ sequence, head }]);
  } finally {
    await env.close();
  }
});

test('an elapsed checkpoint deadline keeps its signed prefix and survives worker replacement', async () => {
  const env = await environment({ singleTenant: true });
  try {
    const [original] = await checkpointJobs(env);
    const principal = await operator(env);
    await env.store.transaction('test-tenant', async (tx, now) => {
      await tx.query('UPDATE haip_outbox SET next_at=$2 WHERE id=$1', [original.id, now]);
      await env.service.audit(tx, principal, now, 'ClaimFixture', { afterDeadline: true });
    });
    const [elapsed, following, ...extra] = await checkpointJobs(env);
    assert.equal(extra.length, 0);
    assert.equal(elapsed.id, original.id);
    assert.deepEqual(elapsed.body, original.body);
    assert.equal(elapsed.checkpoint_batch_count, null);
    assert.equal(following.body.payload.sequence, original.body.payload.sequence + 1);
    assert.equal(following.checkpoint_batch_count, 1);

    const replacement = new OutboxWorker(env.service, env.anchor);
    await replacement.reconcile();
    assert.deepEqual(await replacement.readyJobs(), { ids: [elapsed.id] });
    assert.deepEqual(await replacement.runJob(elapsed.id), { state: 'settled' });
    await env.store.pool.query('UPDATE haip_outbox SET next_at=clock_timestamp() WHERE id=$1', [
      following.id,
    ]);
    assert.equal(await replacement.tick(), 1);
    const published = await checkpointJobs(env);
    assert(
      published.every((job) => job.state === 'accepted' && job.checkpoint_batch_count === null),
    );
    assert.deepEqual(
      published.map((job) => job.body),
      [original.body, following.body],
    );
  } finally {
    await env.close();
  }
});

test('review and execution confirmations make a separate checkpoint due immediately', async () => {
  const env = await environment({ singleTenant: true });
  try {
    const human = await env.login();
    const confirmations: { id: string; job: string; grant: string; deadline?: string }[] = [];
    for (const execution of [false, true]) {
      const created = await env.api('/v2/requests', env.request(execution));
      assert.equal(created.status, 201);
      const id = created.body.request.id;
      const candidate = await human.call(`/v2/requests/${id}/candidates`, {
        decision: execution ? 'authorise' : 'answer',
        response: { choice: 'accept' },
      });
      assert.equal(candidate.status, 201);
      const receipt = await human.call(`/v2/requests/${id}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      });
      assert.equal(receipt.status, 200);
      const jobs = (await checkpointJobs(env)).filter((job) => job.request_id === id);
      assert.equal(jobs.length, 1);
      const [job] = jobs;
      assert.equal(job.checkpoint_batch_count, null);
      assert.equal(job.next_at.toISOString(), receipt.body.payload.confirmed_at);
      const {
        rows: [event],
      } = await env.store.pool.query(
        "SELECT head,record_digest FROM haip_audit WHERE tenant='test-tenant' AND sequence=$1 AND request_id=$2",
        [job.body.payload.sequence, id],
      );
      assert.equal(event.head, job.body.payload.head);
      assert.equal(event.record_digest, digest(receipt.body));
      const pending = await env.api('/v2/requests/' + id);
      assert.equal(pending.body.audit_state, 'pending');
      assert.equal(pending.body.grant_state, execution ? 'pending_anchor' : 'not_applicable');
      confirmations.push({
        id,
        job: job.id,
        grant: execution ? 'available' : 'not_applicable',
        deadline: receipt.body.payload.grant_deadline,
      });
    }
    assert.deepEqual(
      (await env.worker.readyJobs()).ids.sort(),
      confirmations.map(({ job }) => job).sort(),
    );
    await env.flush();
    for (const confirmation of confirmations) {
      const anchored = await env.api('/v2/requests/' + confirmation.id);
      assert.equal(anchored.body.audit_state, 'anchored');
      assert.equal(anchored.body.grant_state, confirmation.grant);
      assert.equal(anchored.body.receipt.payload.grant_deadline, confirmation.deadline);
    }
    const final = await checkpointJobs(env);
    assert.deepEqual(
      final
        .filter((job) => job.state === 'accepted')
        .map(({ id }) => id)
        .sort(),
      confirmations.map(({ job }) => job).sort(),
    );
    assert.equal(final.filter((job) => job.checkpoint_batch_count !== null).length, 1);
  } finally {
    await env.close();
  }
});

test('batch migration preserves a legacy checkpoint awaiting retry', async () => {
  const env = await environment({ singleTenant: true });
  try {
    await env.store.pool.query('ALTER TABLE haip_outbox DROP COLUMN checkpoint_batch_count');
    await env.store.pool.query(
      "DELETE FROM haip_migrations WHERE name='011_checkpoint_batches.sql'",
    );
    const {
      rows: [legacy],
    } = await env.store.pool.query(
      `UPDATE haip_outbox SET attempts=1,claim_generation=1,next_at=clock_timestamp(),
       error='delivery_failed' WHERE tenant='test-tenant' AND kind='checkpoint' RETURNING id,body,next_at`,
    );
    await env.store.migrate();
    await appendAudit(env);
    const [retry, collecting] = await checkpointJobs(env);
    assert.equal(retry.id, legacy.id);
    assert.deepEqual(retry.body, legacy.body);
    assert.deepEqual(retry.next_at, legacy.next_at);
    assert.equal(retry.attempts, 1);
    assert.equal(retry.checkpoint_batch_count, null);
    assert.equal(collecting.checkpoint_batch_count, 1);
    assert.deepEqual(await env.worker.runJob(retry.id), { state: 'settled' });
    assert.deepEqual((await checkpointJobs(env))[0].body, legacy.body);
  } finally {
    await env.close();
  }
});

test('a checkpoint claim releases the tenant lock and prevents a concurrent delivery', async () => {
  const env = await environment();
  const entered = deferred(),
    release = deferred();
  let first: Promise<number> | undefined,
    lockWrite: Promise<void> | undefined,
    calls = 0;
  const accept = env.anchor.accept.bind(env.anchor);
  try {
    await drainSetup(env);
    const id = await checkpoint(env);
    env.anchor.accept = async (record) => {
      calls++;
      entered.resolve();
      await release.promise;
      return accept(record);
    };
    first = env.worker.tick();
    await within(entered.promise);
    lockWrite = env.store.transaction('test-tenant', async (tx) => {
      await tx.query("UPDATE haip_tenants SET config=config WHERE id='test-tenant'");
    });
    await within(lockWrite);
    assert.equal(await within(new OutboxWorker(env.service, env.anchor).tick()), 0);
    assert.equal(calls, 1);
    const claimed = (
      await env.store.pool.query(
        'SELECT state,attempts,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(claimed.state, 'pending');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.claim_generation, 1);
    assert(claimed.claim_until);
    assert.match(claimed.claim_revision, /^sha256:[a-f0-9]{64}$/);
    release.resolve();
    assert.equal(await first, 1);
    const accepted = (
      await env.store.pool.query(
        'SELECT state,attempts,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.deepEqual(accepted, {
      state: 'accepted',
      attempts: 1,
      claim_until: null,
      claim_revision: null,
    });
  } finally {
    release.resolve();
    await Promise.allSettled([first, lockWrite].filter(Boolean) as Promise<unknown>[]);
    env.anchor.accept = accept;
    await env.close();
  }
});

test('lost dispatch and delivery acknowledgements resume one committed outbox job', async () => {
  const dispatched: string[][] = [];
  let observe = false;
  const env = await environment({
    async dispatchOutbox(ids) {
      if (!observe) return;
      const visible = await env.store.transaction('test-tenant', (tx) =>
        tx.query('SELECT id FROM haip_outbox WHERE id=ANY($1::uuid[])', [ids]),
      );
      assert.equal(visible.rowCount, ids.length);
      dispatched.push([...ids]);
      throw new Error('fixture dispatch acknowledgement lost');
    },
  });
  const accept = env.anchor.accept.bind(env.anchor);
  let deliveries = 0;
  try {
    await drainSetup(env);
    observe = true;
    const principal = await operator(env);
    await assert.rejects(
      env.store.transaction('test-tenant', async (tx, now) => {
        await env.service.audit(tx, principal, now, 'ClaimFixture', { id: randomUUID() });
        throw new Error('fixture rollback');
      }),
      /fixture rollback/,
    );
    assert.deepEqual(dispatched, []);
    const id = await checkpoint(env);
    assert.deepEqual(dispatched, [[id]]);
    assert.deepEqual(await env.worker.readyJobs(), { ids: [id] });

    env.anchor.accept = async (record) => {
      const result = await accept(record);
      if (++deliveries === 1) return Promise.reject(undefined);
      return result;
    };
    const waiting = await env.worker.runJob(id);
    assert.equal(waiting.state, 'pending');
    const replacement = new OutboxWorker(env.service, env.anchor);
    assert.deepEqual(await replacement.readyJobs(), { ids: [] });
    assert.deepEqual(await replacement.runJob(id), waiting);
    assert.equal(deliveries, 1);
    await env.store.pool.query('UPDATE haip_outbox SET next_at=clock_timestamp() WHERE id=$1', [
      id,
    ]);
    assert.deepEqual(await replacement.runJob(id), { state: 'settled' });
    assert.deepEqual(await env.worker.runJob(id), { state: 'settled' });
    assert.equal(deliveries, 2);
    const final = await env.store.pool.query(
      'SELECT state,attempts,claim_generation FROM haip_outbox WHERE id=$1',
      [id],
    );
    assert.deepEqual(final.rows, [{ state: 'accepted', attempts: 2, claim_generation: 2 }]);
  } finally {
    env.anchor.accept = accept;
    await env.close();
  }
});

test('a failed checkpoint releases its claim and retries the same immutable record', async () => {
  const env = await environment();
  const accept = env.anchor.accept.bind(env.anchor);
  let calls = 0;
  try {
    await drainSetup(env);
    const id = await checkpoint(env);
    const original = (await env.store.pool.query('SELECT body FROM haip_outbox WHERE id=$1', [id]))
      .rows[0].body;
    env.anchor.accept = async (record) => {
      assert.deepEqual(record, original);
      calls++;
      if (calls === 1) throw new Error('test_anchor_outage');
      return accept(record);
    };
    const failedAt = Date.now();
    assert.equal(await env.worker.tick(), 0);
    const failed = (
      await env.store.pool.query(
        'SELECT state,attempts,next_at,claim_generation,claim_until,claim_revision,error FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(failed.state, 'pending');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.claim_generation, 1);
    assert.equal(failed.claim_until, null);
    assert.equal(failed.claim_revision, null);
    assert.equal(failed.error, 'delivery_failed');
    assert(failed.next_at.getTime() >= failedAt + 1900);
    await appendAudit(env);
    assert.deepEqual(
      (
        await env.store.pool.query(
          'SELECT body,checkpoint_batch_count FROM haip_outbox WHERE id=$1',
          [id],
        )
      ).rows[0],
      { body: original, checkpoint_batch_count: null },
    );
    await env.store.pool.query('UPDATE haip_outbox SET next_at=clock_timestamp() WHERE id=$1', [
      id,
    ]);
    assert.equal(await env.worker.tick(), 1);
    assert.equal(calls, 2);
    const accepted = (
      await env.store.pool.query(
        'SELECT state,attempts,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.deepEqual(accepted, {
      state: 'accepted',
      attempts: 2,
      claim_generation: 2,
      claim_until: null,
      claim_revision: null,
    });
  } finally {
    env.anchor.accept = accept;
    await env.close();
  }
});

test('a reclaimed checkpoint rejects its stale worker finalisation', async () => {
  const env = await environment();
  const entered = deferred(),
    release = deferred();
  const accept = env.anchor.accept.bind(env.anchor);
  let first: Promise<number> | undefined,
    calls = 0;
  try {
    await drainSetup(env);
    const id = await checkpoint(env);
    env.anchor.accept = async (record) => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return accept(record);
    };
    first = env.worker.tick();
    await within(entered.promise);
    await env.store.pool.query(
      "UPDATE haip_outbox SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id],
    );
    assert.equal(await new OutboxWorker(env.service, env.anchor).tick(), 1);
    release.resolve();
    assert.equal(await first, 0);
    assert.equal(calls, 2);
    assert.deepEqual(
      (
        await env.store.pool.query(
          'SELECT state,attempts,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
          [id],
        )
      ).rows[0],
      {
        state: 'accepted',
        attempts: 2,
        claim_generation: 2,
        claim_until: null,
        claim_revision: null,
      },
    );
  } finally {
    release.resolve();
    await Promise.allSettled([first].filter(Boolean) as Promise<unknown>[]);
    env.anchor.accept = accept;
    await env.close();
  }
});

test('the claim migration upgrades existing pending jobs with an empty claim', async () => {
  const env = await environment();
  try {
    await drainSetup(env);
    const id = await checkpoint(env);
    await env.store.pool.query('DROP INDEX haip_outbox_ready_delivery');
    await env.store.pool.query('DROP INDEX haip_outbox_ready');
    await env.store.pool.query('ALTER TABLE haip_outbox DROP CONSTRAINT haip_outbox_claim_pair');
    await env.store.pool.query(
      'ALTER TABLE haip_outbox DROP COLUMN claim_revision,DROP COLUMN claim_until,DROP COLUMN claim_generation',
    );
    await env.store.pool.query(
      "CREATE INDEX haip_outbox_ready ON haip_outbox(tenant,next_at,created_at,id) WHERE state='pending'",
    );
    await env.store.pool.query(
      "CREATE INDEX haip_outbox_ready_delivery ON haip_outbox(tenant,next_at,created_at,id) WHERE state='pending' AND kind IN ('smtp','webhook')",
    );
    await env.store.pool.query("DELETE FROM haip_migrations WHERE name='007_outbox_claims.sql'");
    await env.store.migrate();
    assert.deepEqual(
      (
        await env.store.pool.query(
          'SELECT state,claim_generation,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
          [id],
        )
      ).rows[0],
      {
        state: 'pending',
        claim_generation: 0,
        claim_until: null,
        claim_revision: null,
      },
    );
    assert.equal(
      (
        await env.store.pool.query(
          "SELECT count(*)::integer AS count FROM pg_indexes WHERE indexname IN ('haip_outbox_ready','haip_outbox_ready_delivery')",
        )
      ).rows[0].count,
      2,
    );
  } finally {
    await env.close();
  }
});

test('the ready index skips a large active claim set', async () => {
  const env = await environment();
  try {
    await drainSetup(env);
    const id = await checkpoint(env);
    await env.store.pool.query(
      `INSERT INTO haip_outbox(id,tenant,kind,body,next_at,created_at,claim_generation,claim_until,claim_revision)
       SELECT gen_random_uuid(),'test-tenant','checkpoint',template.body,statement_timestamp()-interval '1 day',statement_timestamp()-interval '2 days',1,statement_timestamp()+interval '1 day','sha256:'||repeat('a',64)
       FROM generate_series(1,10000),LATERAL(SELECT body FROM haip_outbox WHERE id=$1) template`,
      [id],
    );
    await env.store.pool.query('ANALYZE haip_outbox');
    const explained = await env.store.pool.query(
      `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
       SELECT id,tenant FROM haip_outbox WHERE tenant=$1 AND state='pending'
       AND GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz))<=statement_timestamp()
       ORDER BY GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz)),created_at,id LIMIT 50`,
      ['test-tenant'],
    );
    const plan = explained.rows[0]['QUERY PLAN'][0].Plan;
    const nodes: any[] = [];
    const visit = (node: any) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan);
    assert(
      nodes.some(
        (node) =>
          ['Index Scan', 'Index Only Scan'].includes(node['Node Type']) &&
          node['Index Name'] === 'haip_outbox_ready',
      ),
      JSON.stringify(plan),
    );
    assert(!nodes.some((node) => node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Sort'));
    assert(
      Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0) < 100,
      JSON.stringify(plan),
    );
    assert.equal(await env.worker.tick(), 1);
  } finally {
    await env.close();
  }
});

test('webhook claims preserve authority recorded at claim and stop stale failure retries', async (t) => {
  for (const outcome of ['accepted', 'failed'] as const)
    await t.test(outcome, async () => {
      const env = await environment();
      const entered = deferred();
      let finish: (() => void) | undefined,
        first: Promise<number> | undefined,
        requests = 0;
      try {
        env.service.config.webhookHosts.push('receiver.test');
        await env.principal(
          'producer',
          'producer',
          {
            enabled: true,
            publisher: 'publisher',
            owner: 'requester',
            routes: ['review'],
            webhook: 'https://receiver.test/events',
          },
          env.credentials.producer,
        );
        await env.flush();
        const created = await env.api('/v2/requests', env.request());
        assert.equal(created.status, 201);
        const item = (
          await env.store.pool.query(
            "SELECT id FROM haip_outbox WHERE tenant='test-tenant' AND request_id=$1 AND kind='webhook'",
            [created.body.request.id],
          )
        ).rows[0];
        const worker = new OutboxWorker(env.service, undefined, {
          webhookTransport: {
            resolve: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
            request: ((_url: URL, _options: unknown, callback: (response: any) => void) => {
              const request = new EventEmitter() as any;
              request.destroy = (error: Error) => request.emit('error', error);
              request.end = () => {
                requests++;
                finish = () => {
                  if (outcome === 'failed') {
                    request.emit('error', new Error('fixture_delivery_failed'));
                    return;
                  }
                  const response = new PassThrough() as any;
                  response.statusCode = 204;
                  callback(response);
                  response.end();
                };
                entered.resolve();
              };
              return request;
            }) as any,
          },
        });
        first = worker.tick();
        await within(entered.promise);
        await within(
          env.store.transaction('test-tenant', async (tx) => {
            await tx.query(
              "UPDATE haip_principals SET config=jsonb_set(config,'{enabled}','false') WHERE tenant='test-tenant' AND id='producer'",
            );
          }),
        );
        assert.equal(await within(worker.tick()), 0);
        assert.equal(requests, 1);
        finish();
        finish = undefined;
        assert.equal(await first, outcome === 'accepted' ? 1 : 0);
        assert.deepEqual(
          (
            await env.store.pool.query(
              'SELECT state,attempts,error,claim_until,claim_revision FROM haip_outbox WHERE id=$1',
              [item.id],
            )
          ).rows[0],
          {
            state: outcome,
            attempts: 1,
            error: outcome === 'accepted' ? null : 'destination_changed',
            claim_until: null,
            claim_revision: null,
          },
        );
        assert.equal(await worker.tick(), 0);
        assert.equal(requests, 1);
      } finally {
        finish?.();
        await Promise.allSettled([first].filter(Boolean) as Promise<unknown>[]);
        await env.close();
      }
    });
});
