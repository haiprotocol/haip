import { Server } from 'node:net';
import { join } from 'node:path';
import { AzureAnchor, AzureSafetyStore } from '../../haip-server/dist/anchor.js';
import { TestAnchor } from './anchor.js';
import { TestSafetyStore } from './safety.js';

const directory = process.env.HAIP_TEST_STORAGE_ROOT;
if (!directory) throw new Error('HAIP_TEST_STORAGE_ROOT is required');

// Replace only storage I/O in the child process. The signed files outlive each process and stay outside the database backup.
const anchor = new TestAnchor(join(directory, 'checkpoints'));
const safety = new TestSafetyStore(join(directory, 'safety'));
AzureAnchor.prototype.accept = anchor.accept.bind(anchor);
AzureAnchor.prototype.history = anchor.history.bind(anchor);
AzureSafetyStore.prototype.read = safety.read.bind(safety);
AzureSafetyStore.prototype.create = safety.create.bind(safety);

if (process.env.HAIP_TEST_EXPECT_OFFLINE === '1') {
  Server.prototype.listen = () => {
    throw new Error('An offline command attempted to start a listener');
  };
}
