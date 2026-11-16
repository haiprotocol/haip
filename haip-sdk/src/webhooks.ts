import type {
  SignedRecord,
  TrustManifest,
  RequestChangedEvent,
  RequestStatus,
  Signed,
} from '@haip/protocol';
import { digest, verifyRecord } from '@haip/protocol/crypto';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export interface WebhookIdentity {
  issuer: string;
  tenant: string;
  producer: string;
}
export interface VerifiedWebhook {
  identity: WebhookIdentity;
  deliveryId: string;
  event: Signed<RequestChangedEvent>;
}
/** Authenticity plus a strict five-minute delivery window. Event state is always advisory. */
export function verifyWebhook(
  record: SignedRecord,
  trust: TrustManifest,
  identity: WebhookIdentity,
  now = Date.now(),
): VerifiedWebhook {
  const expected = {
    issuer: identity.issuer,
    tenant: identity.tenant,
    audience: identity.producer,
  };
  verifyRecord(
    record,
    trust,
    { ...expected, type: 'WebhookDelivery', purpose: 'service' },
    new Date(now),
  );
  const p = record.payload as {
    delivery_id: string;
    event_id: string;
    timestamp: string;
    event: Signed<RequestChangedEvent>;
  };
  if (
    !p ||
    typeof p.delivery_id !== 'string' ||
    !uuid.test(p.delivery_id) ||
    !Number.isFinite(Date.parse(p.timestamp)) ||
    p.timestamp !== record.protected.issued_at ||
    Math.abs(now - Date.parse(p.timestamp)) >= 300000
  )
    throw new Error('webhook_replay_window');
  verifyRecord(p.event, trust, { ...expected, type: 'RequestChangedEvent' }, new Date(now));
  const event = p.event.payload;
  if (
    event?.type !== 'haip.request.changed' ||
    event.event_id !== p.event_id ||
    typeof event.request_id !== 'string' ||
    typeof event.event_id !== 'string' ||
    !uuid.test(event.request_id) ||
    !uuid.test(event.event_id) ||
    !Number.isSafeInteger(event.revision) ||
    event.revision < 1 ||
    event.status_ref !== identity.issuer + '/v2/requests/' + event.request_id ||
    !['review', 'authorise_execution'].includes(p.event.protected.purpose)
  )
    throw new Error('webhook_event_invalid');
  return { identity, deliveryId: p.delivery_id, event: p.event };
}

