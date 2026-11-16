import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';
import { get } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { freePort } from './postgres.js';

const execute = promisify(execFile);

export async function caddyFixture(
  binary: string,
  directory: string,
  certPath: string,
  keyPath: string,
  createApps: (port: number) => { trusted: RequestListener; sandbox: RequestListener },
) {
  const trusted = createServer();
  const sandbox = createServer();
  const portOf = (server: Server) => (server.address() as { port: number }).port;
  let running: ReturnType<typeof execute> | undefined;
  let stoppingUpstreams: Promise<void> | undefined;
  const stopUpstreams = () => {
    stoppingUpstreams ??= Promise.all(
      [trusted, sandbox].map(
        (server) =>
          new Promise<void>((complete) => {
            server.close(() => complete());
            server.closeAllConnections();
          }),
      ),
    ).then(() => {});
    return stoppingUpstreams;
  };
  const close = async () => {
    if (running) {
      running.child.kill('SIGTERM');
      await running.catch(() => {});
    }
    await stopUpstreams();
  };
  try {
    for (const server of [trusted, sandbox]) await once(server.listen(0, '127.0.0.1'), 'listening');
    const port = await freePort();
    const application = createApps(port);
    trusted.on('request', application.trusted);
    sandbox.on('request', application.sandbox);
    const file = join(directory, 'Caddyfile');
    const source = await readFile('deployment/Caddyfile', 'utf8');
    const local = source.replace(
      /^\{\n/,
      '{\n\tdefault_bind 127.0.0.1\n\tauto_https disable_redirects\n',
    );
    if (local === source) throw new Error('Expected a Caddyfile with global options');
    await writeFile(file, local, { mode: 0o600 });
    running = execute(binary, ['run', '--config', file, '--adapter', 'caddyfile'], {
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: directory,
        XDG_DATA_HOME: directory,
        PORT: String(portOf(trusted)),
        HAIP_SANDBOX_PORT: String(portOf(sandbox)),
        HAIP_PROXY_HTTPS_PORT: String(port),
        HAIP_TRUSTED_HOST: 'review.trusted.test',
        HAIP_SANDBOX_SITE: 'sandbox.test',
        HAIP_TRUSTED_CERT_FILE: certPath,
        HAIP_TRUSTED_KEY_FILE: keyPath,
        HAIP_SANDBOX_CERT_FILE: certPath,
        HAIP_SANDBOX_KEY_FILE: keyPath,
      },
      timeout: 120_000,
    });
    const child = running.child;
    const ready = new Promise<void>((resolve, reject) => {
      let logs = '';
      child.stderr!.on('data', (part: Buffer) => {
        logs = (logs + part.toString('utf8')).slice(-4096);
        if (logs.includes('serving initial configuration')) resolve();
      });
      child.once('close', () => reject(new Error(`Caddy exited during startup\n${logs}`)));
      child.once('error', reject);
    });
    void running.catch(() => {});
    await ready;
    return { port, stopUpstreams, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function caddyResponse(url: URL, ca: Buffer) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = get(
        {
          hostname: '127.0.0.1',
          servername: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          headers: { Host: url.host },
          ca,
          signal: AbortSignal.timeout(5000),
        },
        (response) => {
          response.on('error', reject);
          response.on('end', () =>
            resolve({ status: response.statusCode, headers: response.headers }),
          );
          response.resume();
        },
      );
      request.once('error', reject);
    },
  );
}
