import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import type { ReviewService, RequestRow } from './service.js';
import type { Principal } from './config.js';
import type { AnchorStore } from './anchor.js';
import { deliverWebhook } from './delivery.js';
import { requireThat } from './errors.js';
import { RecoveryGuard } from './recovery.js';
export class OutboxWorker {
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
        `SELECT id,tenant FROM haip_outbox WHERE tenant=$1 AND state='pending' AND next_at<=clock_timestamp()
         ${this.anchor ? '' : "AND kind IN ('smtp','webhook')"} ORDER BY created_at,id LIMIT 50`,
        [tenant],
      )
    ).rows;
    let completed = 0;
    for (const job of jobs)
      await s.store.transaction(job.tenant, async (tx, now) => {
        const item = (
          await tx.query(
            "SELECT * FROM haip_outbox WHERE id=$1 AND state='pending' AND next_at<=clock_timestamp() FOR UPDATE",
            [job.id],
          )
        ).rows[0];
        if (!item) return;
        if (item.kind !== 'checkpoint' && now.getTime() - item.created_at.getTime() >= 86400000) {
          await tx.query(
            "UPDATE haip_outbox SET state='failed',error='delivery_window_expired' WHERE id=$1",
            [item.id],
          );
          return;
        }
        try {
          let acceptance: unknown = null;
          if (item.kind === 'checkpoint') {
            // Unconfigured checkpoints remain visible and resumable but cannot occupy delivery slots.
            requireThat(this.anchor, 503, 'independent_anchor_required');
            acceptance = await this.anchor.accept(item.body);
            now.setTime((await tx.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime());
            const seq = item.body.payload.sequence;
            const rows = (
              await tx.query(
                `SELECT tenant,id,producer,route,data,retained_bytes,NULL::jsonb AS material FROM haip_requests
                 WHERE tenant=$1 AND data->>'audit_state'='pending'
                 AND (data->>'decision_sequence')::bigint <= $2
                 ORDER BY (data->>'decision_sequence')::bigint,id LIMIT 50`,
                [job.tenant, seq],
              )
            ).rows as RequestRow[];
            for (const row of rows) {
              const p = (
                await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
                  job.tenant,
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
                    [job.tenant, row.data.decision_sequence, seq],
                  )
                ).rows.map((r) => ({ ...r, sequence: Number(r.sequence) })),
              };
              if (row.data.grant_state === 'pending_anchor')
                row.data.grant_state =
                  !row.data.invalidated && now.getTime() < Date.parse(row.data.grant_deadline!)
                    ? 'available'
                    : 'expired';
              await s.event(tx, p, row, now, 'anchor_accepted');
              if (row.data.grant_state === 'available')
                await s.notifications(tx, p, row, now, [row.data.request.requester.subject]);
              await s.save(tx, row);
            }
            const remaining = await tx.query(
              `SELECT 1 FROM haip_requests WHERE tenant=$1 AND data->>'audit_state'='pending'
               AND (data->>'decision_sequence')::bigint <= $2 LIMIT 1`,
              [job.tenant, seq],
            );
            if (remaining.rowCount) {
              // A newer checkpoint may cover a backlog; finish it in bounded transactions.
              completed += rows.length;
              return;
            }
          } else if (item.kind === 'webhook') {
            const p = (
              await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
                job.tenant,
                item.producer,
              ])
            ).rows[0] as Principal;
            requireThat(
              p.config.enabled && p.config.webhook === item.destination,
              409,
              'destination_changed',
            );
            const delivery = s.signed(
              'WebhookDelivery',
              {
                delivery_id: randomUUID(),
                event_id: item.body.payload.event_id,
                timestamp: now.toISOString(),
                event: item.body,
              },
              p,
              now,
            );
            await deliverWebhook(
              item.destination,
              delivery,
              s.config.webhookHosts,
              this.delivery.webhookTransport,
            );
          } else {
            requireThat(s.config.smtp, 503, 'smtp_unconfigured');
            const directory = (
              await tx.query(
                "SELECT 1 FROM haip_principals WHERE tenant=$1 AND kind='human' AND config->>'email'=$2 AND config->>'email_verified'='true' AND config->>'enabled'='true'",
                [job.tenant, item.destination],
              )
            ).rows;
            requireThat(directory.length, 409, 'recipient_unavailable');
            const hour = new Date(now);
            hour.setUTCMinutes(0, 0, 0);
            const counter = (
              await tx.query(
                'SELECT count FROM haip_notification_windows WHERE tenant=$1 AND recipient=$2 AND hour=$3',
                [job.tenant, item.destination, hour],
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
              [job.tenant, item.destination, hour],
            );
            const transport = nodemailer.createTransport({
              ...s.config.smtp,
              requireTLS: s.config.mode === 'production',
              connectionTimeout: 10000,
              socketTimeout: 10000,
            });
            try {
              const result = await transport.sendMail({
                from: s.config.smtp.from,
                to: item.destination,
                subject: item.body.subject,
                text: item.body.text,
                disableFileAccess: true,
                disableUrlAccess: true,
              });
              requireThat(result.accepted?.length, 503, 'smtp_not_accepted');
              acceptance = { smtp_accepted: true, delivered_or_read: 'unknown' };
            } finally {
              transport.close();
            }
          }
          await tx.query(
            "UPDATE haip_outbox SET state='accepted',attempts=attempts+1,accepted=$2,error=NULL WHERE id=$1",
            [item.id, JSON.stringify(acceptance)],
          );
          completed++;
        } catch (error) {
          const code = error instanceof Error ? error.message : 'delivery_failed';
          if (/anchor_(conflict|version_conflict|deleted_version|history_invalid)/.test(code)) {
            await tx.query('INSERT INTO haip_incidents(tenant,code) VALUES($1,$2)', [
              job.tenant,
              code,
            ]);
            await tx.query('UPDATE haip_tenants SET fenced=true WHERE id=$1', [job.tenant]);
            await tx.query(
              "UPDATE haip_requests SET data=jsonb_set(data,'{audit_state}','\"conflict\"') WHERE tenant=$1",
              [job.tenant],
            );
          }
          const expired =
            item.kind !== 'checkpoint' && now.getTime() - item.created_at.getTime() >= 86400000;
          await tx.query(
            'UPDATE haip_outbox SET state=$2,attempts=attempts+1,error=$3,next_at=$4 WHERE id=$1',
            [
              item.id,
              expired ? 'failed' : 'pending',
              code.startsWith('anchor_') ? code : 'delivery_failed',
              new Date(now.getTime() + Math.min(3600, 2 ** Math.min(item.attempts + 1, 12)) * 1000),
            ],
          );
        }
      });
    return completed;
  }
  async cleanup(): Promise<void> {
    for (const t of (await this.service.store.pool.query('SELECT id FROM haip_tenants ORDER BY id'))
      .rows)
      await this.operation(t.id, 'retention', async () => {
        // Release the tenant lock between pages so review and confirmation keep making progress.
        while (await this.sweep(t.id)) {}
      });
  }
  private async sweep(tenant: string): Promise<boolean> {
    const s = this.service,
      t = { id: tenant };
    return s.store.transaction(t.id, async (tx, now) => {
      const due = await tx.query(
        `SELECT tenant,id,producer,route,data,retained_bytes,NULL::jsonb AS material FROM haip_requests
           WHERE tenant=$1 AND maintenance_at <= $2 ORDER BY maintenance_at,id LIMIT 50`,
        [t.id, now.toISOString()],
      );
      for (const row of due.rows as RequestRow[]) {
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
        }
      }
      await tx.query(
        "UPDATE haip_bundles b SET html=NULL,retained_bytes=0 WHERE b.tenant=$1 AND b.html IS NOT NULL AND b.created_at<clock_timestamp()-interval '15 minutes' AND NOT EXISTS (SELECT 1 FROM haip_requests r WHERE r.tenant=b.tenant AND r.material IS NOT NULL AND r.data->'request'->'review'->'bundle'->>'id'=b.id::text)",
        [t.id],
      );
      await tx.query(
        "UPDATE haip_audit SET record=NULL WHERE tenant=$1 AND created_at<clock_timestamp()-interval '90 days'",
        [t.id],
      );
      await tx.query(
        "DELETE FROM haip_outbox WHERE tenant=$1 AND created_at<clock_timestamp()-interval '90 days'",
        [t.id],
      );
      await tx.query(
        "UPDATE haip_idempotency SET result=NULL WHERE tenant=$1 AND created_at<clock_timestamp()-interval '90 days'",
        [t.id],
      );
      await tx.query(
        "DELETE FROM haip_notification_windows WHERE tenant=$1 AND hour<clock_timestamp()-interval '1 day'",
        [t.id],
      );
      await tx.query('DELETE FROM haip_creation_windows WHERE tenant=$1 AND day<$2', [
        t.id,
        now.toISOString().slice(0, 10),
      ]);
      await tx.query('DELETE FROM haip_bundle_windows WHERE tenant=$1 AND day<$2', [
        t.id,
        now.toISOString().slice(0, 10),
      ]);
      await tx.query('DELETE FROM haip_sessions WHERE expires_at<=clock_timestamp()');
      return due.rows.length === 50;
    });
  }
}
