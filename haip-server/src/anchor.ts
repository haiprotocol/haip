import { isUtf8 } from 'node:buffer';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { canonicalise, digestBytes, parseJson, verifyRecord } from '@haip/protocol/crypto';
import type { SignedRecord, TrustManifest } from '@haip/protocol';
import { ProtocolError, requireThat } from './errors.js';

export const minimumAnchorRetentionDays = 90;
export const minimumAnchorRetention = (record: SignedRecord) =>
  Date.parse(record.protected.issued_at) + minimumAnchorRetentionDays * 86400000;
const maximumRecordBytes = 64 * 1024;

export interface AnchorAcceptance {
  backend: string;
  key: string;
  version_id: string;
  digest: string;
  retained_until: string;
}
export interface AnchorStore {
  readonly production: boolean;
  accept(record: SignedRecord): Promise<AnchorAcceptance>;
  verifyAcceptance(record: SignedRecord, acceptance: AnchorAcceptance): Promise<void>;
  history(ledger: string, generation: string): Promise<{ sequence: number; head: string }[]>;
}

export function isAnchorConflict(code: string) {
  return [
    'anchor_conflict',
    'anchor_version_conflict',
    'anchor_deleted_version',
    'anchor_history_invalid',
    'anchor_retention_invalid',
  ].includes(code);
}

export async function listAzureVersions(
  container: ContainerClient,
  prefix: string,
  { maxVersions = Infinity, abortSignal }: { maxVersions?: number; abortSignal?: AbortSignal } = {},
) {
  const versions = [],
    names = new Set<string>();
  for await (const item of container.listBlobsFlat({
    prefix,
    abortSignal,
    includeVersions: true,
    includeSnapshots: true,
    includeDeleted: true,
    includeDeletedWithVersions: true,
  })) {
    requireThat(
      !item.deleted && !item.hasVersionsOnly && item.isCurrentVersion === true,
      503,
      'anchor_deleted_version',
    );
    requireThat(
      item.versionId && !item.snapshot && !names.has(item.name) && versions.length < maxVersions,
      503,
      'anchor_version_conflict',
    );
    names.add(item.name);
    versions.push(item);
  }
  return versions;
}

export async function readAzureVersion(
  container: ContainerClient,
  key: string,
  version: string,
  permanent = false,
  abortSignal?: AbortSignal,
) {
  const blob = container.getBlobClient(key).withVersion(version);
  const properties = await blob.getProperties({ abortSignal });
  requireThat(properties.versionId === version, 503, 'anchor_version_conflict');
  requireThat(
    properties.immutabilityPolicyMode?.toLowerCase() === 'locked' &&
      properties.immutabilityPolicyExpiresOn,
    503,
    'anchor_retention_invalid',
  );
  if (permanent) requireThat(properties.legalHold === true, 503, 'recovery_hold_missing');
  const { contentLength, etag } = properties;
  requireThat(
    typeof contentLength === 'number' &&
      Number.isSafeInteger(contentLength) &&
      contentLength > 0 &&
      contentLength <= maximumRecordBytes &&
      etag,
    503,
    'anchor_history_invalid',
  );
  const bytes = await blob.downloadToBuffer(0, contentLength, {
    ...(abortSignal ? { abortSignal } : {}),
    conditions: { ifMatch: etag },
  });
  requireThat(bytes.length === contentLength && isUtf8(bytes), 503, 'anchor_history_invalid');
  return { body: bytes.toString('utf8'), retainedUntil: properties.immutabilityPolicyExpiresOn };
}