type Connection = { query(text: string, values?: any[]): Promise<any>; release(): void };
export interface InboxDatabase {
  connect(): Promise<Connection>;
}
/** A dedicated consumer database; commit before returning HTTP 2xx. No execution callback. */
export class PostgresWebhookInbox {
  constructor(readonly database: InboxDatabase) {}
  async migrate() {
    const tx = await this.database.connect();
    try {
      await tx.query(`CREATE TABLE IF NOT EXISTS haip_received_events (
        issuer text NOT NULL, tenant text NOT NULL, producer text NOT NULL, event_id uuid NOT NULL,
        request_id uuid NOT NULL, revision bigint NOT NULL, digest text NOT NULL, record jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(issuer,tenant,producer,event_id));
        CREATE TABLE IF NOT EXISTS haip_status_refresh (
        issuer text NOT NULL, tenant text NOT NULL, producer text NOT NULL, request_id uuid NOT NULL,
        revision bigint NOT NULL, refreshed_revision bigint NOT NULL DEFAULT 0,
        PRIMARY KEY(issuer,tenant,producer,request_id));
        CREATE INDEX IF NOT EXISTS haip_status_refresh_pending
        ON haip_status_refresh(issuer,tenant,producer,request_id) WHERE revision>refreshed_revision;`);
    } finally {
      tx.release();
    }
  }
  async persist(delivery: VerifiedWebhook): Promise<'stored' | 'duplicate'> {
    const { identity: i, event } = delivery,
      e = event.payload;
    const tx = await this.database.connect();
    try {
      await tx.query('BEGIN');
      const inserted = await tx.query(
        `INSERT INTO haip_received_events(issuer,tenant,producer,event_id,request_id,revision,digest,record)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_id`,
        [
          i.issuer,
          i.tenant,
          i.producer,
          e.event_id,
          e.request_id,
          e.revision,
          digest(event),
          JSON.stringify(event),
        ],
      );
      const previous = (
        await tx.query(
          'SELECT digest FROM haip_received_events WHERE issuer=$1 AND tenant=$2 AND producer=$3 AND event_id=$4',
          [i.issuer, i.tenant, i.producer, e.event_id],
        )
      ).rows[0];
      if (previous.digest !== digest(event)) throw new Error('webhook_event_conflict');
      await tx.query(
        `INSERT INTO haip_status_refresh(issuer,tenant,producer,request_id,revision) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(issuer,tenant,producer,request_id) DO UPDATE SET revision=GREATEST(haip_status_refresh.revision,EXCLUDED.revision)`,
        [i.issuer, i.tenant, i.producer, e.request_id, e.revision],
      );
      await tx.query('COMMIT');
      return inserted.rowCount ? 'stored' : 'duplicate';
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }

  async pendingRefreshes(
    identity: WebhookIdentity,
    { after, limit = 50 }: { after?: string; limit?: number } = {},
  ) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after !== undefined && (typeof after !== 'string' || !uuid.test(after)))
    )
      throw new Error('webhook_refresh_page');
    const tx = await this.database.connect();
    try {
      const { rows } = await tx.query(
        `SELECT request_id,revision FROM haip_status_refresh
         WHERE issuer=$1 AND tenant=$2 AND producer=$3 AND revision>refreshed_revision
           AND ($4::uuid IS NULL OR request_id>$4)
         ORDER BY request_id LIMIT $5`,
        [identity.issuer, identity.tenant, identity.producer, after ?? null, limit],
      );
      return (rows as { request_id: string; revision: number | string }[]).map((row) => ({
        requestId: row.request_id,
        revision: Number(row.revision),
      }));
    } finally {
      tx.release();
    }
  }

  /** Record the revision returned by an authenticated status read. The observation grants no execution authority. */
  async refreshStatus(
    identity: WebhookIdentity,
    requestId: string,
    client: { readonly origin: string; status(id: string): Promise<RequestStatus> },
  ): Promise<RequestStatus | undefined> {
    if (client.origin !== identity.issuer) throw new Error('webhook_status_origin');
    if (typeof requestId !== 'string' || !uuid.test(requestId))
      throw new Error('webhook_status_request');
    const key = [identity.issuer, identity.tenant, identity.producer, requestId];
    const lookup = await this.database.connect();
    let expected: number;
    try {
      const { rows } = await lookup.query(
        `SELECT revision FROM haip_status_refresh
         WHERE issuer=$1 AND tenant=$2 AND producer=$3 AND request_id=$4 AND revision>refreshed_revision`,
        key,
      );
      if (!rows[0]) return;
      expected = Number(rows[0].revision);
    } finally {
      lookup.release();
    }
    const status = await client.status(requestId);
    if (
      status?.request?.id !== requestId ||
      status.request.tenant !== identity.tenant ||
      status.request.producer !== identity.producer ||
      status.request_digest !== digest(status.request) ||
      !Number.isSafeInteger(status.revision) ||
      status.revision < expected
    )
      throw new Error('webhook_status_mismatch');

    const progress = await this.database.connect();
    try {
      const updated = await progress.query(
        `UPDATE haip_status_refresh SET refreshed_revision=$5
         WHERE issuer=$1 AND tenant=$2 AND producer=$3 AND request_id=$4
           AND refreshed_revision<$5 AND revision<=$5`,
        [...key, status.revision],
      );
      return updated.rowCount ? status : undefined;
    } finally {
      progress.release();
    }
  }
}
