import { open, readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalise, digestBytes } from '@haip/protocol/crypto';
import type { SignedRecord } from '@haip/protocol';
import type { AnchorStore, AnchorAcceptance } from '../../haip-server/src/anchor.js';
/** Test-only immutable filesystem store; never advertises S3 or independent administration. */
export class TestAnchor implements AnchorStore {
  readonly production = false;
  unavailable = false;
  conflict = false;
  constructor(readonly root: string) {}
  async accept(record: SignedRecord): Promise<AnchorAcceptance> {
    if (this.unavailable) throw new Error('test_anchor_outage');
    if (this.conflict) throw new Error('anchor_conflict');
    const p = record.payload as any;
    const namespace = join(this.root, p.ledger_id, p.generation);
    await mkdir(namespace, { recursive: true });
    const path = join(namespace, String(p.sequence) + '.json');
    const body = canonicalise(record);
    try {
      const fd = await open(path, 'wx');
      try {
        await fd.writeFile(body);
        await fd.sync();
      } finally {
        await fd.close();
      }
    } catch (e) {
      if ((e as any).code !== 'EEXIST') throw e;
      if ((await readFile(path, 'utf8')) !== body) throw new Error('anchor_conflict');
    }
    return {
      backend: 'test_filesystem',
      key: path,
      version_id: digestBytes(body),
      digest: digestBytes(body),
      retained_until: new Date(Date.now() + 90 * 86400000).toISOString(),
    };
  }
  async history(ledger: string, generation: string) {
    const path = join(this.root, ledger, generation);
    let files: string[];
    try {
      files = await readdir(path);
    } catch (e) {
      if ((e as any).code === 'ENOENT') return [];
      throw e;
    }
    return Promise.all(
      files.map(async (file) => {
        const r = JSON.parse(await readFile(join(path, file), 'utf8'));
        return { sequence: r.payload.sequence, head: r.payload.head };
      }),
    );
  }
}
