import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { canonicalise, signRecord } from '@haip/protocol/crypto';
import { PROTOCOL_REVISION } from '@haip/protocol';
import { AzureAnchor, AzureSafetyStore } from '../haip-server/src/anchor.js';

test('Azure adapter checks exact versions, retention, conditional duplicate recovery and permanent safety holds', async () => {
  const keys = generateKeyPairSync('ed25519'),
    issuer = 'https://haip.test';
  const trust = {
    issuer,
    protocol_revision: PROTOCOL_REVISION,
    keys: [
      {
        key_id: 'test',
        algorithm: 'Ed25519' as const,
        public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        not_before: '2020-01-01T00:00:00Z',
        not_after: '2099-01-01T00:00:00Z',
      },
    ],
  };
  const ledger = randomUUID(),
    generation = randomUUID();
  const signed = (type: string, tenant: string, audience: string, payload: unknown) =>
    signRecord(
      payload,
      {
        type,
        tenant,
        audience,
        issuer,
        purpose: 'service',
        profiles: {},
        protocol_revision: PROTOCOL_REVISION,
        key_id: 'test',
        issued_at: new Date().toISOString(),
      },
      keys.privateKey,
    );
  const checkpoint = signed('AuditCheckpoint', ledger, 'haip.audit', {
    ledger_id: ledger,
    generation,
    sequence: 1,
    head: 'sha256:' + '1'.repeat(64),
  });
  const anchor = new AzureAnchor('https://fixture.blob.core.windows.net', 'test', 'test', trust);
  const safety = new AzureSafetyStore(
    'https://fixture.blob.core.windows.net',
    'test',
    'test',
    trust,
  );
  const objects = new Map<string, any>();
  let duplicate = false,
    marker = false,
    shortRetention = false,
    hold = true;
  const container = {
    async *listBlobsFlat(options: any) {
      const rows = [...objects.values()].filter((o) => o.name.startsWith(options.prefix));
      for (const o of duplicate ? [...rows, ...rows] : rows)
        yield {
          name: o.name,
          versionId: o.version,
          isCurrentVersion: !marker,
          deleted: marker,
          snapshot: '',
        };
    },
    getBlockBlobClient(name: string) {
      return {
        async upload(body: string, length: number, options: any) {
          assert.equal(options.conditions.ifNoneMatch, '*');
          assert.equal(options.immutabilityPolicy.policyMode, 'Locked');
          assert.equal(length, Buffer.byteLength(body));
          if (objects.has(name)) throw { statusCode: 412 };
          objects.set(name, {
            name,
            body,
            version: randomUUID(),
            retention: options.immutabilityPolicy.expiriesOn,
          });
        },
      };
    },
    getBlobClient(name: string) {
      return {
        withVersion(version: string) {
          const object = objects.get(name);
          assert.equal(version, object.version, 'read exact version');
          return {
            async getProperties() {
              return {
                versionId: version,
                immutabilityPolicyMode: 'Locked',
                immutabilityPolicyExpiresOn: shortRetention ? new Date(0) : object.retention,
                legalHold: hold,
              };
            },
            async downloadToBuffer() {
              return Buffer.from(object.body);
            },
          };
        },
      };
    },
  };
  // This transport exercises adapter decisions, not a live Azure account or RBAC policy.
  (anchor as any).container = container;
  (safety as any).container = container;
  const first = await anchor.accept(checkpoint);
  assert.deepEqual(await anchor.accept(checkpoint), first);
  assert.deepEqual(await anchor.history(ledger, generation), [
    { sequence: 1, head: (checkpoint.payload as any).head },
  ]);
  const conflict = structuredClone(checkpoint);
  (conflict.payload as any).head = 'sha256:' + '2'.repeat(64);
  conflict.signature = signRecord(conflict.payload, conflict.protected, keys.privateKey).signature;
  await assert.rejects(anchor.accept(conflict), /anchor_conflict/);
  duplicate = true;
  await assert.rejects(anchor.accept(checkpoint), /anchor_version_conflict/);
  duplicate = false;
  marker = true;
  await assert.rejects(anchor.history(ledger, generation), /anchor_deleted_version/);
  marker = false;
  shortRetention = true;
  await assert.rejects(anchor.history(ledger, generation), /anchor_history_invalid/);
  shortRetention = false;
  const key = 'a'.repeat(64),
    record = signed('RecoveryFence', key, 'haip.recovery', { key, value: { retired: true } });
  assert.equal(canonicalise(await safety.create(key, record)), canonicalise(record));
  assert.equal(canonicalise(await safety.create(key, record)), canonicalise(record));
  hold = false;
  await assert.rejects(safety.read(key), /recovery_hold_missing/);
});
