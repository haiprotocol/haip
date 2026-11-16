import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { environment } from './environment.js';
import { freePort } from './fixtures/postgres.js';
import { publicAddress, deliverWebhook } from '../haip-server/src/delivery.js';
import { digest, digestBytes } from '@haip/protocol/crypto';

async function mailFixture() {
  const port = await freePort(),
    messages: { to: string; body: string }[] = [];
  const smtp = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream: any, session: any, callback: any) {
      let body = '';
      stream.on('data', (chunk: Buffer) => (body += chunk));
      stream.on('end', () => {
        messages.push({ to: session.envelope.rcptTo[0].address, body });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(port, '127.0.0.1', resolve));
  const closeSmtp = () => new Promise<void>((resolve) => smtp.close(resolve));
  try {
    const env = await environment({
      smtp: { host: '127.0.0.1', port, secure: false, from: 'review@test.invalid' },
    });
    return {
      env,
      messages,
      async close() {
        try {
          await env.close();
        } finally {
          await closeSmtp();
        }
      },
    };
  } catch (error) {
    await closeSmtp();
    throw error;
  }
}

function verifiedHuman(env: Awaited<ReturnType<typeof environment>>, id: string, email: string) {
  return {
    enabled: true,
    identity_certain: true,
    oidc_issuer: env.service.config.oidc.issuer,
    oidc_subject: id,
    email,
    email_verified: true,
  };
}

test('SMTP honours recipient quotas and the owner can reopen a received link after session expiry', async () => {
  const { env, messages, close } = await mailFixture();
  try {
    for (const id of ['reviewer', 'requester'])
      await env.principal(id, 'human', verifiedHuman(env, id, id + '@test.invalid'));
    await env.put('/v2/admin/routes/review', {
      ...env.route,
      reviewers: ['reviewer', 'reviewer2'],
    });
    const owner = await env.login('requester');
    assert.equal((await owner.call('/auth/session')).status, 200);
    await env.store.pool.query(
      "UPDATE haip_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
      [digestBytes(owner.cookie.slice('__Host-haip='.length))],
    );
    const created = await env.api('/v2/requests', env.request()),
      id = created.body.request.id;
    const human = await env.login(),
      candidate = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'answer',
        response: { choice: 'accept' },
      });
    await human.call(`/v2/requests/${id}/confirm`, {
      candidate_id: candidate.body.id,
      candidate_digest: digest(candidate.body),
    });
    const signedOut = await fetch(env.origin + '/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: human.cookie,
        Origin: env.origin,
        'X-CSRF-Token': human.csrf,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(signedOut.status, 204);
    assert.equal(
      (await fetch(env.origin + '/auth/session', { headers: { Cookie: human.cookie } })).status,
      401,
    );
    for (let i = 0; i < 11; i++)
      assert.equal((await env.api('/v2/requests', env.request())).status, 201);
    await env.flush();
    assert.equal(messages.filter((m) => m.to === 'reviewer@test.invalid').length, 10);
    const reviewPath = '/review/' + id;
    const reviewUrl = env.origin + reviewPath;
    const ownerMessages = messages.filter((message) => message.to === 'requester@test.invalid');
    assert(
      ownerMessages.some((message) =>
        message.body
          .replace(/=\r?\n/g, '')
          .split(/\r?\n/)
          .includes(reviewUrl),
      ),
    );
    assert(messages.every((m) => m.body.includes('This email cannot approve')));
    assert.equal((await owner.call('/auth/session')).status, 401);
    const link = await fetch(reviewUrl, { redirect: 'manual', headers: { Cookie: owner.cookie } });
    assert.equal(link.status, 302);
    assert.equal(link.headers.getSetCookie().length, 0);
    const signIn = '/auth/login?return_to=' + encodeURIComponent(reviewPath);
    assert.equal(link.headers.get('location'), signIn);
    const returned = await env.login('requester', { path: signIn, previousCookie: owner.cookie });
    assert.equal(returned.returnTo, reviewPath);
    assert.notEqual(returned.cookie, owner.cookie);
    const page = await fetch(reviewUrl, {
      redirect: 'manual',
      headers: { Cookie: returned.cookie },
    });
    assert.equal(page.status, 200);
    const authenticatedStatus = await returned.call(`/v2/requests/${id}`);
    assert.equal(authenticatedStatus.body.decision_state, 'confirmed');
    assert.equal(authenticatedStatus.body.receipt.payload.decision, 'answer');
    assert.equal((await returned.call(`/v2/requests/${id}/material`)).status, 404);
    assert.equal(
      (
        await returned.call(`/v2/requests/${id}/candidates`, {
          decision: 'answer',
          response: { choice: 'accept' },
        })
      ).status,
      404,
    );
    const otherTenant = await env.login('foreign-requester');
    assert.equal((await otherTenant.call(`/v2/requests/${id}`)).status, 404);
    const delivery = (await env.api('/v2/requests/' + id)).body.delivery;
    assert(delivery.some((d: any) => d.kind === 'smtp' && d.state === 'accepted'));
    const sent = messages.length;
    await env.store.pool.query(
      "UPDATE haip_outbox SET created_at=clock_timestamp()-interval '24 hours',next_at=clock_timestamp() WHERE kind='smtp' AND state='pending'",
    );
    await env.flush();
    assert.equal(messages.length, sent, 'expired notifications must never be sent after a restart');
    const metrics = await env.api('/v2/admin/metrics', undefined, env.credentials.operator);
    assert(
      metrics.body.delivery.some(
        (d: any) => d.kind === 'smtp' && d.state === 'failed' && d.count > 0,
      ),
    );
  } finally {
    await close();
  }
});