/** Optional production backend using policies inherited from its container. */
export class AzureAnchor implements AnchorStore {
  readonly production = true;
  readonly container: ContainerClient;
  constructor(
    accountUrl: string,
    container: string,
    readonly prefix: string,
    readonly trust: TrustManifest,
    credential?: TokenCredential,
  ) {
    const url = new URL(accountUrl);
    requireThat(
      url.protocol === 'https:' &&
        (accountUrl === url.origin || accountUrl === `${url.origin}/`) &&
        !url.username &&
        !url.password &&
        /^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname),
      400,
      'azure_account_url_invalid',
    );
    requireThat(
      prefix.length <= 200 && /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix),
      400,
      'anchor_prefix_invalid',
    );
    requireThat(
      container.length >= 3 &&
        container.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(container) &&
        !container.includes('--'),
      400,
      'azure_container_invalid',
    );
    this.container = new BlobServiceClient(url.origin, credential ?? new DefaultAzureCredential(), {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 10000 },
    }).getContainerClient(container);
  }
  private namespace(ledger: string, generation: string) {
    return `${this.prefix}/${ledger}/${generation}/`;
  }
  protected async createVersion(key: string, record: SignedRecord, permanent = false) {
    const body = canonicalise(record);
    const length = Buffer.byteLength(body);
    requireThat(length <= maximumRecordBytes, 503, 'anchor_history_invalid');
    requireThat(minimumAnchorRetention(record) > Date.now(), 503, 'anchor_retention_expired');
    let acknowledgedVersion: string | undefined;
    try {
      const uploaded = await this.container.getBlockBlobClient(key).upload(body, length, {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });
      requireThat(uploaded.versionId, 503, 'anchor_version_conflict');
      acknowledgedVersion = uploaded.versionId;
    } catch (error) {
      const e = error as { statusCode?: number; code?: string };
      if (e.statusCode !== 412 && !(e.statusCode === 409 && e.code === 'BlobAlreadyExists'))
        throw error;
    }
    const versions = (await listAzureVersions(this.container, key)).filter(
      (item) => item.name === key,
    );
    requireThat(versions.length === 1, 503, 'anchor_version_conflict');
    const version = versions[0]!.versionId!;
    requireThat(
      acknowledgedVersion === undefined || version === acknowledgedVersion,
      503,
      'anchor_version_conflict',
    );
    const actual = await readAzureVersion(this.container, key, version, permanent);
    if (acknowledgedVersion !== undefined)
      requireThat(actual.body === body, 503, 'anchor_conflict');
    return { ...actual, version };
  }
  private checkpointKey(record: SignedRecord) {
    const p = record?.payload as
      | {
          ledger_id: string;
          generation: string;
          sequence: number;
          head: string;
        }
      | undefined;
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    requireThat(
      p &&
        typeof p.ledger_id === 'string' &&
        uuid.test(p.ledger_id) &&
        typeof p.generation === 'string' &&
        uuid.test(p.generation) &&
        Number.isSafeInteger(p.sequence) &&
        p.sequence > 0 &&
        typeof p.head === 'string' &&
        /^sha256:[a-f0-9]{64}$/.test(p.head),
      503,
      'anchor_history_invalid',
    );
    try {
      verifyRecord(record, this.trust, {
        issuer: this.trust.issuer,
        audience: 'haip.audit',
        type: 'AuditCheckpoint',
        purpose: 'service',
        tenant: p.ledger_id,
      });
    } catch {
      throw new ProtocolError(503, 'anchor_history_invalid');
    }
    return (
      this.namespace(p.ledger_id, p.generation) + String(p.sequence).padStart(16, '0') + '.json'
    );
  }
  async accept(record: SignedRecord): Promise<AnchorAcceptance> {
    const key = this.checkpointKey(record);
    const stored = await this.createVersion(key, record);
    requireThat(stored.body === canonicalise(record), 503, 'anchor_conflict');
    requireThat(
      stored.retainedUntil.getTime() >= minimumAnchorRetention(record),
      503,
      'anchor_retention_invalid',
    );
    return {
      backend: 'azure_blob_locked_worm',
      key,
      version_id: stored.version,
      digest: digestBytes(stored.body),
      retained_until: stored.retainedUntil.toISOString(),
    };
  }
  async verifyAcceptance(record: SignedRecord, acceptance: AnchorAcceptance): Promise<void> {
    const key = this.checkpointKey(record);
    const body = canonicalise(record);
    requireThat(
      acceptance?.backend === 'azure_blob_locked_worm' &&
        acceptance.key === key &&
        typeof acceptance.version_id === 'string' &&
        acceptance.version_id.length > 0 &&
        acceptance.digest === digestBytes(body),
      503,
      'anchor_conflict',
    );
    const retainedUntil = Date.parse(acceptance.retained_until);
    requireThat(
      retainedUntil >= minimumAnchorRetention(record) && retainedUntil > Date.now(),
      503,
      'anchor_retention_invalid',
    );
    const abortSignal = AbortSignal.timeout(10_000);
    try {
      const [version] = await listAzureVersions(this.container, key, {
        maxVersions: 1,
        abortSignal,
      });
      requireThat(
        version?.name === key && version.versionId === acceptance.version_id,
        503,
        'anchor_version_conflict',
      );
      const actual = await readAzureVersion(
        this.container,
        key,
        version.versionId,
        false,
        abortSignal,
      );
      requireThat(actual.body === body, 503, 'anchor_conflict');
      requireThat(actual.retainedUntil.getTime() >= retainedUntil, 503, 'anchor_retention_invalid');
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      const status = (error as { statusCode?: number })?.statusCode;
      throw new ProtocolError(
        503,
        status === 404 || status === 412 ? 'anchor_version_conflict' : 'anchor_unavailable',
      );
    }
  }
  async history(ledger: string, generation: string) {
    const records = [];
    for (const item of await listAzureVersions(
      this.container,
      this.namespace(ledger, generation),
    )) {
      const actual = await readAzureVersion(this.container, item.name, item.versionId!);
      const record = parseJson(actual.body) as SignedRecord;
      const p = record.payload as {
        ledger_id: string;
        generation: string;
        sequence: number;
        head: string;
      };
      requireThat(
        p.ledger_id === ledger &&
          p.generation === generation &&
          /^sha256:[a-f0-9]{64}$/.test(p.head) &&
          Number.isSafeInteger(p.sequence) &&
          p.sequence > 0 &&
          item.name ===
            this.namespace(ledger, generation) + String(p.sequence).padStart(16, '0') + '.json',
        503,
        'anchor_history_invalid',
      );
      try {
        verifyRecord(record, this.trust, {
          issuer: this.trust.issuer,
          audience: 'haip.audit',
          type: 'AuditCheckpoint',
          purpose: 'service',
          tenant: ledger,
        });
      } catch {
        throw new Error('anchor_history_invalid');
      }
      requireThat(
        actual.retainedUntil.getTime() >= minimumAnchorRetention(record),
        503,
        'anchor_history_invalid',
      );
      records.push({ sequence: p.sequence, head: p.head });
    }
    return records;
  }
}
/** Minimal permanent records, separate from encrypted backups and retained under legal hold. */
export class AzureSafetyStore extends AzureAnchor {
  private key(key: string) {
    requireThat(/^[a-f0-9]{64}$/.test(key), 400, 'recovery_key_invalid');
    return `${this.prefix}/safety/${key}.json`;
  }
  private verifyFence(key: string, record: SignedRecord) {
    verifyRecord(record, this.trust, {
      issuer: this.trust.issuer,
      audience: 'haip.recovery',
      type: 'RecoveryFence',
      purpose: 'service',
      tenant: key,
    });
    requireThat((record.payload as { key?: string }).key === key, 503, 'recovery_record_invalid');
  }
  private readFence(key: string, { body, retainedUntil }: { body: string; retainedUntil: Date }) {
    const record = parseJson(body) as SignedRecord;
    this.verifyFence(key, record);
    requireThat(
      retainedUntil.getTime() >= minimumAnchorRetention(record),
      503,
      'anchor_retention_invalid',
    );
    return record;
  }
  async read(key: string): Promise<SignedRecord | undefined> {
    const path = this.key(key),
      versions = (await listAzureVersions(this.container, path)).filter((v) => v.name === path);
    if (!versions.length) return undefined;
    requireThat(versions.length === 1, 503, 'anchor_version_conflict');
    return this.readFence(
      key,
      await readAzureVersion(this.container, path, versions[0]!.versionId!, true),
    );
  }
  async create(key: string, record: SignedRecord): Promise<SignedRecord> {
    const path = this.key(key);
    this.verifyFence(key, record);
    return this.readFence(key, await this.createVersion(path, record, true));
  }
}
