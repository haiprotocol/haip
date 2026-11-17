import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function localCertificates(directory: string, names: string[]) {
  const caPath = join(directory, 'ca.pem');
  const caKey = join(directory, 'ca.key');
  const keyPath = join(directory, 'server.key');
  const csrPath = join(directory, 'server.csr');
  const certPath = join(directory, 'server.pem');
  const extensionPath = join(directory, 'extensions.cnf');
  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caPath,
    '-days',
    '1',
    '-subj',
    '/CN=HAIP local fixture CA',
  ]);
  await execute('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    csrPath,
    '-subj',
    '/CN=HAIP local TLS fixture',
  ]);
  await Promise.all([chmod(caKey, 0o600), chmod(keyPath, 0o600)]);
  await writeFile(extensionPath, `subjectAltName=${names.join(',')}\n`);
  await execute('openssl', [
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    caPath,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    certPath,
    '-days',
    '1',
    '-extfile',
    extensionPath,
  ]);
  return { caPath, ca: await readFile(caPath), keyPath, certPath };
}