test('SMTP refuses a transferred address, a removed reviewer and an unbound old job', async () => {
  const { env, messages, close } = await mailFixture();
  try {
    const oldAddress = 'reviewer@test.invalid';
    await env.principal('reviewer', 'human', verifiedHuman(env, 'reviewer', oldAddress));
    const request = async () => {
      const created = await env.api('/v2/requests', env.request());
      assert.equal(created.status, 201);
      return created.body.request.id as string;
    };
    const transferred = await request();
    await env.principal(
      'reviewer',
      'human',
      verifiedHuman(env, 'reviewer', 'updated@test.invalid'),
    );
    await env.principal('reviewer2', 'human', verifiedHuman(env, 'reviewer2', oldAddress));
    const removed = await request();
    await env.put('/v2/admin/routes/review', { ...env.route, reviewers: ['reviewer2'] });
    const legacy = await request();
    await env.store.pool.query(
      "UPDATE haip_outbox SET body=(body - 'recipient_id') - 'recipient_role' WHERE request_id=$1 AND kind='smtp'",
      [legacy],
    );
    await env.flush();
    assert.equal(messages.filter((message) => message.body.includes(transferred)).length, 0);
    assert(
      !messages.some(
        (message) => message.to === 'updated@test.invalid' && message.body.includes(removed),
      ),
    );
    assert(messages.some((message) => message.to === oldAddress && message.body.includes(removed)));
    assert(!messages.some((message) => message.body.includes(legacy)));
    const latest = (await env.api(`/v2/requests/${legacy}`)).body.delivery;
    assert(
      latest.some(
        (delivery: any) =>
          delivery.kind === 'smtp' &&
          delivery.state === 'failed' &&
          delivery.attempts === 0 &&
          delivery.error === 'notification_recipient_unknown',
      ),
    );
  } finally {
    await close();
  }
});

