import { randomUUID } from 'node:crypto';
import { digest, signRecord, verifyRecord } from '@haip/protocol/crypto';
import { PROTOCOL_REVISION, type SignedRecord } from '@haip/protocol';
import type { ServiceConfig } from './config.js';
import { requireThat } from './errors.js';
import type { SafetyStore } from './recovery.js';
import type { Tx } from './store.js';

interface Head {
  binding: string;
  sequence: string;
  nonce: string;
}

interface Incarnation {
  epoch: string;
  deployment: string;
  database: string;
}

type Signer = Pick<ServiceConfig, 'issuer' | 'signingKey' | 'keyId' | 'trust'>;
const audience = 'haip.recovery';
const profile = 'haip.managed-witness.v1';
const maxSequence = 9223372036854775807n;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export class CommitWitness {
  private readonly binding: string;
  private readonly scope: string;

  constructor(
    private readonly storage: SafetyStore,
    private readonly signer: Signer,
    incarnation: Incarnation,
  ) {
    const { epoch, deployment, database } = incarnation;
    requireThat(
      uuid.test(epoch) &&
        deployment.length > 0 &&
        deployment.length <= 160 &&
        /^sha256:[a-f0-9]{64}$/.test(database),
      500,
      'managed_incarnation_invalid',
    );
    this.scope = digest({ profile, issuer: signer.issuer, epoch });
    this.binding = digest({ scope: this.scope, deployment, database });
  }

  private key(slot: string) {
    return digest({ scope: this.scope, slot }).slice(7);
  }

  private verify(key: string, record: SignedRecord) {
    verifyRecord(record, this.signer.trust, {
      issuer: this.signer.issuer,
      audience,
      type: 'RecoveryFence',
      purpose: 'service',
      tenant: key,
    });
    const payload = record.payload as { key?: unknown; value?: unknown };
    requireThat(
      payload?.key === key && Object.hasOwn(payload, 'value'),
      503,
      'managed_witness_invalid',
    );
    return payload.value;
  }

  private async present(slot: string) {
    const key = this.key(slot);
    const record = await this.storage.read(key);
    return record ? { value: this.verify(key, record) } : undefined;
  }

  private async reserve(slot: string, value: unknown) {
    const key = this.key(slot);
    const record = signRecord(
      { key, value },
      {
        type: 'RecoveryFence',
        purpose: 'service',
        profiles: {},
        protocol_revision: PROTOCOL_REVISION,
        issuer: this.signer.issuer,
        audience,
        tenant: key,
        key_id: this.signer.keyId,
        issued_at: new Date().toISOString(),
      },
      this.signer.signingKey,
    );
    const accepted = await this.storage.create(key, record);
    requireThat(
      digest(this.verify(key, accepted)) === digest(value),
      503,
      'managed_witness_conflict',
    );
  }

  private async head(tx: Tx, lock: boolean): Promise<Head> {
    const { rows } = await tx.query<Head>(
      lock
        ? 'SELECT binding,sequence::text,nonce FROM haip_managed_head WHERE singleton FOR UPDATE'
        : 'SELECT binding,sequence::text,nonce FROM haip_managed_head WHERE singleton',
    );
    const head = rows[0];
    requireThat(
      head && head.binding === this.binding && uuid.test(head.nonce),
      503,
      'managed_binding_changed',
    );
    return head;
  }

  private async compare(head: Head) {
    const [current, next, retired] = await Promise.all([
      this.present(head.sequence),
      this.present(String(BigInt(head.sequence) + 1n)),
      this.present('retired'),
    ]);
    requireThat(!retired, 503, 'managed_incarnation_retired');
    requireThat(
      current && digest(current.value) === digest(head) && !next,
      503,
      'managed_state_diverged',
    );
  }

  async provision(tx: Tx): Promise<void> {
    const next: Head = { binding: this.binding, sequence: '0', nonce: randomUUID() };
    requireThat(!(await this.present('retired')), 503, 'managed_incarnation_retired');
    await tx.query(
      'INSERT INTO haip_managed_head (singleton,binding,sequence,nonce) VALUES (true,$1,$2,$3)',
      [next.binding, next.sequence, next.nonce],
    );
    await this.reserve('0', next);
    requireThat(!(await this.present('retired')), 503, 'managed_incarnation_retired');
  }

  async retire(): Promise<void> {
    await this.reserve('retired', { binding: this.binding });
  }

  async read<T>(tx: Tx, read: () => Promise<T>): Promise<T> {
    const head = await this.head(tx, false);
    await this.compare(head);
    const result = await read();
    await this.compare(head);
    return result;
  }

  async write<T>(tx: Tx, write: () => Promise<T>): Promise<T> {
    const head = await this.head(tx, true);
    await this.compare(head);
    const sequence = BigInt(head.sequence) + 1n;
    requireThat(sequence < maxSequence, 503, 'managed_sequence_exhausted');
    const result = await write();
    const next: Head = { binding: this.binding, sequence: String(sequence), nonce: randomUUID() };
    // The database stamp and the caller's writes commit together. An external successor without that stamp requires recovery.
    await this.reserve(next.sequence, next);
    await this.compare(next);
    await tx.query('UPDATE haip_managed_head SET sequence=$1,nonce=$2 WHERE singleton', [
      next.sequence,
      next.nonce,
    ]);
    return result;
  }
}
