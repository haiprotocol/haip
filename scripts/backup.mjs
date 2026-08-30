import { readFile } from 'node:fs/promises';
import { createBackup, restoreBackup, pruneBackups } from '../haip-server/dist/backup.js';
const [operation, path] = process.argv.slice(2);
if (!['create', 'restore', 'prune'].includes(operation) || !path)
  throw new Error('Usage: node scripts/backup.mjs create|restore|prune PATH');
if (operation === 'prune') console.log(JSON.stringify(await pruneBackups(path)));
else {
  if (!process.env.HAIP_DATABASE_URL || !process.env.HAIP_BACKUP_KEY_FILE)
    throw new Error('HAIP_DATABASE_URL and HAIP_BACKUP_KEY_FILE are required');
  const key = await readFile(process.env.HAIP_BACKUP_KEY_FILE);
  console.log(
    JSON.stringify(
      await (operation === 'create' ? createBackup : restoreBackup)(
        process.env.HAIP_DATABASE_URL,
        path,
        key,
        process.env.HAIP_PG_BIN ?? '',
      ),
    ),
  );
}
