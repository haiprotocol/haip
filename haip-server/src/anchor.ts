import { isUtf8 } from 'node:buffer';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { canonicalise, digestBytes, parseJson, verifyRecord } from '@haip/protocol/crypto';
import type { SignedRecord, TrustManifest } from '@haip/protocol';
import { requireThat } from './errors.js';

const minimumRetention = (record: SignedRecord) =>
  Date.parse(record.protected.issued_at) + 90 * 86400000;
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
  history(ledger: string, generation: string): Promise<{ sequence: number; head: string }[]>;
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
  protected async objects(prefix: string) {
    const versions = [],
      names = new Set<string>();
    for await (const item of this.container.listBlobsFlat({
      prefix,
      includeVersions: true,
      includeDeleted: true,
      includeDeletedWithVersions: true,
    })) {
      requireThat(
        !item.deleted && !item.hasVersionsOnly && item.isCurrentVersion === true,
        503,
        'anchor_deleted_version',
      );
      requireThat(
        item.versionId && !item.snapshot && !names.has(item.name),
        503,
        'anchor_version_conflict',
      );
      names.add(item.name);
      versions.push(item);
    }
    return versions;
  }
  protected async readVersion(key: string, version: string, permanent = false) {
    const blob = this.container.getBlobClient(key).withVersion(version);
    const properties = await blob.getProperties();
    requireThat(properties.versionId === version, 503, 'anchor_version_conflict');
    requireThat(
      properties.immutabilityPolicyMode === 'Locked' && properties.immutabilityPolicyExpiresOn,
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
    const bytes = await blob.downloadToBuffer(0, contentLength, { conditions: { ifMatch: etag } });
    requireThat(bytes.length === contentLength && isUtf8(bytes), 503, 'anchor_history_invalid');
    return { body: bytes.toString('utf8'), retainedUntil: properties.immutabilityPolicyExpiresOn };
  }
  protected async createVersion(key: string, record: SignedRecord, permanent = false) {
    const body = canonicalise(record);
    const length = Buffer.byteLength(body);
    requireThat(length <= maximumRecordBytes, 503, 'anchor_history_invalid');
    requireThat(minimumRetention(record) > Date.now(), 503, 'anchor_retention_expired');
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
    const versions = (await this.objects(key)).filter((item) => item.name === key);
    requireThat(versions.length === 1, 503, 'anchor_version_conflict');
    const version = versions[0]!.versionId!;
    requireThat(
      acknowledgedVersion === undefined || version === acknowledgedVersion,
      503,
      'anchor_version_conflict',
    );
    const actual = await this.readVersion(key, version, permanent);
    if (acknowledgedVersion !== undefined)
      requireThat(actual.body === body, 503, 'anchor_conflict');
    return { ...actual, version };
  }
  async accept(record: SignedRecord): Promise<AnchorAcceptance> {
    const p = record.payload as {
      ledger_id: string;
      generation: string;
      sequence: number;
      head: string;
    };
    verifyRecord(record, this.trust, {
      issuer: this.trust.issuer,
      audience: 'haip.audit',
      type: 'AuditCheckpoint',
      purpose: 'service',
      tenant: p.ledger_id,
    });
    requireThat(
      Number.isSafeInteger(p.sequence) && p.sequence > 0 && /^sha256:[a-f0-9]{64}$/.test(p.head),
      503,
      'anchor_history_invalid',
    );
    const key =
      this.namespace(p.ledger_id, p.generation) + String(p.sequence).padStart(16, '0') + '.json';
    const stored = await this.createVersion(key, record);
    requireThat(stored.body === canonicalise(record), 503, 'anchor_conflict');
    requireThat(
      stored.retainedUntil.getTime() >= minimumRetention(record),
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
  async history(ledger: string, generation: string) {
    const records = [];
    for (const item of await this.objects(this.namespace(ledger, generation))) {
      const actual = await this.readVersion(item.name, item.versionId!);
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
        actual.retainedUntil.getTime() >= minimumRetention(record),
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
      retainedUntil.getTime() >= minimumRetention(record),
      503,
      'anchor_retention_invalid',
    );
    return record;
  }
  async read(key: string): Promise<SignedRecord | undefined> {
    const path = this.key(key),
      versions = (await this.objects(path)).filter((v) => v.name === path);
    if (!versions.length) return undefined;
    requireThat(versions.length === 1, 503, 'anchor_version_conflict');
    return this.readFence(key, await this.readVersion(path, versions[0]!.versionId!, true));
  }
  async create(key: string, record: SignedRecord): Promise<SignedRecord> {
    const path = this.key(key);
    this.verifyFence(key, record);
    return this.readFence(key, await this.createVersion(path, record, true));
  }
}
