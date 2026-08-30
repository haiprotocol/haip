import { open, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalise, parseJson } from '@haip/protocol/crypto';
import type { SignedRecord } from '@haip/protocol';
import type { SafetyStore } from '../../haip-server/src/recovery.js';
/** Separate on-disk test fixture, not an independently administered production store. */
export class TestSafetyStore implements SafetyStore {
  readonly production = false;
  unavailable = false;
  loseNextWrite = false;
  constructor(readonly directory: string) {}
  async read(key: string): Promise<SignedRecord | undefined> {
    if (this.unavailable) throw new Error('fixture_storage_outage');
    try {
      return parseJson(await readFile(join(this.directory, key), 'utf8')) as SignedRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  async create(key: string, record: SignedRecord) {
    if (this.unavailable) throw new Error('fixture_storage_outage');
    await mkdir(this.directory, { recursive: true });
    try {
      const fd = await open(join(this.directory, key), 'wx', 0o600);
      try {
        await fd.writeFile(canonicalise(record));
        await fd.sync();
      } finally {
        await fd.close();
      }
      const dir = await open(this.directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (this.loseNextWrite) {
      this.loseNextWrite = false;
      throw new Error('fixture_lost_acknowledgement');
    }
    return (await this.read(key))!;
  }
}
