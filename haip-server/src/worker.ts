import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { digest } from '@haip/protocol/crypto';
import type { ReviewService, RequestRow } from './service.js';
import type { Principal } from './config.js';
import type { AnchorStore } from './anchor.js';
import { deliverWebhook } from './delivery.js';
import { requireThat } from './errors.js';
import { RecoveryGuard } from './recovery.js';
import type { Tx } from './store.js';

const maintenancePageSize = 50;
const maintenancePageLimit = 10;
const collectionLimit = 500;
const deliveryClaimSeconds = 300;
interface OutboxItem {
  id: string;
  tenant: string;
  producer: string | null;
  request_id: string | null;
  kind: 'checkpoint' | 'webhook' | 'smtp';
  destination: string | null;
  body: any;
  state: string;
  attempts: number;
  next_at: Date;
  created_at: Date;
  accepted: unknown;
  error: string | null;
  claim_generation: number;
  claim_until: Date | null;
  claim_revision: string | null;
}
interface DestinationState {
  authorised: boolean;
  revision: string;
  principal?: Principal;
}
interface ClaimedJob {
  item: OutboxItem;
  generation: number;
  revision: string;
  delivery?: unknown;
}
interface MaintenanceCursor {
  at: string;
  id: string;
}
export interface CleanupResult {
  examined: number;
  changed: number;
  stalled: number;
  /** Unvisited work in this bounded pass, rather than previously inspected stalled rows. */
  more: boolean;
}
export class OutboxWorker {
  private readonly maintenanceCursors = new Map<string, MaintenanceCursor>();
  constructor(
    readonly service: ReviewService,
    readonly anchor?: AnchorStore,
    private readonly delivery: { webhookTransport?: Parameters<typeof deliverWebhook>[3] } = {},
  ) {
    requireThat(
      service.config.mode !== 'production' || anchor?.production,
      503,
      'independent_anchor_required',
    );
    requireThat(
      service.config.mode !== 'production' || !delivery.webhookTransport,
      503,
      'fixture_transport_forbidden',
    );
  }
  async reconcile(): Promise<void> {
    const { service: s } = this;
    this.maintenanceCursors.clear();
    if (s.recovery) s.recovery = new RecoveryGuard(s, s.recovery.store);
    for (const t of (await s.store.pool.query('SELECT * FROM haip_tenants')).rows) {
      await s.store.transaction(t.id, async (tx) => {
        await tx.query('UPDATE haip_tenants SET fenced=true WHERE id=$1', [t.id]);
      });
      if (!this.anchor) continue;
      const remote = await this.anchor.history(t.ledger_id, t.generation);
      let conflict = false;
      for (const checkpoint of remote) {
        const local = (
          await s.store.pool.query('SELECT head FROM haip_audit WHERE tenant=$1 AND sequence=$2', [
            t.id,
            checkpoint.sequence,
          ])
        ).rows[0];
        if (local?.head !== checkpoint.head) conflict = true;
      }
      if (!conflict && s.recovery) {
        try {
          await s.recovery.activate(t.id, t.ledger_id, t.generation);
        } catch {
          conflict = true;
          await s.store.pool.query('INSERT INTO haip_incidents(tenant,code) VALUES($1,$2)', [
            t.id,
            'namespace_recovery_required',
          ]);
        }
      }
      // A fresh process cannot reuse an activated generation, even if its retained prefix matches.
      if (!conflict && (s.recovery || s.config.mode === 'development'))
        await s.store.transaction(t.id, async (tx) => {
          await tx.query('UPDATE haip_tenants SET fenced=false WHERE id=$1', [t.id]);
        });
    }
  }
  private async operation<T>(tenant: string, name: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      await this.service.store.pool.query(
        'INSERT INTO haip_tenant_operations(tenant,name,succeeded_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(tenant,name) DO UPDATE SET succeeded_at=EXCLUDED.succeeded_at',
        [tenant, name],
      );
      return result;
    } catch (error) {
      // A database outage may also prevent this stamp; alerts additionally check last success.
      await this.service.store.pool
        .query(
          'INSERT INTO haip_tenant_operations(tenant,name,failed_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(tenant,name) DO UPDATE SET failed_at=EXCLUDED.failed_at',
          [tenant, name],
        )
        .catch(() => {});
      throw error;
    }
  }
  async tick(): Promise<number> {
    let completed = 0;
    for (const t of (await this.service.store.pool.query('SELECT id FROM haip_tenants ORDER BY id'))
      .rows)
      completed += await this.operation(t.id, 'outbox', () => this.drain(t.id));
    return completed;
  }
  private async drain(tenant: string): Promise<number> {
    const s = this.service;
    const jobs = (
      await s.store.pool.query(
        `SELECT id,tenant FROM haip_outbox WHERE tenant=$1 AND state='pending'
         AND GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz))<=statement_timestamp()
         ${this.anchor ? '' : "AND kind IN ('smtp','webhook')"}
         ORDER BY GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz)),created_at,id LIMIT 50`,
        [tenant],
      )
    ).rows;
    let completed = 0;
    for (const job of jobs) {
      const claim = await this.claim(job.tenant, job.id);
      if (!claim) continue;
      let acceptance: unknown;
      let error: unknown;
      try {
        acceptance = await this.deliver(claim);
      } catch (caught) {
        error = caught;
      }
      completed += await this.finalise(claim, acceptance, error);
    }
    return completed;
  }
  private async destinationState(tx: Tx, item: OutboxItem): Promise<DestinationState> {
    if (item.kind === 'checkpoint') {
      const generation = (
        await tx.query('SELECT generation FROM haip_tenants WHERE id=$1', [item.tenant])
      ).rows[0]?.generation;
      return {
        authorised: !!this.anchor && !!generation,
        revision: digest({
          kind: item.kind,
          generation: String(generation ?? ''),
          body: digest(item.body),
        }),
      };
    }
    if (item.kind === 'webhook') {
      const principal = (
        await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
          item.tenant,
          item.producer,
        ])
      ).rows[0] as Principal | undefined;
      const revision = digest({
        kind: item.kind,
        producer: item.producer,
        destination: item.destination,
        body: digest(item.body),
        enabled: principal?.config.enabled ?? false,
        webhook: principal?.config.webhook ?? null,
      });
      return {
        authorised: !!principal?.config.enabled && principal.config.webhook === item.destination,
        revision,
        principal,
      };
    }
    const directory = (
      await tx.query(
        "SELECT id,config FROM haip_principals WHERE tenant=$1 AND kind='human' AND config->>'email'=$2 ORDER BY id",
        [item.tenant, item.destination],
      )
    ).rows as { id: string; config: Principal['config'] }[];
    return {
      authorised: directory.some((row) => row.config.enabled && row.config.email_verified === true),
      revision: digest({
        kind: item.kind,
        destination: item.destination,
        body: digest(item.body),
        directory: directory.map((row) => ({
          id: row.id,
          enabled: row.config.enabled,
          email_verified: row.config.email_verified === true,
        })),
      }),
    };
  }
  private async claim(tenant: string, id: string): Promise<ClaimedJob | undefined> {
    return this.service.store.transaction(tenant, async (tx, now) => {
      const item = (
        await tx.query(
          "SELECT * FROM haip_outbox WHERE id=$1 AND tenant=$2 AND state='pending' AND next_at<=clock_timestamp() AND (claim_until IS NULL OR claim_until<=clock_timestamp()) FOR UPDATE",
          [id, tenant],
        )
      ).rows[0] as OutboxItem | undefined;
      if (!item) return;
      if (item.kind !== 'checkpoint' && now.getTime() - item.created_at.getTime() >= 86400000) {
        await tx.query(
          "UPDATE haip_outbox SET state='failed',error='delivery_window_expired',claim_until=NULL,claim_revision=NULL WHERE id=$1",
          [item.id],
        );
        return;
      }
      const destination = await this.destinationState(tx, item);
      if (!destination.authorised || (item.kind === 'smtp' && !this.service.config.smtp)) {
        await this.retry(tx, item, now, new Error('destination_unavailable'));
        return;
      }
      if (item.kind === 'smtp') {
        const hour = new Date(now);
        hour.setUTCMinutes(0, 0, 0);
        const counter = (
          await tx.query(
            'SELECT count FROM haip_notification_windows WHERE tenant=$1 AND recipient=$2 AND hour=$3',
            [tenant, item.destination, hour],
          )
        ).rows[0];
        if (counter?.count >= 10) {
          await tx.query('UPDATE haip_outbox SET next_at=$2 WHERE id=$1', [
            item.id,
            new Date(hour.getTime() + 3600000),
          ]);
          return;
        }
        await tx.query(
          'INSERT INTO haip_notification_windows(tenant,recipient,hour,count) VALUES($1,$2,$3,1) ON CONFLICT(tenant,recipient,hour) DO UPDATE SET count=haip_notification_windows.count+1',
          [tenant, item.destination, hour],
        );
      }
      const claimed = (
        await tx.query(
          `UPDATE haip_outbox SET attempts=attempts+1,claim_generation=claim_generation+1,
           claim_until=clock_timestamp()+($2::text||' seconds')::interval,claim_revision=$3
           WHERE id=$1 RETURNING claim_generation`,
          [item.id, deliveryClaimSeconds, destination.revision],
        )
      ).rows[0];
      item.attempts++;
      item.claim_revision = destination.revision;
      let delivery: unknown;
      if (item.kind === 'webhook') {
        const principal = destination.principal!;
        delivery = this.service.signed(
          'WebhookDelivery',
          {
            delivery_id: randomUUID(),
            event_id: item.body.payload.event_id,
            timestamp: now.toISOString(),
            event: item.body,
          },
          principal,
          now,
        );
      }
      return {
        item,
        generation: Number(claimed.claim_generation),
        revision: destination.revision,
        delivery,
      };
    });
  }
  private async deliver(claim: ClaimedJob): Promise<unknown> {
    const { item } = claim;
    if (item.kind === 'checkpoint') {
      requireThat(this.anchor, 503, 'independent_anchor_required');
      return this.anchor.accept(item.body);
    }
    if (item.kind === 'webhook') {
      await deliverWebhook(
        item.destination!,
        claim.delivery,
        this.service.config.webhookHosts,
        this.delivery.webhookTransport,
      );
      return null;
    }
    const smtp = this.service.config.smtp;
    requireThat(smtp, 503, 'smtp_unconfigured');
    const transport = nodemailer.createTransport({
      ...smtp,
      requireTLS: this.service.config.mode === 'production',
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      dnsTimeout: 10000,
    });
    try {
      const result = await transport.sendMail({
        from: smtp.from,
        to: item.destination!,
        subject: item.body.subject,
        text: item.body.text,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      requireThat(result.accepted?.length, 503, 'smtp_not_accepted');
      return { smtp_accepted: true, delivered_or_read: 'unknown' };
    } finally {
      transport.close();
    }
  }
  private async finalise(claim: ClaimedJob, acceptance: unknown, error: unknown): Promise<number> {
    return this.service.store.transaction(claim.item.tenant, async (tx, now) => {
      const item = (
        await tx.query(
          "SELECT * FROM haip_outbox WHERE id=$1 AND tenant=$2 AND state='pending' AND claim_generation=$3 AND claim_revision=$4 AND claim_until IS NOT NULL FOR UPDATE",
          [claim.item.id, claim.item.tenant, claim.generation, claim.revision],
        )
      ).rows[0] as OutboxItem | undefined;
      if (!item) return 0;
      const current = await this.destinationState(tx, item);
      if (current.revision !== item.claim_revision) {
        // A successful send was authorised at claim time. A failed send cannot retry after that authority changes.
        if (error || item.kind === 'checkpoint') {
          await tx.query(
            "UPDATE haip_outbox SET state='failed',error='destination_changed',claim_until=NULL,claim_revision=NULL WHERE id=$1",
            [item.id],
          );
          return 0;
        }
      } else if (error) {
        await this.retry(tx, item, now, error);
        return 0;
      }
      if (item.kind === 'checkpoint') {
        const seq = item.body.payload.sequence;
        const rows = (
          await tx.query(
            `SELECT tenant,id,producer,route,data,retained_bytes,NULL::jsonb AS material FROM haip_requests
             WHERE tenant=$1 AND data->>'audit_state'='pending'
             AND (data->>'decision_sequence')::bigint <= $2
             ORDER BY (data->>'decision_sequence')::bigint,id LIMIT 50`,
            [item.tenant, seq],
          )
        ).rows as RequestRow[];
        for (const row of rows) {
          const principal = (
            await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
              item.tenant,
              row.producer,
            ])
          ).rows[0] as Principal;
          row.data.audit_state = 'anchored';
          row.data.anchor = {
            checkpoint: item.body,
            acceptance,
            proof: (
              await tx.query(
                'SELECT sequence,previous_head,record_digest,head FROM haip_audit WHERE tenant=$1 AND sequence BETWEEN $2 AND $3 ORDER BY sequence',
                [item.tenant, row.data.decision_sequence, seq],
              )
            ).rows.map((record) => ({ ...record, sequence: Number(record.sequence) })),
          };
          if (row.data.grant_state === 'pending_anchor')
            row.data.grant_state =
              !row.data.invalidated && now.getTime() < Date.parse(row.data.grant_deadline!)
                ? 'available'
                : 'expired';
          await this.service.event(tx, principal, row, now, 'anchor_accepted');
          if (row.data.grant_state === 'available')
            await this.service.notifications(tx, principal, row, now, [
              row.data.request.requester.subject,
            ]);
          await this.service.save(tx, row);
        }
        const remaining = await tx.query(
          `SELECT 1 FROM haip_requests WHERE tenant=$1 AND data->>'audit_state'='pending'
           AND (data->>'decision_sequence')::bigint <= $2 LIMIT 1`,
          [item.tenant, seq],
        );
        if (remaining.rowCount) {
          // A newer checkpoint may cover a backlog, so finish it in bounded transactions. The receipt is diagnostic only because the next page checks independent storage again.
          await tx.query(
            "UPDATE haip_outbox SET accepted=$2,error=NULL,next_at=clock_timestamp()+interval '30 seconds',claim_until=NULL,claim_revision=NULL WHERE id=$1",
            [item.id, JSON.stringify(acceptance)],
          );
          return rows.length;
        }
      }
      await tx.query(
        "UPDATE haip_outbox SET state='accepted',accepted=$2,error=NULL,claim_until=NULL,claim_revision=NULL WHERE id=$1",
        [item.id, JSON.stringify(acceptance)],
      );
      return 1;
    });
  }
  private async retry(tx: Tx, item: OutboxItem, now: Date, error: unknown): Promise<void> {
    const code = error instanceof Error ? error.message : 'delivery_failed';
    if (/anchor_(conflict|version_conflict|deleted_version|history_invalid)/.test(code)) {
      await tx.query('INSERT INTO haip_incidents(tenant,code) VALUES($1,$2)', [item.tenant, code]);
      await tx.query('UPDATE haip_tenants SET fenced=true WHERE id=$1', [item.tenant]);
      await tx.query(
        "UPDATE haip_requests SET data=jsonb_set(data,'{audit_state}','\"conflict\"') WHERE tenant=$1",
        [item.tenant],
      );
    }
    const expired =
      item.kind !== 'checkpoint' && now.getTime() - item.created_at.getTime() >= 86400000;
    const attempt = item.attempts + (item.claim_until ? 0 : 1);
    await tx.query(
      `UPDATE haip_outbox SET state=$2,attempts=CASE WHEN claim_until IS NULL THEN attempts+1 ELSE attempts END,
       error=$3,next_at=$4,claim_until=NULL,claim_revision=NULL WHERE id=$1`,
      [
        item.id,
        expired ? 'failed' : 'pending',
        code.startsWith('anchor_') ? code : 'delivery_failed',
        new Date(now.getTime() + Math.min(3600, 2 ** Math.min(attempt, 12)) * 1000),
      ],
    );
  }
  async cleanup(): Promise<CleanupResult> {
    const result: CleanupResult = { examined: 0, changed: 0, stalled: 0, more: false };
    // Expired sessions belong to the whole service, not to every tenant's request page.
    const sessions = await this.collect(
      this.service.store.pool,
      'haip_sessions',
      'expires_at<=statement_timestamp()',
      [],
      'expires_at,token_hash',
    );
    result.more = sessions.more;
    for (const t of (await this.service.store.pool.query('SELECT id FROM haip_tenants ORDER BY id'))
      .rows)
      await this.operation(t.id, 'retention', async () => {
        for (let page = 0; page < maintenancePageLimit; page++) {
          const swept = await this.sweep(t.id, this.maintenanceCursors.get(t.id));
          result.examined += swept.examined;
          result.changed += swept.changed;
          result.stalled += swept.stalled;
          if (swept.next) this.maintenanceCursors.set(t.id, swept.next);
          else this.maintenanceCursors.delete(t.id);
          // A stalled page is skipped on the next bounded continuation. Once the end
          // is reached, these rows cannot themselves request another immediate pass.
          if (!swept.more || !swept.changed || page + 1 === maintenancePageLimit) {
            result.more ||= swept.more;
            break;
          }
        }
        const housekeepingMore = await this.housekeeping(t.id);
        result.more ||= housekeepingMore;
      });
    return result;
  }
  private async sweep(
    tenant: string,
    cursor?: MaintenanceCursor,
  ): Promise<CleanupResult & { next?: MaintenanceCursor }> {
    const s = this.service,
      t = { id: tenant };
    return s.store.transaction(t.id, async (tx, now) => {
      const values: unknown[] = [t.id, now.toISOString()];
      if (cursor) values.push(cursor.at, cursor.id);
      const due = await tx.query(
        `SELECT tenant,id,producer,route,data,retained_bytes,maintenance_at,NULL::jsonb AS material FROM haip_requests
         WHERE tenant=$1 AND maintenance_at <= $2 ${cursor ? 'AND (maintenance_at,id)>($3,$4::uuid)' : ''}
         ORDER BY maintenance_at,id LIMIT ${maintenancePageSize}`,
        values,
      );
      let changed = 0;
      for (const row of due.rows as RequestRow[]) {
        const revision = row.data.revision;
        const p = (
          await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
            t.id,
            row.producer,
          ])
        ).rows[0] as Principal;
        await s.refresh(tx, p, row, now);
        if (now.getTime() >= Date.parse(row.data.request.audit_delete_at)) {
          // Keep chain commitments and permanent occurrence fences, never the expired signed content.
          await tx.query('UPDATE haip_audit SET record=NULL WHERE tenant=$1 AND request_id=$2', [
            t.id,
            row.id,
          ]);
          await tx.query('DELETE FROM haip_events WHERE tenant=$1 AND request_id=$2', [
            t.id,
            row.id,
          ]);
          await tx.query('DELETE FROM haip_outbox WHERE tenant=$1 AND request_id=$2', [
            t.id,
            row.id,
          ]);
          await tx.query(
            "UPDATE haip_idempotency SET result=NULL WHERE tenant=$1 AND (operation LIKE '%'||$2 OR result->'request'->>'id'=$2)",
            [t.id, row.id],
          );
          await tx.query('DELETE FROM haip_requests WHERE tenant=$1 AND id=$2', [t.id, row.id]);
          changed++;
        } else if (row.data.revision !== revision) changed++;
      }
      const last = due.rows.at(-1);
      const more =
        !!last &&
        !!(
          await tx.query(
            'SELECT 1 FROM haip_requests WHERE tenant=$1 AND maintenance_at<=$2 AND (maintenance_at,id)>($3,$4::uuid) LIMIT 1',
            [t.id, now.toISOString(), last.maintenance_at, last.id],
          )
        ).rowCount;
      const stalled = due.rows.length - changed;
      if (stalled)
        await tx.query(
          `INSERT INTO haip_incidents(tenant,code,details)
         SELECT $1,'retention_stalled',jsonb_build_object('first_seen',$2::text,'rows',$3::integer)
         WHERE NOT EXISTS (SELECT 1 FROM haip_incidents WHERE tenant=$1 AND code='retention_stalled')`,
          [t.id, now.toISOString(), stalled],
        );
      return {
        examined: due.rows.length,
        changed,
        stalled,
        more,
        ...(more ? { next: { at: last.maintenance_at, id: last.id } } : {}),
      };
    });
  }
  private async housekeeping(tenant: string): Promise<boolean> {
    return this.service.store.transaction(tenant, async (tx, now) => {
      let more = false;
      const older = (milliseconds: number) => new Date(now.getTime() - milliseconds);
      const run = async (
        table: CollectionTable,
        where: string,
        values: unknown[],
        order: string,
        update?: string,
      ) => {
        const result = await this.collect(tx, table, where, values, order, update);
        more ||= result.more;
      };
      await run(
        'haip_bundles',
        "retained.tenant=$1 AND html IS NOT NULL AND created_at<$2 AND NOT EXISTS (SELECT 1 FROM haip_requests r WHERE r.tenant=retained.tenant AND r.material IS NOT NULL AND r.data->'request'->'review'->'bundle'->>'id'=retained.id::text)",
        [tenant, older(15 * 60000)],
        'created_at,id',
        'html=NULL,retained_bytes=0',
      );
      await run(
        'haip_audit',
        'tenant=$1 AND record IS NOT NULL AND created_at<$2',
        [tenant, older(90 * 86400000)],
        'created_at,sequence',
        'record=NULL',
      );
      await run(
        'haip_outbox',
        'tenant=$1 AND created_at<$2',
        [tenant, older(90 * 86400000)],
        'created_at,id',
      );
      await run(
        'haip_idempotency',
        'tenant=$1 AND result IS NOT NULL AND created_at<$2',
        [tenant, older(90 * 86400000)],
        'created_at',
        'result=NULL',
      );
      await run(
        'haip_notification_windows',
        'tenant=$1 AND hour<$2',
        [tenant, older(86400000)],
        'hour',
      );
      const day = now.toISOString().slice(0, 10);
      await run('haip_creation_windows', 'tenant=$1 AND day<$2', [tenant, day], 'day');
      await run('haip_bundle_windows', 'tenant=$1 AND day<$2', [tenant, day], 'day');
      return more;
    });
  }
  /** Only fixed internal table names/expressions reach this helper; values stay parameterised. */
  private async collect(
    queryable: Pick<Tx, 'query'>,
    table: CollectionTable,
    where: string,
    values: unknown[],
    order: string,
    update?: string,
  ): Promise<{ changed: number; more: boolean }> {
    const result = await queryable.query(
      `WITH candidates AS MATERIALIZED (
         SELECT ctid FROM ${table} retained WHERE ${where} ORDER BY ${order}
         LIMIT ${collectionLimit + 1} FOR UPDATE SKIP LOCKED
       ), changed AS (
         ${update ? `UPDATE ${table} SET ${update}` : `DELETE FROM ${table}`}
         WHERE ctid IN (SELECT ctid FROM candidates LIMIT ${collectionLimit}) RETURNING 1
       ) SELECT (SELECT count(*)::integer FROM changed) AS changed,
         (SELECT count(*) FROM candidates)>${collectionLimit} AS more`,
      values,
    );
    return result.rows[0];
  }
}

type CollectionTable =
  | 'haip_sessions'
  | 'haip_bundles'
  | 'haip_audit'
  | 'haip_outbox'
  | 'haip_idempotency'
  | 'haip_notification_windows'
  | 'haip_creation_windows'
  | 'haip_bundle_windows';
