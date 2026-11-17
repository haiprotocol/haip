import { open, readFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalise, digestBytes } from '@haip/protocol/crypto';
import type { SignedRecord } from '@haip/protocol';
import type { AnchorStore, AnchorAcceptance } from '../../haip-server/src/anchor.js';
import { ProtocolError, requireThat } from '../../haip-server/src/errors.js';
/** Test-only immutable filesystem store; never advertises S3 or independent administration. */
export class TestAnchor implements AnchorStore {
  readonly production = false;
  unavailable = false;
  conflict = false;
  constructor(readonly root: string) {}
  private path(record: SignedRecord) {
    const { ledger_id, generation, sequence } = record.payload as {
      ledger_id: string;
      generation: string;
      sequence: number;
    };
    return join(this.root, ledger_id, generation, String(sequence) + '.json');
  }
  async accept(record: SignedRecord): Promise<AnchorAcceptance> {
    if (this.unavailable) throw new Error('test_anchor_outage');
    if (this.conflict) throw new Error('anchor_conflict');
    const path = this.path(record);
    await mkdir(dirname(path), { recursive: true });
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
  async verifyAcceptance(record: SignedRecord, acceptance: AnchorAcceptance) {
    requireThat(!this.unavailable, 503, 'anchor_unavailable');
    const path = this.path(record),
      body = canonicalise(record),
      hash = digestBytes(body);
    requireThat(
      !this.conflict &&
        acceptance.backend === 'test_filesystem' &&
        acceptance.key === path &&
        acceptance.version_id === hash &&
        acceptance.digest === hash,
      503,
      'anchor_conflict',
    );
    const stored = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') throw new ProtocolError(503, 'anchor_version_conflict');
      throw error;
    });
    requireThat(stored === body, 503, 'anchor_conflict');
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
