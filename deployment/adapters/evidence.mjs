import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function readJsonDocument(path) {
  const bytes = await readFile(path);
  if (bytes.length > 1024 * 1024) throw new Error('Evidence input exceeds 1 MiB');
  return { bytes, document: JSON.parse(bytes.toString('utf8')) };
}

export async function readAcceptancePlan(path) {
  const { bytes, document } = await readJsonDocument(path);
  if (
    document.document_type !== 'plan' ||
    document.schema_version !== 'haip.deployment.acceptance.v1'
  )
    throw new Error('Expected an HAIP deployment acceptance plan');
  return { plan: document, digest: sha256(bytes) };
}

export async function privateDirectory(directory) {
  if (!isAbsolute(directory)) throw new Error('Evidence directory must be absolute');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error('Evidence directory must be a private directory with mode 0700');
  const canonical = await realpath(directory);
  const local = relative(await realpath(root), canonical);
  if (local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)))
    throw new Error('Evidence must remain outside the repository');
  return canonical;
}

export async function privateEvidence(directory, prefix, name, document) {
  const fileName = `${prefix}-${randomUUID()}.json`;
  const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  const file = await open(
    resolve(directory, fileName),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return {
    name,
    digest: sha256(bytes),
    recorded_at: document.recorded_at,
    reference: `private-evidence:${fileName}`,
  };
}
