import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import dns from 'node:dns';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { SMTPServer } from 'smtp-server';
import { deliverSMTP, SMTPTimeoutError } from '../haip-server/src/smtp.js';
import { environment } from './environment.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const exec = promisify(execFile);
const message = { to: 'reviewer@test.invalid', subject: 'Deadline fixture', text: 'Test only.' };

async function partialSMTP(phase: 'ehlo' | 'data') {
  const sockets = new Set<Socket>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  let reached!: () => void;
  let closed!: () => void;
  const stalled = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const disposed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let received = 0;
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      closed();
    });
    socket.on('error', () => {});
    socket.write('220 test.invalid SMTP\r\n');
    let data = false;
    let bytes = '';
    const stall = () => {
      socket.write('250-keepalive\r\n');
      const timer = setInterval(() => socket.write('250-keepalive\r\n'), 50);
      intervals.add(timer);
      socket.once('close', () => {
        clearInterval(timer);
        intervals.delete(timer);
      });
      reached();
    };
    socket.on('data', (chunk) => {
      bytes += chunk.toString();
      if (data) {
        if (bytes.includes('\r\n.\r\n')) {
          received++;
          bytes = '';
          data = false;
          stall();
        }
        return;
      }
      let end: number;
      while ((end = bytes.indexOf('\r\n')) >= 0) {
        const line = bytes.slice(0, end);
        bytes = bytes.slice(end + 2);
        if (line.startsWith('EHLO')) {
          if (phase === 'ehlo') stall();
          else socket.write('250 test.invalid\r\n');
        } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
          socket.write('250 accepted\r\n');
        } else if (line === 'DATA') {
          data = true;
          socket.write('354 send message\r\n');
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    smtp: {
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      secure: false,
      from: 'haip@test.invalid',
    },
    stalled,
    disposed,
    get received() {
      return received;
    },
    get connections() {
      return connections;
    },
    get active() {
      return sockets.size;
    },
    lateAcknowledgement() {
      for (const socket of sockets) socket.write('250 accepted\r\n');
    },
    async close() {
      for (const timer of intervals) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('SMTP continuation replies cannot extend the absolute send deadline or retain a socket', async (t) => {
  const fixture = await partialSMTP('ehlo');
  const result: { outcome: unknown; outcomes: number } = { outcome: 'pending', outcomes: 0 };
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = deliverSMTP(fixture.smtp, false, message).then(
      (value) => {
        result.outcomes++;
        result.outcome = value;
      },
      (error) => {
        result.outcomes++;
        result.outcome = error;
      },
    );
    await fixture.stalled;
    t.mock.timers.tick(9000);
    await turn();
    assert.equal(String(result.outcome), 'pending');
    assert.equal(fixture.active, 1);
    t.mock.timers.tick(1000);
    await sent;
    assert(result.outcome instanceof SMTPTimeoutError);
    assert.equal(result.outcome.smtpAccepted, 'unknown');
    await fixture.disposed;
    assert.equal(fixture.active, 0);
    fixture.lateAcknowledgement();
    await turn();
    assert.equal(result.outcomes, 1);
    assert.equal(fixture.received, 0);
  } finally {
    t.mock.timers.reset();
    await fixture.close();
  }
});

test('stalled SMTP DNS expires and a late answer cannot open a connection', async (t) => {
  const fixture = await partialSMTP('ehlo');
  const original = dns.lookup;
  let answer!: (...args: any[]) => void;
  let options: any;
  let reached!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  t.mock.method(dns, 'lookup', ((host: string, received: any, callback: any) => {
    if (host !== 'haip-smtp-deadline.invalid') return (original as any)(host, received, callback);
    options = received;
    answer = callback;
    reached();
  }) as typeof dns.lookup);
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = deliverSMTP(
      { ...fixture.smtp, host: 'haip-smtp-deadline.invalid' },
      false,
      message,
    );
    const refused = assert.rejects(
      sent,
      (error: unknown) => error instanceof SMTPTimeoutError && error.smtpAccepted === 'unknown',
    );
    await lookupStarted;
    t.mock.timers.tick(10000);
    await refused;
    if (options.all) answer(null, [{ address: '127.0.0.1', family: 4 }]);
    else answer(null, '127.0.0.1', 4);
    await turn();
    await turn();
    assert.equal(fixture.connections, 0);
    assert.equal(fixture.active, 0);
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
    await fixture.close();
  }
});

test('timeout after SMTP DATA leaves acceptance unknown and lets later worker jobs finish', async (t) => {
  const fixture = await partialSMTP('data');
  const env = await environment({ smtp: fixture.smtp });
  try {
    await env.principal('reviewer', 'human', {
      enabled: true,
      identity_certain: true,
      oidc_issuer: env.service.config.oidc.issuer,
      oidc_subject: 'reviewer',
      email: 'reviewer@test.invalid',
      email_verified: true,
    });
    const created = await env.api('/v2/requests', env.request());
    assert.equal(created.status, 201);
    const id = created.body.request.id;
    const registered = await env.api(
      '/v2/bundles',
      {
        html: '<p>Later checkpoint fixture</p>',
        compatibility: { agent_ui: '2' },
        author: 'Fixture',
        licence: 'MIT',
      },
      env.credentials.publisher,
    );
    assert.equal(registered.status, 201);
    const later = (
      await env.store.pool.query(
        "SELECT id FROM haip_outbox WHERE tenant='test-tenant' AND kind='checkpoint' ORDER BY created_at DESC,id DESC LIMIT 1",
      )
    ).rows[0].id;
    const order = (
      await env.store.pool.query(
        "SELECT id,kind FROM haip_outbox WHERE tenant='test-tenant' AND state='pending' ORDER BY GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz)),created_at,id",
      )
    ).rows;
    const smtpIndex = order.findIndex((item: any) => item.kind === 'smtp');
    assert(smtpIndex >= 0 && order.findIndex((item: any) => item.id === later) > smtpIndex);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick = env.worker.tick();
    await fixture.stalled;
    assert.equal(fixture.received, 1, 'a timeout cannot prove that the server discarded DATA');
    assert.equal(
      (await env.store.pool.query('SELECT state FROM haip_outbox WHERE id=$1', [later])).rows[0]
        .state,
      'pending',
    );
    t.mock.timers.tick(10000);
    await fixture.disposed;
    await tick;
    const delivery = (await env.api('/v2/requests/' + id)).body.delivery.find(
      (item: any) => item.kind === 'smtp',
    );
    assert.equal(delivery.state, 'pending');
    assert.equal(delivery.error, 'smtp_timeout');
    assert.equal(delivery.accepted, undefined);
    const row = (
      await env.store.pool.query(
        "SELECT attempts,claim_generation,claim_until,accepted,error FROM haip_outbox WHERE request_id=$1 AND kind='smtp'",
        [id],
      )
    ).rows[0];
    assert.equal(row.attempts, 1);
    assert.equal(Number(row.claim_generation), 1);
    assert.equal(row.claim_until, null);
    assert.equal(row.accepted, null);
    assert.equal(row.error, 'smtp_timeout');
    assert.equal(fixture.active, 0);
    const checkpoints = (
      await env.store.pool.query(
        "SELECT state FROM haip_outbox WHERE request_id=$1 AND kind='checkpoint'",
        [id],
      )
    ).rows;
    assert(checkpoints.length > 0);
    assert(
      checkpoints.every((item: any) => item.state === 'accepted'),
      'SMTP timeout must not stop remaining checkpoint jobs',
    );
    assert.equal(
      (await env.store.pool.query('SELECT state FROM haip_outbox WHERE id=$1', [later])).rows[0]
        .state,
      'accepted',
    );
    fixture.lateAcknowledgement();
    await turn();
    assert.equal(fixture.connections, 1);
    const repeated = (
      await env.store.pool.query(
        "SELECT accepted,error FROM haip_outbox WHERE request_id=$1 AND kind='smtp'",
        [id],
      )
    ).rows[0];
    assert.equal(repeated.accepted, null);
    assert.equal(repeated.error, 'smtp_timeout');
  } finally {
    t.mock.timers.reset();
    await env.close();
    await fixture.close();
  }
});

test('invalid SMTP connection configuration rejects without a leaked deadline or process handle', async () => {
  const source = new URL('../haip-server/src/smtp.ts', import.meta.url).href;
  const started = performance.now();
  const result = await exec(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import {deliverSMTP} from ${JSON.stringify(source)}; await deliverSMTP({host:'127.0.0.1',port:-1,secure:false,from:'test@test.invalid'},false,{to:'reviewer@test.invalid',subject:'test',text:'test'}).then(()=>{throw new Error('unexpected acceptance')},error=>{if(error.code!=='ERR_SOCKET_BAD_PORT')throw error;console.log(error.code)});`,
    ],
    { timeout: 3000 },
  );
  assert.match(result.stdout, /ERR_SOCKET_BAD_PORT/);
  assert(performance.now() - started < 3000);
});

test('owned SMTP sockets preserve implicit TLS, STARTTLS, certificate identity and authenticated delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haip-smtp-tls-'));
  const source = new URL('../haip-server/src/smtp.ts', import.meta.url).href;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'pipe' },
    );
    const cert = await readFile(join(directory, 'cert.pem'));
    const key = await readFile(join(directory, 'key.pem'));
    for (const secure of [true, false]) {
      let authenticated = 0;
      let messages = 0;
      const smtp = new SMTPServer({
        secure,
        key,
        cert,
        authMethods: ['PLAIN'],
        onAuth(auth: any, session: any, callback: any) {
          assert.equal(session.secure, true);
          assert.equal(auth.username, 'fixture-user');
          assert.equal(auth.password, 'fixture-password');
          authenticated++;
          callback(null, { user: 'fixture-user' });
        },
        onData(stream: any, _session: any, callback: any) {
          stream.resume();
          stream.once('end', () => {
            messages++;
            callback();
          });
        },
      });
      smtp.on('error', () => {});
      await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
      const port = (smtp.server.address() as { port: number }).port;
      try {
        const config = {
          port,
          secure,
          from: 'haip@test.invalid',
          auth: { user: 'fixture-user', pass: 'fixture-password' },
        };
        const run = (host: string) =>
          exec(
            process.execPath,
            [
              '--import',
              'tsx',
              '--input-type=module',
              '-e',
              `import {deliverSMTP} from ${JSON.stringify(source)}; try{console.log(JSON.stringify(await deliverSMTP(${JSON.stringify({ ...config, host })},true,${JSON.stringify(message)})))}catch(error){console.log(JSON.stringify({code:error.code,error:error.message}));process.exitCode=1}`,
            ],
            {
              timeout: 15000,
              env: {
                ...process.env,
                NODE_EXTRA_CA_CERTS: join(directory, 'cert.pem'),
                NODE_TLS_REJECT_UNAUTHORIZED: '1',
              },
            },
          );
        await assert.rejects(
          () => run('127.0.0.1'),
          (error: any) => {
            assert.match(error.stdout, /ERR_TLS_CERT_ALTNAME_INVALID|does not match.*altnames/i);
            return true;
          },
        );
        assert.equal(
          authenticated,
          0,
          'an untrusted certificate identity must receive no credentials',
        );
        const accepted = await run('localhost');
        assert.deepEqual(JSON.parse(accepted.stdout), {
          smtp_accepted: true,
          delivered_or_read: 'unknown',
        });
        assert.equal(authenticated, 1);
        assert.equal(messages, 1);
      } finally {
        await new Promise<void>((resolve) => smtp.close(resolve));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('production SMTP refuses plaintext authentication when STARTTLS is unavailable', async () => {
  let authenticated = 0;
  const smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onAuth(_auth: any, _session: any, callback: any) {
      authenticated++;
      callback(null, { user: 'fixture-user' });
    },
  });
  smtp.on('error', () => {});
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  try {
    const port = (smtp.server.address() as { port: number }).port;
    await assert.rejects(
      () =>
        deliverSMTP(
          {
            host: '127.0.0.1',
            port,
            secure: false,
            from: 'haip@test.invalid',
            auth: { user: 'fixture-user', pass: 'fixture-password' },
          },
          true,
          message,
        ),
      /STARTTLS|TLS/i,
    );
    assert.equal(authenticated, 0);
  } finally {
    await new Promise<void>((resolve) => smtp.close(resolve));
  }
});
