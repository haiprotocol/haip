import { readFile } from 'node:fs/promises';
import { createBackup, restoreBackup, pruneBackups } from '../haip-server/dist/backup.js';
import { databaseConnection } from '../haip-server/dist/startup.js';
const [operation, path] = process.argv.slice(2);
if (!['create', 'restore', 'prune'].includes(operation) || !path)
  throw new Error('Usage: node scripts/backup.mjs create|restore|prune PATH');
if (operation === 'prune') console.log(JSON.stringify(await pruneBackups(path)));
else {
  if (!process.env.HAIP_DATABASE_URL || !process.env.HAIP_BACKUP_KEY_FILE)
    throw new Error('HAIP_DATABASE_URL and HAIP_BACKUP_KEY_FILE are required');
  const mode = process.env.HAIP_MODE ?? 'development';
  if (mode !== 'development' && mode !== 'production')
    throw new Error('HAIP_MODE must be development or production');
  let database = process.env.HAIP_DATABASE_URL;
  if (mode === 'production') {
    const { url, options } = databaseConnection(mode, database);
    const connection = new URL(url);
    connection.searchParams.set('sslmode', 'verify-full');
    connection.searchParams.set('sslrootcert', process.env.HAIP_DATABASE_CA_FILE || 'system');
    connection.searchParams.set('gssencmode', 'disable');
    if (options.sslnegotiation)
      connection.searchParams.set('sslnegotiation', options.sslnegotiation);
    database = connection.href;
  }
  const key = await readFile(process.env.HAIP_BACKUP_KEY_FILE);
  console.log(
    JSON.stringify(
      await (operation === 'create' ? createBackup : restoreBackup)(
        database,
        path,
        key,
        process.env.HAIP_PG_BIN ?? '',
      ),
    ),
  );
}
