import { test } from 'node:test';
import assert from 'node:assert/strict';
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
