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
  const anchor = new AzureAnchor('https://fixture.blob.core.windows.net/', 'test', 'test', trust);
  const safety = new AzureSafetyStore(
    'https://fixture.blob.core.windows.net',
    'safety',
    'test',
    trust,
  );
  const checkpoints = new Map<string, any>(),
    safetyRecords = new Map<string, any>();
  let duplicate = false,
    snapshot = '',
    marker = false,
    shortRetention = false,
    retentionMode = 'Locked',
    safetyHold = true,
    replaceAcknowledgement = false,
    omitAcknowledgement = false,
    extraBytes = false,
    malformedBytes = false,
    mismatchedReadVersion = false,
    downloadCount = 0;
  const inheritedContainer = (objects: Map<string, any>, legalHold: () => boolean) => ({
    async *listBlobsFlat(options: any) {
      const rows = [...objects.values()].filter((o) => o.name.startsWith(options.prefix));
      for (const o of duplicate ? [...rows, ...rows] : rows)
        yield {
          name: o.name,
          versionId: o.version,
          isCurrentVersion: !marker,
          deleted: marker,
          snapshot,
        };
    },
    getBlockBlobClient(name: string) {
      return {
        async upload(body: string, length: number, options: any) {
          assert.equal(options.conditions.ifNoneMatch, '*');
          assert.equal(options.blobHTTPHeaders.blobContentType, 'application/json');
          assert.equal('immutabilityPolicy' in options, false);
          assert.equal('legalHold' in options, false);
          assert.equal(length, Buffer.byteLength(body));
          if (objects.has(name)) throw { statusCode: 412 };
          const version = randomUUID();
          objects.set(name, {
            name,
            body,
            version,
            retention: new Date(Date.now() + 90 * 86400000 + 1000),
          });
          return {
            versionId: omitAcknowledgement
              ? undefined
              : replaceAcknowledgement
                ? randomUUID()
                : version,
          };
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
                versionId: mismatchedReadVersion ? randomUUID() : version,
                immutabilityPolicyMode: retentionMode,
                immutabilityPolicyExpiresOn: shortRetention ? new Date(0) : object.retention,
                legalHold: legalHold(),
                contentLength: extraBytes ? 64 * 1024 + 1 : Buffer.byteLength(object.body),
                etag: '"fixture-etag"',
              };
            },
            async downloadToBuffer(offset: number, length: number, options: unknown) {
              downloadCount++;
              assert.equal(offset, 0);
              assert.equal(length, Buffer.byteLength(object.body));
              assert.deepEqual(options, { conditions: { ifMatch: '"fixture-etag"' } });
              const bytes = Buffer.from(object.body);
              if (malformedBytes) bytes[0] = 0xff;
              return bytes;
            },
          };
        },
      };
    },
  });
  // These transports model the checkpoint default policy and safety container policy, not a live Azure account or RBAC policy.
  (anchor as any).container = inheritedContainer(checkpoints, () => false);
  (safety as any).container = inheritedContainer(safetyRecords, () => safetyHold);
  const first = await anchor.accept(checkpoint);
  retentionMode = 'locked';
  assert.deepEqual(await anchor.accept(checkpoint), first);
  retentionMode = 'unlocked';
  await assert.rejects(anchor.accept(checkpoint), /anchor_retention_invalid/);
  retentionMode = 'Locked';
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
  snapshot = '2026-09-04T00:00:00.0000000Z';
  await assert.rejects(anchor.accept(checkpoint), /anchor_version_conflict/);
  snapshot = '';
  marker = true;
  await assert.rejects(anchor.history(ledger, generation), /anchor_deleted_version/);
  marker = false;
  shortRetention = true;
  await assert.rejects(anchor.history(ledger, generation), /anchor_history_invalid/);
  shortRetention = false;
  mismatchedReadVersion = true;
  await assert.rejects(anchor.history(ledger, generation), /anchor_version_conflict/);
  mismatchedReadVersion = false;
  extraBytes = true;
  const beforeLargeRecord = downloadCount;
  await assert.rejects(anchor.history(ledger, generation), /anchor_history_invalid/);
  assert.equal(downloadCount, beforeLargeRecord);
  extraBytes = false;
  malformedBytes = true;
  await assert.rejects(anchor.history(ledger, generation), /anchor_history_invalid/);
  malformedBytes = false;

  const second = signed('AuditCheckpoint', ledger, 'haip.audit', {
    ledger_id: ledger,
    generation,
    sequence: 2,
    head: 'sha256:' + '3'.repeat(64),
  });
  const beforeWrongVersion = downloadCount;
  replaceAcknowledgement = true;
  await assert.rejects(anchor.accept(second), /anchor_version_conflict/);
  assert.equal(downloadCount, beforeWrongVersion);
  replaceAcknowledgement = false;
  const recovered = await anchor.accept(second);
  assert.equal(recovered.version_id, checkpoints.get(recovered.key).version);

  const key = 'a'.repeat(64),
    record = signed('RecoveryFence', key, 'haip.recovery', { key, value: { retired: true } });
  omitAcknowledgement = true;
  const beforeMissingVersion = downloadCount;
  await assert.rejects(safety.create(key, record), /anchor_version_conflict/);
  assert.equal(downloadCount, beforeMissingVersion);
  omitAcknowledgement = false;
  assert.equal(canonicalise(await safety.create(key, record)), canonicalise(record));
  const contender = signed('RecoveryFence', key, 'haip.recovery', { key, value: 'new value' });
  assert.equal(canonicalise(await safety.create(key, contender)), canonicalise(record));
  shortRetention = true;
  await assert.rejects(safety.read(key), /anchor_retention_invalid/);
  await assert.rejects(safety.create(key, record), /anchor_retention_invalid/);
  shortRetention = false;
  safetyHold = false;
  await assert.rejects(safety.read(key), /recovery_hold_missing/);
  const wrongKey = 'c'.repeat(64);
  const invalidFence = signed('RecoveryFence', wrongKey, 'haip.recovery', { key, value: true });
  await assert.rejects(safety.create(wrongKey, invalidFence), /recovery_record_invalid/);
  assert.equal(await safety.read(wrongKey), undefined);
  const oversizedFence = signed('RecoveryFence', wrongKey, 'haip.recovery', {
    key: wrongKey,
    value: 'x'.repeat(64 * 1024),
  });
  await assert.rejects(safety.create(wrongKey, oversizedFence), /anchor_history_invalid/);
  assert.equal(await safety.read(wrongKey), undefined);
});
