import type { SignedRecord, TrustManifest, RequestChangedEvent, Signed } from '@haip/protocol';
import { digest, verifyRecord } from '@haip/protocol/crypto';

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
    !/^[a-f0-9-]{36}$/.test(p.delivery_id) ||
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
    !/^[a-f0-9-]{36}$/.test(event.request_id) ||
    !/^[a-f0-9-]{36}$/.test(event.event_id) ||
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
        PRIMARY KEY(issuer,tenant,producer,request_id));`);
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
}
