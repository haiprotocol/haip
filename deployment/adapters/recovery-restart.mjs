import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { digest } from '@haip/protocol/crypto';

const execute = promisify(execFile);
const loopback = '127.0.0.1';
const readyLine = 'HAIP draft service:';
const recoveryRequired =
  'Offline namespace recovery is required before opening production listeners';
const commandOptions = { timeout: 120_000, maxBuffer: 32 * 1024, killSignal: 'SIGKILL' };

function expect(condition) {
  if (!condition) throw new Error('Restart observation differed from the recovery plan');
}

async function loopbackPorts() {
  const sockets = [createServer(), createServer()];
  try {
    for (const socket of sockets) await once(socket.listen(0, loopback), 'listening');
    return sockets.map((socket) => socket.address().port);
  } finally {
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
  }
}

async function probe(port, host, path, { method = 'GET', token, body, inspectError = false } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: loopback,
        port,
        method,
        path,
        signal: AbortSignal.timeout(5_000),
        headers: {
          Host: host,
          Connection: 'close',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
        },
      },
      (incoming) => {
        incoming.on('error', reject);
        if (!inspectError) {
          incoming.resume();
          incoming.on('end', () => resolve({ status: incoming.statusCode }));
          return;
        }
        let content = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => {
          content += chunk;
          if (content.length > 4096) incoming.destroy(new Error('Unexpected probe response'));
        });
        incoming.on('end', () => {
          try {
            resolve({ status: incoming.statusCode, error: JSON.parse(content).error });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function ready(command) {
  return new Promise((resolve, reject) => {
    let output = '';
    const stream = command.child.stdout;
    const read = (chunk) => {
      output += chunk.toString('utf8');
      if (output.split('\n').some((line) => line.startsWith(readyLine))) {
        stream.off('data', read);
        resolve();
      }
    };
    stream.on('data', read);
    command.then(
      () => reject(new Error('Runtime exited before startup')),
      () => reject(new Error('Runtime failed before startup')),
    );
  });
}

async function stop(command) {
  const child = command.child;
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    await command;
  } finally {
    clearTimeout(deadline);
  }
}

export async function checkRecoveredStart({
  args,
  env,
  request: canary,
  operatorToken,
  oldToken,
  producerConfig,
}) {
  const [trustedPort, sandboxPort] = await loopbackPorts();
  const host = new URL(env.HAIP_ORIGIN).host;
  const label = '1';
  const sandboxHost = new URL(env.HAIP_SANDBOX_ORIGIN.replace('{scope}', label)).host;
  const scope = label.padStart(64, '0');
  const command = execute(process.execPath, args, {
    ...commandOptions,
    env: {
      ...env,
      HAIP_LISTEN_HOST: loopback,
      PORT: String(trustedPort),
      HAIP_SANDBOX_PORT: String(sandboxPort),
    },
  });
  try {
    await ready(command);
    const [health, sandbox, metrics] = await Promise.all([
      probe(trustedPort, host, '/health'),
      probe(sandboxPort, sandboxHost, '/sandbox/' + scope),
      probe(trustedPort, host, '/v2/admin/metrics', { token: operatorToken }),
    ]);
    expect([health, sandbox, metrics].every(({ status }) => status === 200));
    const claimPath = '/v2/requests/' + canary.id + '/claims';
    const claim = {
      execution_identity: 'recovery-probe-' + randomUUID(),
      execution_binding_digest: digest(canary.execution),
    };
    const oldClaim = await probe(trustedPort, host, claimPath, {
      method: 'POST',
      token: oldToken,
      body: claim,
    });
    expect(oldClaim.status === 401);

    const freshToken = randomBytes(32).toString('base64url');
    const issuer = await probe(
      trustedPort,
      host,
      '/v2/admin/principals/' + encodeURIComponent(canary.producer),
      {
        method: 'PUT',
        token: operatorToken,
        body: { id: canary.producer, kind: 'producer', token: freshToken, config: producerConfig },
      },
    );
    expect(issuer.status === 200);
    const freshClaim = await probe(trustedPort, host, claimPath, {
      method: 'POST',
      token: freshToken,
      body: claim,
      inspectError: true,
    });
    expect(freshClaim.status === 409 && freshClaim.error === 'namespace_retired');
    return { oldClaimStatus: oldClaim.status, freshClaimStatus: freshClaim.status };
  } finally {
    await stop(command);
  }
}

export async function checkRestartRefused(args, env) {
  const result = await execute(process.execPath, args, {
    ...commandOptions,
    env: { ...env, HAIP_LISTEN_HOST: loopback, PORT: '0', HAIP_SANDBOX_PORT: '0' },
  }).then(
    () => null,
    (error) => error,
  );
  expect(
    Number.isInteger(result?.code) &&
      result.code !== 0 &&
      result.stderr?.includes(recoveryRequired) &&
      !result.stdout?.includes(readyLine),
  );
}
