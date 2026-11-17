import { collectBackupRecovery } from '../../deployment/adapters/backup-recovery.mjs';

const [plan, evidence, settings] = process.argv.slice(2);
const storage = process.env.HAIP_TEST_STORAGE_ROOT;
if (!storage) throw new Error('HAIP_TEST_STORAGE_ROOT is required');

const result = await collectBackupRecovery(plan, evidence, settings, {
  checkId: process.env.HAIP_ACCEPTANCE_CHECK_ID,
  fixture: {
    preload: ['--import', 'tsx', '--import', './tests/fixtures/standalone-storage.ts'],
    environment: { HAIP_TEST_STORAGE_ROOT: storage },
  },
});
console.log(JSON.stringify(result));
