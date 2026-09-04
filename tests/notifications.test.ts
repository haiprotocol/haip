import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { environment } from './environment.js';
import { freePort } from './fixtures/postgres.js';
import { publicAddress, deliverWebhook } from '../haip-server/src/delivery.js';
import { digest } from '@haip/protocol/crypto';

test('test SMTP honours recipient quotas and notifies the owner after human sign-out', async () => {
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
  const env = await environment({
    smtp: { host: '127.0.0.1', port, secure: false, from: 'review@test.invalid' },
  });
  try {
    for (const id of ['reviewer', 'requester'])
      await env.principal(id, 'human', {
        enabled: true,
        identity_certain: true,
        oidc_issuer: env.service.config.oidc.issuer,
        oidc_subject: id,
        email: id + '@test.invalid',
        email_verified: true,
      });
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
    assert(
      messages.some((m) => m.to === 'requester@test.invalid' && m.body.includes('/review/' + id)),
    );
    assert(messages.every((m) => m.body.includes('This email cannot approve')));
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
    await env.close();
    await new Promise<void>((resolve) => smtp.close(resolve));
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
