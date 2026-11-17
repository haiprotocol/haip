import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '@haip/protocol/crypto';
import { environment } from './environment.js';

test('confirmation and claims sample authoritative time after waiting for the tenant lock', async () => {
  const env = await environment();
  try {
    const reviewer = await env.login();
    for (const stage of ['confirmation', 'claim']) {
      await env.put('/v2/admin/routes/review', {
        ...env.route,
        limits: {
          ...env.route.limits,
          review_seconds: stage === 'confirmation' ? 2 : 30,
          grant_seconds: 2,
        },
      });
      const created = await env.api('/v2/requests', env.request(true)),
        id = created.body.request.id;
      assert.equal(created.status, 201);
      const candidate = await reviewer.call(`/v2/requests/${id}/candidates`, {
        decision: 'authorise',
        response: { choice: 'accept' },
      });
      assert.equal(candidate.status, 201);
      const confirmation = {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      };
      let deadline = created.body.request.review_deadline;
      if (stage === 'claim') {
        const receipt = await reviewer.call(`/v2/requests/${id}/confirm`, confirmation);
        assert.equal(receipt.status, 200);
        deadline = receipt.body.payload.grant_deadline;
        await env.flush();
      }
      const lock = await env.store.pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['test-tenant']);
        assert(Date.now() < Date.parse(deadline));
        const pending =
          stage === 'confirmation'
            ? reviewer.call(`/v2/requests/${id}/confirm`, confirmation)
            : env.api(`/v2/requests/${id}/claims`, {
                execution_identity: 'waited-claim',
                execution_binding_digest: digest(created.body.request.execution),
              });
        let waiting = false;
        for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
          waiting =
            (
              await env.store.pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1",
              )
            ).rowCount! > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(waiting, 'public request must actually wait for the held lock');
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now() + 30)),
        );
        await lock.query('COMMIT');
        const refused = await pending;
        assert.equal(refused.status, 409);
        assert.equal(
          refused.body.error,
          stage === 'confirmation' ? 'request_not_pending' : 'grant_expired',
        );
        assert.equal((await env.api(`/v2/requests/${id}`)).body.claim, null);
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
    }
  } finally {
    await env.close();
  }
});

test('lock waits inside the tenant transaction cannot extend decision and grant deadlines', async (t) => {
  const env = await environment({ singleTenant: true });
  try {
    const reviewer = await env.login();
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      limits: { ...env.route.limits, grant_seconds: 3 },
    });
    for (const stage of ['confirmation', 'claim', 'occurrence update', 'admission']) {
      await t.test(stage, async () => {
        const execution = stage !== 'confirmation';
        const created = await env.api(
          '/v2/requests',
          env.request(execution, { review_seconds: 3 }),
        );
        assert.equal(created.status, 201);
        const request = created.body.request;
        const path = `/v2/requests/${request.id}`;
        const candidate = await reviewer.call(path + '/candidates', {
          decision: execution ? 'authorise' : 'answer',
          response: { choice: 'accept' },
        });
        assert.equal(candidate.status, 201);
        const selection = {
          candidate_id: candidate.body.id,
          candidate_digest: digest(candidate.body),
        };
        let issue = () => reviewer.call(path + '/confirm', selection);
        let deadline = request.review_deadline;
        if (execution) {
          const receipt = await issue();
          assert.equal(receipt.status, 200);
          deadline = receipt.body.payload.grant_deadline;
          await env.flush();
          const executionIdentity = 'timing-' + stage.replace(' ', '-');
          issue = () =>
            env.api(path + '/claims', {
              execution_identity: executionIdentity,
              execution_binding_digest: digest(request.execution),
            });
          if (stage === 'admission') {
            const claim = await issue();
            assert.equal(claim.status, 201, JSON.stringify(claim.body));
            issue = () =>
              env.api(path + '/admission', {
                claim_id: claim.body.payload.id,
                execution_identity: executionIdentity,
                nonce: 'eligibility-wait-nonce',
              });
          }
        }

        const lock = await env.store.pool.connect();
        try {
          await lock.query('BEGIN');
          const occurrenceUpdate = stage === 'occurrence update';
          await lock.query(
            occurrenceUpdate
              ? 'LOCK TABLE haip_occurrences IN ACCESS EXCLUSIVE MODE'
              : 'LOCK TABLE haip_routes IN ACCESS EXCLUSIVE MODE',
          );
          const waitingQuery = occurrenceUpdate
            ? 'UPDATE haip_occurrences SET consumed=true%'
            : 'SELECT revision,config FROM haip_routes WHERE tenant=%';
          const pending = issue();
          try {
            let blockedBeforeDeadline = false;
            for (let attempt = 0; attempt < 100 && !blockedBeforeDeadline; attempt++) {
              const result = await env.store.pool.query(
                `SELECT 1 FROM pg_stat_activity
                 WHERE wait_event_type='Lock' AND wait_event='relation'
                   AND query LIKE $2
                   AND clock_timestamp() < $1::timestamptz`,
                [deadline, waitingQuery],
              );
              blockedBeforeDeadline = result.rowCount! > 0;
              if (!blockedBeforeDeadline) await delay(10);
            }
            assert(
              blockedBeforeDeadline,
              'the request entered the tenant transaction before expiry',
            );
            await lock.query(
              'SELECT pg_sleep(greatest(0, extract(epoch FROM $1::timestamptz - clock_timestamp())))',
              [deadline],
            );
          } finally {
            await lock.query('ROLLBACK');
          }
          const refused = await pending;
          assert.equal(refused.status, 409);
          assert.equal(refused.body.error, execution ? 'grant_expired' : 'request_not_pending');
        } finally {
          lock.release();
        }
        const records = (await env.api(path + '/export')).body.records;
        const expected = execution ? ['DecisionReceipt'] : [];
        if (stage === 'admission') expected.push('ExecutionClaim');
        assert.deepEqual(
          records.map((record: { protected: { type: string } }) => record.protected.type),
          expected,
        );
        if (stage === 'claim' || stage === 'occurrence update') {
          const occurrence = await env.store.pool.query(
            'SELECT consumed FROM haip_occurrences WHERE tenant=$1 AND producer=$2 AND occurrence=$3',
            ['test-tenant', 'producer', request.execution.action_occurrence_id],
          );
          assert.deepEqual(occurrence.rows, [{ consumed: false }]);
        }
      });
    }
  } finally {
    await env.close();
  }
});
