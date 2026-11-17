import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, realpath, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readJsonDocument } from './evidence.mjs';

const execute = promisify(execFile);

export async function stageExactFile(source, destination, expected) {
  if (!(await stat(source)).isFile()) throw new Error('Expected a regular acceptance input file');
  await copyFile(source, destination);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  if (`sha256:${hash.digest('hex')}` !== expected)
    throw new Error('Acceptance input digest differs');
  return destination;
}

export async function stageServerPackage(settings, deployment, directory) {
  const archive = await stageExactFile(
    settings.server_archive,
    join(directory, 'server.tgz'),
    deployment.service_artifact_digest,
  );
  const tarOptions = {
    timeout: 15_000,
    maxBuffer: 128 * 1024,
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  };
  const [{ stdout: names }, { stdout: listing }] = await Promise.all([
    execute('tar', ['-tf', archive], tarOptions),
    execute('tar', ['-tvf', archive], tarOptions),
  ]);
  const paths = names.trimEnd().split('\n');
  const entries = listing.trimEnd().split('\n');
  if (
    entries.length !== paths.length ||
    entries.some((entry) => !entry.startsWith('-')) ||
    paths.some(
      (name) =>
        !/^package\/(?:[A-Za-z0-9@._-]+\/)*[A-Za-z0-9@._-]+$/.test(name) ||
        name.split('/').some((part) => part === '.' || part === '..'),
    ) ||
    new Set(paths).size !== paths.length ||
    !paths.includes('package/package.json') ||
    !paths.includes('package/dist/main.js') ||
    !paths.includes('package/dist/backup-command.js') ||
    paths.some(
      (name) => name === 'package/node_modules' || name.startsWith('package/node_modules/'),
    )
  )
    throw new Error('Invalid server archive contents');
  await execute(
    'tar',
    ['-xf', archive, '--no-same-permissions', '--no-same-owner', '-C', directory],
    tarOptions,
  );
  const packageRoot = join(directory, 'package');
  const { document } = await readJsonDocument(join(packageRoot, 'package.json'));
  if (document.name !== '@haip/server' || document.version !== deployment.protocol_revision)
    throw new Error('Unexpected server package revision');
  const dependencies = await realpath(settings.node_modules);
  if (!(await stat(dependencies)).isDirectory())
    throw new Error('Expected the installed dependencies directory');
  await symlink(dependencies, join(packageRoot, 'node_modules'), 'dir');
  return join(packageRoot, 'dist');
}
