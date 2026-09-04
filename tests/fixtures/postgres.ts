import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
export async function postgres() {
  const directory = await mkdtemp(join(tmpdir(), 'haip-test-pg-'));
  const bin =
    process.env.HAIP_TEST_PG_BIN ??
    execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  const port = await freePort();
  execFileSync(
    join(bin, 'initdb'),
    ['-D', directory, '-A', 'trust', '--no-locale', '-U', 'haip_test'],
    { stdio: 'pipe' },
  );
  execFileSync(
    join(bin, 'pg_ctl'),
    [
      '-D',
      directory,
      '-l',
      join(directory, 'server.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      '-w',
      'start',
    ],
    { stdio: 'pipe' },
  );
  return {
    url: `postgresql://haip_test@127.0.0.1:${port}/postgres`,
    directory,
    async close() {
      execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], {
        stdio: 'pipe',
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}
