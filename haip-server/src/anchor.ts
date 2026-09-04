import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { canonicalise, digestBytes, parseJson, verifyRecord } from '@haip/protocol/crypto';
import type { SignedRecord, TrustManifest } from '@haip/protocol';
import { requireThat } from './errors.js';
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
    this.container = new BlobServiceClient(url.origin, new DefaultAzureCredential(), {
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
    requireThat(
      properties.versionId === version &&
        properties.immutabilityPolicyMode === 'Locked' &&
        properties.immutabilityPolicyExpiresOn,
      503,
      'anchor_retention_invalid',
    );
    if (permanent) requireThat(properties.legalHold === true, 503, 'recovery_hold_missing');
    const bytes = await blob.downloadToBuffer();
    return { body: bytes.toString('utf8'), retainedUntil: properties.immutabilityPolicyExpiresOn };
  }
  protected async createVersion(key: string, record: SignedRecord, permanent = false) {
    const body = canonicalise(record);
    const retention = new Date(
      Math.ceil((Date.parse(record.protected.issued_at) + 90 * 86400000) / 1000) * 1000,
    );
    requireThat(retention.getTime() > Date.now(), 503, 'anchor_retention_expired');
    try {
      await this.container.getBlockBlobClient(key).upload(body, Buffer.byteLength(body), {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });
    } catch (error) {
      const e = error as { statusCode?: number; code?: string };
      if (e.statusCode !== 412 && !(e.statusCode === 409 && e.code === 'BlobAlreadyExists'))
        throw error;
    }
    const versions = (await this.objects(key)).filter((item) => item.name === key);
    requireThat(versions.length === 1, 503, 'anchor_version_conflict');
    const version = versions[0]!.versionId!;
    const actual = await this.readVersion(key, version, permanent);
    return { ...actual, version, retention };
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
      stored.retainedUntil.getTime() >= stored.retention.getTime(),
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
        actual.retainedUntil.getTime() >= Date.parse(record.protected.issued_at) + 90 * 86400000,
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
  async read(key: string): Promise<SignedRecord | undefined> {
    const path = this.key(key),
      versions = (await this.objects(path)).filter((v) => v.name === path);
    if (!versions.length) return undefined;
    requireThat(versions.length === 1, 503, 'anchor_version_conflict');
    const actual = await this.readVersion(path, versions[0]!.versionId!, true);
    const record = parseJson(actual.body) as SignedRecord;
    verifyRecord(record, this.trust, {
      issuer: this.trust.issuer,
      audience: 'haip.recovery',
      type: 'RecoveryFence',
      purpose: 'service',
      tenant: key,
    });
    requireThat((record.payload as { key?: string }).key === key, 503, 'recovery_record_invalid');
    return record;
  }
  async create(key: string, record: SignedRecord): Promise<SignedRecord> {
    verifyRecord(record, this.trust, {
      issuer: this.trust.issuer,
      audience: 'haip.recovery',
      type: 'RecoveryFence',
      purpose: 'service',
      tenant: key,
    });
    await this.createVersion(this.key(key), record, true);
    const accepted = await this.read(key);
    requireThat(accepted, 503, 'recovery_record_missing');
    return accepted;
  }
}
