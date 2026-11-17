import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { AnchorProof, SignedRecord, TrustManifest } from './generated.js';
import { PROTOCOL_REVISION } from './index.js';

export { canonicalise, parseJson } from './json.js';
import { canonicalise } from './json.js';
export const digestBytes = (bytes: string | Uint8Array): string =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
export const digest = (value: unknown): string => digestBytes(canonicalise(value));
export function signRecord(
  payload: unknown,
  header: SignedRecord['protected'],
  key: KeyObject,
): SignedRecord {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required');
  const body = { protected: header, payload };
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalise(body)), key).toString('base64url'),
  };
}
export function verifyRecord(
  record: SignedRecord,
  trust: TrustManifest,
  expected: { issuer: string; audience: string; type: string; tenant?: string; purpose?: string },
  at?: Date,
): void {
  const h = record.protected;
  if (
    h.issuer !== expected.issuer ||
    trust.issuer !== expected.issuer ||
    trust.protocol_revision !== PROTOCOL_REVISION ||
    h.audience !== expected.audience ||
    h.type !== expected.type ||
    h.protocol_revision !== PROTOCOL_REVISION ||
    (expected.tenant !== undefined && h.tenant !== expected.tenant) ||
    (expected.purpose !== undefined && h.purpose !== expected.purpose)
  )
    throw new Error('Signing identity or purpose mismatch');
  const key = trust.keys.find((k) => k.key_id === h.key_id);
  const issued = Date.parse(h.issued_at);
  if (
    !key ||
    key.algorithm !== 'Ed25519' ||
    !Number.isFinite(issued) ||
    !Number.isFinite(Date.parse(key.not_before)) ||
    !Number.isFinite(Date.parse(key.not_after)) ||
    issued < Date.parse(key.not_before) ||
    issued >= Date.parse(key.not_after) ||
    (key.revoked_at &&
      (!Number.isFinite(Date.parse(key.revoked_at)) || issued >= Date.parse(key.revoked_at))) ||
    (at && issued > at.getTime() + 30000)
  )
    throw new Error('Untrusted or invalid signing key');
  const pk = createPublicKey(key.public_key);
  if (
    pk.asymmetricKeyType !== 'ed25519' ||
    !/^[A-Za-z0-9_-]{86}$/.test(record.signature) ||
    !verify(
      null,
      Buffer.from(canonicalise({ protected: h, payload: record.payload })),
      pk,
      Buffer.from(record.signature, 'base64url'),
    )
  )
    throw new Error('Invalid signature');
}

export function verifyCheckpointProof(
  { checkpoint, proof }: Pick<AnchorProof, 'checkpoint' | 'proof'>,
  receiptDigest: string,
): void {
  if (proof[0]?.record_digest !== receiptDigest)
    throw new Error('Checkpoint does not include the receipt');
  let previous: string | undefined;
  let sequence: number | undefined;
  for (const node of proof) {
    if (
      !Number.isSafeInteger(node.sequence) ||
      node.head !==
        digest({
          previous: node.previous_head,
          sequence: node.sequence,
          record_digest: node.record_digest,
        }) ||
      (previous !== undefined && node.previous_head !== previous) ||
      (sequence !== undefined && node.sequence !== sequence + 1)
    )
      throw new Error('Invalid checkpoint chain');
    previous = node.head;
    sequence = node.sequence;
  }
  const payload = checkpoint.payload as { head?: string; sequence?: number } | null;
  if (previous !== payload?.head || sequence !== payload?.sequence)
    throw new Error('Checkpoint prefix mismatch');
}