test('discard sends one owner status link and clears earlier notification copies', async () => {
  const { env, messages, close } = await mailFixture();
  try {
    const requester = 'requester@test.invalid';
    for (const id of ['reviewer', 'requester'])
      await env.principal(id, 'human', verifiedHuman(env, id, `${id}@test.invalid`));
    await env.put('/v2/admin/routes/review', { ...env.route, reviewers: ['reviewer'] });
    const summary = 'Summary from before discard';
    const created = await env.api('/v2/requests', env.request(false, { summary }));
    assert.equal(created.status, 201);
    const id = created.body.request.id;
    await env.flush();
    assert.equal(messages.length, 1);
    assert.ok(messages[0].body.includes(summary));

    for (let retry = 0; retry < 2; retry++)
      assert.equal((await env.api(`/v2/requests/${id}/discard`, {})).status, 200);
    const rows = (
      await env.store.pool.query(
        "SELECT state,body,destination,accepted,claim_until,claim_revision FROM haip_outbox WHERE tenant=$1 AND request_id=$2 AND kind='smtp' ORDER BY created_at",
        ['test-tenant', id],
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      state: 'accepted',
      body: {},
      destination: null,
      accepted: null,
      claim_until: null,
      claim_revision: null,
    });
    assert.equal(rows[1].destination, requester);
    assert.doesNotMatch(rows[1].body.text, /Summary from before discard/);
    assert.ok(rows[1].body.text.includes(`${env.origin}/review/${id}`));

    await env.flush();
    const notices = messages.filter(({ to }) => to === requester);
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /Review material was deleted/);
    assert.doesNotMatch(notices[0].body, /Summary from before discard/);
  } finally {
    await close();
  }
});

test('migration clears legacy mail for discarded reviews and preserves active queues', async () => {
  const env = await environment();
  try {
    const create = async () => {
      const result = await env.api('/v2/requests', env.request());
      assert.equal(result.status, 201);
      return result.body.request.id as string;
    };
    const discarded = await create();
    const active = await create();
    assert.equal((await env.api(`/v2/requests/${discarded}/discard`, {})).status, 200);
    const jobs = [
      { request: discarded, state: 'accepted' },
      { request: discarded, state: 'pending' },
      { request: active, state: 'pending' },
    ].map((job) => ({ ...job, id: randomUUID() }));
    const text = 'Legacy review summary';
    for (const job of jobs) {
      await env.store.pool.query(
        `INSERT INTO haip_outbox(id,tenant,kind,request_id,state,destination,body)
         VALUES($1,'test-tenant','smtp',$2,$3,'reviewer@test.invalid',jsonb_build_object('text',$4::text))`,
        [job.id, job.request, job.state, text],
      );
    }
    await env.store.pool.query(
      "DELETE FROM haip_migrations WHERE name='010_discarded_notifications.sql'",
    );
    await env.store.migrate();
    const { rows } = await env.store.pool.query(
      'SELECT id,state,body,destination FROM haip_outbox WHERE id=ANY($1::uuid[])',
      [jobs.map(({ id }) => id)],
    );
    assert.equal(rows.length, jobs.length);
    assert.deepEqual(
      rows.find(({ id }) => id === jobs[0].id),
      { id: jobs[0].id, state: 'accepted', body: {}, destination: null },
    );
    assert.deepEqual(
      rows.find(({ id }) => id === jobs[1].id),
      { id: jobs[1].id, state: 'expired', body: {}, destination: null },
    );
    assert.deepEqual(
      rows.find(({ id }) => id === jobs[2].id),
      { id: jobs[2].id, state: 'pending', body: { text }, destination: 'reviewer@test.invalid' },
    );
  } finally {
    await env.close();
  }
});

test('webhook destinations reject private, mapped and loopback addresses', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '192.88.99.0',
    '192.88.99.1',
    '192.88.99.2',
    '192.88.99.255',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['192.88.98.255', '192.88.100.0']) assert.equal(publicAddress(ip), true, ip);
  let requested = false;
  await assert.rejects(
    () =>
      deliverWebhook('https://relay.example.invalid/', {}, ['relay.example.invalid'], {
        resolve: (async () => [{ address: '192.88.99.1', family: 4 }]) as any,
        request: (() => {
          requested = true;
          throw new Error('A relay address must never be contacted');
        }) as any,
      }),
    /webhook_address_rejected/,
  );
  assert.equal(requested, false);
  await assert.rejects(
    () => deliverWebhook('https://localhost/', {}, ['localhost']),
    /webhook_address_rejected/,
  );
  await assert.rejects(
    () => deliverWebhook('http://example.invalid/', {}, ['example.invalid']),
    /webhook_destination_rejected/,
  );
});
