import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:https';
import type { Socket } from 'node:net';
import { deliverWebhook } from '../haip-server/src/delivery.js';

const destination = 'https://receiver.test/events';
const addresses = [{ address: '93.184.216.34', family: 4 }];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a stalled DNS lookup expires without a later network request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (value: typeof addresses) => void;
  let requested = false;
  let result = 'pending';
  const sent = deliverWebhook(destination, {}, ['receiver.test'], {
    resolve: (() =>
      new Promise((resolve) => {
        answer = resolve;
      })) as any,
    request: (() => {
      requested = true;
      throw new Error('late delivery');
    }) as any,
  }).then(
    () => {
      result = 'accepted';
    },
    (error) => {
      result = error.message;
    },
  );
  t.mock.timers.tick(10001);
  await turn();
  assert.equal(result, 'webhook_timeout');
  answer(addresses);
  await sent;
  await turn();
  assert.equal(requested, false);
});

test('DNS and a stalled transport share one delivery deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (value: typeof addresses) => void;
  let destroyed = false;
  let result = 'pending';
  let respond!: (response: any) => void;
  const socket = Object.assign(new EventEmitter(), {
    end() {},
    destroy(error: Error) {
      destroyed = true;
      this.emit('error', error);
    },
  });
  const sent = deliverWebhook(destination, {}, ['receiver.test'], {
    resolve: (() =>
      new Promise((resolve) => {
        answer = resolve;
      })) as any,
    request: ((_url: URL, _options: unknown, callback: typeof respond) => {
      respond = callback;
      return socket;
    }) as any,
  }).then(
    () => {
      result = 'accepted';
    },
    (error) => {
      result = error.message;
    },
  );
  t.mock.timers.tick(6000);
  answer(addresses);
  await turn();
  assert.equal(result, 'pending');
  t.mock.timers.tick(4001);
  await turn();
  assert.equal(result, 'webhook_timeout');
  assert.equal(destroyed, true);
  respond(Object.assign(new EventEmitter(), { statusCode: 204, resume() {}, destroy() {} }));
  await sent;
  assert.equal(result, 'webhook_timeout');
});

test('unused webhook response bodies cannot retain background sockets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haip-webhook-body-'));
  const sockets = new Set<Socket>();
  let server: ReturnType<typeof createServer> | undefined;
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
        '/CN=receiver.test',
        '-addext',
        'subjectAltName=DNS:receiver.test',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'pipe' },
    );
    const cert = await readFile(join(directory, 'cert.pem'));
    let status = 200;
    let closed!: () => void;
    server = createServer(
      { key: await readFile(join(directory, 'key.pem')), cert },
      (incoming, response) => {
        incoming.resume();
        response.once('close', () => closed());
        response.writeHead(status, { 'Content-Type': 'text/plain' });
        response.write('The receiver deliberately keeps this response open.');
      },
    );
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const transport = {
      resolve: (async () => addresses) as any,
      request: ((_url: URL, options: any, callback: any) =>
        request(
          {
            ...options,
            hostname: '127.0.0.1',
            port,
            path: '/events',
            servername: 'receiver.test',
            ca: cert,
          },
          callback,
        )) as typeof request,
    };
    for (status of [200, 503]) {
      const disposed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const sent = deliverWebhook(destination, {}, ['receiver.test'], transport);
      if (status === 200) await sent;
      else await assert.rejects(sent, /webhook_not_accepted/);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        assert.equal(
          await Promise.race([
            disposed.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), 2000);
            }),
          ]),
          true,
          `Status ${status} left an unused response socket alive`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
