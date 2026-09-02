import { randomUUID } from 'node:crypto';
import { canonicalise, digest, digestBytes, signRecord } from '@haip/protocol/crypto';
import {
  DEFAULT_LIMITS,
  EXECUTION_PROFILE,
  EXECUTION_VERSION,
  PROTOCOL_REVISION,
  RENDERER,
  type RequestInput,
  type DecisionRequest,
  type DecisionCandidate,
  type DecisionProposal,
  type SignedRecord,
  type Signed,
  type DecisionReceipt,
  type ExecutionClaim,
  type Limits,
  type ClaimInput,
  type ExecutionOutcome,
  type BundleRegistration,
} from '@haip/protocol';
import type { Store, Tx } from './store.js';
import type { Principal, RouteConfig, ServiceConfig } from './config.js';
import { missing, requireThat } from './errors.js';
import { validate, validateResponseSchema } from './validation.js';
import { requireBoundBundle } from './bundle.js';

export interface RequestData {
  request: DecisionRequest;
  request_digest: string;
  decision_state: string;
  audit_state: string;
  grant_state: string;
  execution_state: string;
  revision: number;
  candidate?: DecisionCandidate;
  receipt?: Signed<DecisionReceipt>;
  claim?: Signed<ExecutionClaim>;
  outcome?: Signed<{
    request_id: string;
    claim_digest: string;
    outcome: ExecutionOutcome;
    recorded_at: string;
  }>;
  review_claim?: { id: string; reviewer: string; expires_at: string };
  records: SignedRecord[];
  grant_deadline?: string;
  decision_sequence?: number;
  anchor?: unknown;
  invalidated?: string;
  material_deleted?: boolean;
  response_storage_bytes?: number;
  last_candidate_revision?: number;
  private_discard_at?: string;
  reminder_at?: string;
}
export interface RequestRow {
  id: string;
  tenant: string;
  producer: string;
  route: string;
  data: RequestData;
  material: { payload: unknown; response_schema: unknown; review_document: string } | null;
  retained_bytes: number;
}
interface PreparedRequest {
  material: NonNullable<RequestRow['material']>;
  material_json: string;
  material_bytes: number;
  payload_bytes: number;
  schema_bytes: number;
  document_bytes: number;
  metadata_bytes: number;
  provenance_bytes: number;
  payload_digest: string;
  response_schema_digest: string;
  document_digest: string;
}
const iso = (now: Date, seconds = 0) => new Date(now.getTime() + seconds * 1000).toISOString();
const bytes = (v: unknown) => Buffer.byteLength(canonicalise(v));
export class ReviewService {
  recovery?: import('./recovery.js').RecoveryGuard;
  constructor(
    readonly store: Store,
    readonly config: ServiceConfig,
  ) {}
  discovery() {
    return {
      name: 'HAIP — Human-Agent Interaction Protocol',
      revisions: [PROTOCOL_REVISION],
      profiles: { [EXECUTION_PROFILE]: EXECUTION_VERSION, 'haip.agent-ui': '1' },
      renderer: RENDERER,
      mode: this.config.mode,
      release_ready: false,
      execution_admission:
        this.config.mode === 'production' ? 'independent_namespace_required' : 'development_only',
      notifications: this.config.smtp ? 'smtp' : 'polling-only',
    };
  }
  signed<T>(type: string, payload: T, p: Principal, now: Date, r?: DecisionRequest): Signed<T> {
    return signRecord(
      payload,
      {
        type,
        protocol_revision: PROTOCOL_REVISION,
        purpose: r?.purpose ?? 'service',
        profiles: r?.profiles ?? {},
        issuer: this.config.issuer,
        audience: p.id,
        tenant: p.tenant,
        key_id: this.config.keyId,
        issued_at: iso(now),
      },
      this.config.signingKey,
    ) as Signed<T>;
  }
  async principal(tx: Tx, p: Principal): Promise<Principal> {
    const { rows } = await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
      p.tenant,
      p.id,
    ]);
    requireThat(rows[0]?.config.enabled, 401, 'unauthenticated');
    return rows[0];
  }
  async route(
    tx: Tx,
    p: Principal,
    id: string,
  ): Promise<{ revision: number; config: RouteConfig }> {
    const { rows } = await tx.query(
      'SELECT revision,config FROM haip_routes WHERE tenant=$1 AND id=$2',
      [p.tenant, id],
    );
    if (!rows[0]) throw missing();
    return rows[0];
  }
  async owned(tx: Tx, p: Principal, id: string, includeMaterial = true): Promise<RequestRow> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw missing();
    const { rows } = await tx.query(
      `SELECT tenant,id,producer,route,data,retained_bytes,${includeMaterial ? 'material' : 'NULL::jsonb AS material'} FROM haip_requests WHERE tenant=$1 AND id=$2`,
      [p.tenant, id],
    );
    const row: RequestRow | undefined = rows[0];
    if (!row) throw missing();
    if (p.kind === 'producer' && row.producer === p.id) return row;
    if (p.kind === 'operator') return row;
    if (p.kind === 'human') {
      const route = await this.route(tx, p, row.route);
      if (route.config.reviewers.includes(p.id)) return row;
    }
    throw missing();
  }
  async save(tx: Tx, row: RequestRow): Promise<void> {
    await tx.query('UPDATE haip_requests SET data=$3 WHERE tenant=$1 AND id=$2', [
      row.tenant,
      row.id,
      JSON.stringify(row.data),
    ]);
  }
  async idempotent<T>(
    tx: Tx,
    p: Principal,
    operation: string,
    key: string | undefined,
    input: unknown,
    fn: () => Promise<T>,
    preparedDigest?: string,
  ): Promise<T> {
    requireThat(
      key && key.length <= 160 && /^[\x21-\x7e]+$/.test(key),
      400,
      'idempotency_key_required',
    );
    const hash = preparedDigest ?? digest(input);
    const { rows } = await tx.query(
      'SELECT digest,result FROM haip_idempotency WHERE tenant=$1 AND actor=$2 AND operation=$3 AND key=$4',
      [p.tenant, p.id, operation, key],
    );
    if (rows[0]) {
      requireThat(rows[0].digest === hash, 409, 'idempotency_conflict');
      requireThat(rows[0].result !== null, 410, 'idempotent_result_expired');
      return rows[0].result;
    }
    const result = await fn();
    await tx.query(
      'INSERT INTO haip_idempotency(tenant,actor,operation,key,digest,result) VALUES($1,$2,$3,$4,$5,$6)',
      [p.tenant, p.id, operation, key, hash, JSON.stringify(result)],
    );
    return result;
  }
  async audit(
    tx: Tx,
    p: Principal,
    now: Date,
    type: string,
    payload: unknown,
    request?: DecisionRequest,
  ): Promise<number> {
    const { rows } = await tx.query('SELECT * FROM haip_tenants WHERE id=$1 FOR UPDATE', [
      p.tenant,
    ]);
    const t = rows[0];
    if (!t) throw missing();
    const seq = Number(t.audit_sequence) + 1;
    requireThat(Number.isSafeInteger(seq), 503, 'ledger_exhausted');
    const record = this.signed(type, payload, p, now, request);
    const original = canonicalise(record);
    const head = digest({ previous: t.audit_head, sequence: seq, record_digest: digest(record) });
    await tx.query(
      'INSERT INTO haip_audit(tenant,sequence,request_id,previous_head,head,record_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [p.tenant, seq, request?.id ?? null, t.audit_head, head, digest(record), original],
    );
    await tx.query('UPDATE haip_tenants SET audit_sequence=$2,audit_head=$3 WHERE id=$1', [
      p.tenant,
      seq,
      head,
    ]);
    const checkpoint = this.signed(
      'AuditCheckpoint',
      { ledger_id: t.ledger_id, generation: t.generation, sequence: seq, head },
      { ...p, id: 'haip.audit', tenant: t.ledger_id },
      now,
    );
    // Every event gets a checkpoint; this is stricter than the five-minute/100-event bound.
    await tx.query(
      "INSERT INTO haip_outbox(id,tenant,request_id,kind,body) VALUES($1,$2,$3,'checkpoint',$4)",
      [randomUUID(), p.tenant, request?.id ?? null, JSON.stringify(checkpoint)],
    );
    return seq;
  }
  async event(tx: Tx, p: Principal, row: RequestRow, now: Date, reason: string): Promise<void> {
    const d = row.data;
    d.revision++;
    const producer = (
      await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
        p.tenant,
        row.producer,
      ])
    ).rows[0] as Principal;
    const record = this.signed(
      'RequestChangedEvent',
      {
        event_id: randomUUID(),
        type: 'haip.request.changed',
        request_id: row.id,
        revision: d.revision,
        reason,
        state: {
          decision: d.decision_state,
          audit: d.audit_state,
          grant: d.grant_state,
          execution: d.execution_state,
        },
        deadline: d.grant_deadline ?? d.request.review_deadline,
        status_ref: `${this.config.origin}/v2/requests/${row.id}`,
      },
      producer,
      now,
      d.request,
    );
    await tx.query(
      'INSERT INTO haip_events(tenant,producer,id,request_id,record,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [p.tenant, row.producer, record.payload.event_id, row.id, JSON.stringify(record), now],
    );
    if (producer.config.webhook)
      await tx.query(
        "INSERT INTO haip_outbox(id,tenant,producer,request_id,kind,destination,body) VALUES($1,$2,$3,$4,'webhook',$5,$6)",
        [
          randomUUID(),
          p.tenant,
          row.producer,
          row.id,
          producer.config.webhook,
          JSON.stringify(record),
        ],
      );
    await this.audit(tx, producer, now, 'RequestChangedEvent', record.payload, d.request);
  }
  async notifications(
    tx: Tx,
    p: Principal,
    row: RequestRow,
    now: Date,
    recipients: string[],
  ): Promise<void> {
    if (!this.config.smtp) return;
    for (const id of [...new Set(recipients)]) {
      const { rows } = await tx.query(
        "SELECT config FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='human'",
        [p.tenant, id],
      );
      const c = rows[0]?.config;
      if (!c?.enabled || !c.email_verified || !c.email) continue;
      await tx.query(
        "INSERT INTO haip_outbox(id,tenant,producer,request_id,kind,destination,body,created_at) VALUES($1,$2,$3,$4,'smtp',$5,$6,$7)",
        [
          randomUUID(),
          p.tenant,
          row.producer,
          row.id,
          c.email,
          JSON.stringify({
            subject: 'HAIP review update',
            text: `Review ${row.id}\n${row.data.request.summary}\nDeadline: ${row.data.request.review_deadline}\n${this.config.origin}/review/${row.id}\nSign in to review. This email cannot approve a request.`,
          }),
          now,
        ],
      );
    }
  }
  /** Effective expiry is visible immediately, without making a GET request an audit actor. */
  private project(row: RequestRow, now: Date): { reason?: string; materialDiscarded: boolean } {
    const d = row.data;
    let reason: string | undefined;
    if (d.decision_state === 'pending' && now.getTime() >= Date.parse(d.request.review_deadline)) {
      d.decision_state = 'expired';
      delete d.candidate;
      reason = 'expiry';
    }
    if (
      d.request.purpose === 'authorise_execution' &&
      d.grant_deadline &&
      now.getTime() >= Date.parse(d.grant_deadline) &&
      ['pending_anchor', 'available'].includes(d.grant_state)
    ) {
      d.grant_state = 'expired';
      reason = 'expiry';
    }
    const materialDiscarded =
      !d.material_deleted &&
      now.getTime() >=
        Math.min(
          Date.parse(d.request.private_delete_at),
          Date.parse(d.private_discard_at ?? d.request.private_delete_at),
        );
    if (materialDiscarded) {
      row.material = null;
      d.material_deleted = true;
      delete d.candidate;
      if (d.decision_state === 'pending') d.decision_state = 'expired';
      row.retained_bytes = 0;
      if (d.request.execution) d.invalidated = 'retention';
      if (['available', 'pending_anchor'].includes(d.grant_state)) d.grant_state = 'revoked';
      reason = 'material_deleted';
    }
    return { reason, materialDiscarded };
  }
  async refresh(
    tx: Tx,
    p: Principal,
    row: RequestRow,
    now: Date,
    initiator?: Principal,
  ): Promise<void> {
    const { reason, materialDiscarded } = this.project(row, now),
      d = row.data;
    if (materialDiscarded) {
      await tx.query(
        'UPDATE haip_requests SET material=NULL,retained_bytes=0 WHERE tenant=$1 AND id=$2',
        [row.tenant, row.id],
      );
      await tx.query('UPDATE haip_idempotency SET result=NULL WHERE tenant=$1 AND operation=$2', [
        row.tenant,
        'decision.propose:' + row.id,
      ]);
      await tx.query(
        "UPDATE haip_outbox SET body='{}',destination=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE tenant=$1 AND request_id=$2 AND kind='smtp'",
        [row.tenant, row.id],
      );
      await this.audit(
        tx,
        { ...p, tenant: row.tenant, id: row.producer },
        now,
        'MaterialDiscarded',
        {
          request_id: row.id,
          request_digest: d.request_digest,
          reason: 'retention',
          recorded_by: initiator
            ? { kind: initiator.kind, subject: initiator.id }
            : { kind: 'system', subject: 'haip.retention' },
        },
        d.request,
      );
    }
    if (reason) {
      await this.event(tx, p, row, now, reason);
      await this.save(tx, row);
    }
  }
  async remind(p: Principal, id: string, key?: string) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(['producer', 'operator'].includes(p.kind), 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      this.pending(row, now);
      return this.idempotent(tx, p, 'remind:' + id, key, {}, async () => {
        requireThat(
          !row.data.reminder_at || now.getTime() - Date.parse(row.data.reminder_at) >= 86400000,
          429,
          'reminder_limit',
        );
        row.data.reminder_at = iso(now);
        const route = await this.route(tx, p, row.route);
        await this.notifications(tx, p, row, now, route.config.reviewers);
        await this.event(tx, p, row, now, 'reminder');
        await this.save(tx, row);
        return { request_id: id, notification: this.config.smtp ? 'queued' : 'polling-only' };
      });
    });
  }
  async discard(p: Principal, id: string, key?: string) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(['producer', 'operator'].includes(p.kind), 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      return this.idempotent(tx, p, 'discard:' + id, key, {}, async () => {
        row.data.private_discard_at = iso(now);
        await this.refresh(tx, p, row, now, p);
        await this.notifications(tx, p, row, now, [row.data.request.requester.subject]);
        return this.statusIn(tx, p, row, now);
      });
    });
  }
  async statusIn(tx: Tx, p: Principal, row: RequestRow, now: Date, readOnly = false) {
    if (readOnly) this.project(row, now);
    else await this.refresh(tx, p, row, now);
    const d = row.data;
    const deliveries = (
      await tx.query(
        'SELECT id,kind,state,attempts,error FROM haip_outbox WHERE tenant=$1 AND request_id=$2 ORDER BY created_at DESC LIMIT 30',
        [p.tenant, row.id],
      )
    ).rows;
    return {
      request: d.request,
      request_digest: d.request_digest,
      decision_state: d.decision_state,
      audit_state: d.audit_state,
      grant_state: d.grant_state,
      execution_state: d.execution_state,
      revision: d.revision,
      receipt: d.receipt ?? null,
      claim: d.claim ?? null,
      outcome: d.outcome ?? null,
      anchor: d.anchor ?? null,
      delivery: deliveries,
      review_link: `${this.config.origin}/review/${row.id}`,
      polling_link: `${this.config.origin}/v2/requests/${row.id}`,
    };
  }
  async status(p: Principal, id: string) {
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      return this.statusIn(tx, p, await this.owned(tx, p, id, false), now, true);
    });
  }
  async list(p: Principal, filter: string | undefined, offset = 0) {
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000,
      400,
      'invalid_offset',
    );
    requireThat(
      !filter || ['pending', 'confirmed', 'cancelled', 'superseded', 'expired'].includes(filter),
      400,
      'invalid_state',
    );
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(['producer', 'human', 'operator'].includes(p.kind), 403, 'forbidden');
      const access =
        p.kind === 'producer'
          ? 'r.producer=$2'
          : p.kind === 'human'
            ? "EXISTS (SELECT 1 FROM haip_routes route WHERE route.tenant=r.tenant AND route.id=r.route AND route.config->'reviewers' ? $2)"
            : '$2::text IS NOT NULL';
      const privateDue =
        "(r.data->>'material_deleted'='true' OR LEAST(r.data->'request'->>'private_delete_at',r.data->>'private_discard_at') <= $3)";
      const decision = `CASE WHEN r.data->>'decision_state'='pending' AND
        (r.data->'request'->>'review_deadline' <= $3 OR ${privateDue}) THEN 'expired' ELSE r.data->>'decision_state' END`;
      const visible = `r.tenant=$1 AND ${access} AND ($4::text IS NULL OR (${decision})=$4)`;
      const parameters = [p.tenant, p.id, iso(now), filter ?? null];
      const { rows } = await tx.query(
        `SELECT r.id,r.data->'request'->>'summary' AS summary,r.data->'request'->>'review_deadline' AS deadline,
         ${decision} AS decision,r.data->>'audit_state' AS audit,r.data->>'execution_state' AS execution,
         CASE WHEN r.data->>'grant_state' IN ('pending_anchor','available') AND r.data->>'grant_deadline' <= $3 THEN 'expired'
              WHEN r.data->>'grant_state' IN ('pending_anchor','available') AND ${privateDue} THEN 'revoked'
              ELSE r.data->>'grant_state' END AS grant,
         CASE WHEN r.data->'review_claim'->>'expires_at' > $3 THEN r.data->'review_claim' ELSE NULL END AS assignment
         FROM haip_requests r WHERE ${visible} ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET $5`,
        [...parameters, offset],
      );
      return {
        items: rows.slice(0, 50),
        next_offset: rows.length > 50 && offset + 50 <= 100000 ? offset + 50 : null,
      };
    });
  }
  private async preflight(
    p: Principal,
    operation: string,
    key: string | undefined,
    check: (tx: Tx, p: Principal, now: Date) => Promise<void>,
  ): Promise<boolean> {
    requireThat(
      key && key.length <= 160 && /^[\x21-\x7e]+$/.test(key),
      400,
      'idempotency_key_required',
    );
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      const previous = await tx.query(
        'SELECT 1 FROM haip_idempotency WHERE tenant=$1 AND actor=$2 AND operation=$3 AND key=$4',
        [p.tenant, p.id, operation, key],
      );
      if (previous.rowCount) return true;
      await check(tx, p, now);
      return false;
    });
  }
  /** Cheap admission before a large HTTP body is buffered. The commit transaction rechecks everything. */
  async preflightCreate(p: Principal, key?: string, supersedesId?: string): Promise<void> {
    requireThat(p.kind === 'producer', 403, 'producer_required');
    await this.preflight(
      p,
      supersedesId ? 'supersede:' + supersedesId : 'request.create',
      key,
      async (tx, current, now) => {
        requireThat(current.kind === 'producer', 403, 'producer_required');
        if (supersedesId) await this.owned(tx, current, supersedesId);
        await this.creationQuota(tx, current, undefined, 0, DEFAULT_LIMITS, now, false);
      },
    );
  }
  async preflightBundle(p: Principal, key?: string): Promise<void> {
    requireThat(p.kind === 'publisher', 403, 'publisher_required');
    await this.preflight(p, 'bundle.register', key, async (tx, current, now) => {
      requireThat(current.kind === 'publisher', 403, 'publisher_required');
      await this.bundleQuota(tx, current, 0, now, false);
    });
  }
  private async rateQuota(
    tx: Tx,
    p: Principal,
    now: Date,
    buckets: readonly (readonly [string, number, number])[],
    error: string,
    reserve: boolean,
  ) {
    const config = (await tx.query('SELECT config FROM haip_tenants WHERE id=$1', [p.tenant]))
      .rows[0].config;
    config.buckets ??= {};
    for (const [name, rate, burst] of buckets) {
      const old = config.buckets[name] ?? { tokens: burst, at: now.getTime() };
      const tokens = Math.min(
        burst,
        old.tokens + (Math.max(0, now.getTime() - old.at) * rate) / 60000,
      );
      requireThat(tokens >= 1, 429, error);
      config.buckets[name] = { tokens: tokens - 1, at: now.getTime() };
    }
    if (reserve)
      await tx.query('UPDATE haip_tenants SET config=$2 WHERE id=$1', [
        p.tenant,
        JSON.stringify(config),
      ]);
  }
  private async retainedQuota(tx: Tx, p: Principal, size: number, limits: Limits) {
    const result = (
      await tx.query(
        `SELECT
       (SELECT COALESCE(sum(retained_bytes),0) FROM haip_requests WHERE tenant=$1 AND producer=$2) +
       (SELECT COALESCE(sum(retained_bytes),0) FROM haip_bundles WHERE tenant=$1 AND publisher=$3) AS total`,
        [p.tenant, p.id, p.config.publisher ?? ''],
      )
    ).rows[0];
    requireThat(Number(result.total) + size <= limits.retained_bytes, 429, 'retained_quota');
  }
  async creationQuota(
    tx: Tx,
    p: Principal,
    route: string | undefined,
    size: number,
    limits: Limits,
    now: Date,
    reserve = true,
  ): Promise<void> {
    const day = iso(now).slice(0, 10);
    // Read-only preflight rejects already-exhausted credentials before preparation or lock acquisition.
    // These checks and reservations run again under the tenant lock before a new request is accepted.
    const scopes: [string, string, number][] = [
      ['tenant', '', 1000],
      ['producer', p.id, 200],
    ];
    if (route) scopes.push(['route', route, 100]);
    for (const [scope, subject, maximum] of scopes) {
      const used = await tx.query(
        'SELECT count FROM haip_creation_windows WHERE tenant=$1 AND day=$2 AND scope=$3 AND subject=$4',
        [p.tenant, day, scope, subject],
      );
      requireThat((used.rows[0]?.count ?? 0) < maximum, 429, 'daily_quota');
      if (reserve)
        await tx.query(
          `INSERT INTO haip_creation_windows(tenant,day,scope,subject,count) VALUES($1,$2,$3,$4,1)
         ON CONFLICT(tenant,day,scope,subject) DO UPDATE SET count=haip_creation_windows.count+1`,
          [p.tenant, day, scope, subject],
        );
    }
    const pending = (
      await tx.query(
        `SELECT count(*) AS tenant_count,count(*) FILTER(WHERE producer=$2) AS producer_count
       FROM haip_requests WHERE tenant=$1 AND data->>'decision_state'='pending'
       AND data->'request'->>'review_deadline' > $3`,
        [p.tenant, p.id, iso(now)],
      )
    ).rows[0];
    requireThat(
      Number(pending.producer_count) < 100 && Number(pending.tenant_count) < 500,
      429,
      'outstanding_quota',
    );
    await this.rateQuota(
      tx,
      p,
      now,
      [
        ['tenant', 50, 100],
        [`producer:${p.id}`, 10, 20],
      ],
      'creation_rate',
      reserve,
    );
    await this.retainedQuota(tx, p, size, limits);
  }
  private async bundleQuota(tx: Tx, p: Principal, size: number, now: Date, reserve = true) {
    const day = iso(now).slice(0, 10);
    for (const [scope, subject, maximum] of [
      ['tenant', '', 100],
      ['publisher', p.id, 20],
    ] as const) {
      const used = await tx.query(
        'SELECT count FROM haip_bundle_windows WHERE tenant=$1 AND day=$2 AND scope=$3 AND subject=$4',
        [p.tenant, day, scope, subject],
      );
      requireThat((used.rows[0]?.count ?? 0) < maximum, 429, 'bundle_daily_quota');
      if (reserve)
        await tx.query(
          `INSERT INTO haip_bundle_windows(tenant,day,scope,subject,count) VALUES($1,$2,$3,$4,1)
         ON CONFLICT(tenant,day,scope,subject) DO UPDATE SET count=haip_bundle_windows.count+1`,
          [p.tenant, day, scope, subject],
        );
    }
    await this.rateQuota(
      tx,
      p,
      now,
      [
        ['bundle:tenant', 10, 20],
        [`bundle:publisher:${p.id}`, 2, 5],
      ],
      'bundle_rate',
      reserve,
    );
    const retained = (
      await tx.query(
        `SELECT COALESCE(sum(retained_bytes),0) AS tenant_bytes,
       COALESCE(sum(retained_bytes) FILTER(WHERE publisher=$2),0) AS publisher_bytes
       FROM haip_bundles WHERE tenant=$1`,
        [p.tenant, p.id],
      )
    ).rows[0];
    const producers = (
      await tx.query(
        `SELECT COALESCE(max(used),0) AS maximum FROM (
         SELECT sum(r.retained_bytes) AS used FROM haip_principals p
         JOIN haip_requests r ON r.tenant=p.tenant AND r.producer=p.id
         WHERE p.tenant=$1 AND p.kind='producer' AND p.config->>'publisher'=$2 GROUP BY p.id
       ) usage`,
        [p.tenant, p.id],
      )
    ).rows[0];
    requireThat(
      Number(retained.tenant_bytes) + size <= DEFAULT_LIMITS.retained_bytes &&
        Number(retained.publisher_bytes) + Number(producers.maximum) + size <=
          DEFAULT_LIMITS.retained_bytes,
      429,
      'retained_quota',
    );
  }
  async registerBundle(p: Principal, input: BundleRegistration, key?: string) {
    requireThat(p.kind === 'publisher', 403, 'publisher_required');
    const replay = await this.preflight(p, 'bundle.register', key, (tx, current, now) =>
      this.bundleQuota(tx, current, 0, now, false),
    );
    const canonical = canonicalise(input),
      inputDigest = digestBytes(canonical);
    input = JSON.parse(canonical);
    if (!replay) {
      validate('BundleRegistration', input);
      requireThat(
        Buffer.byteLength(input.html) <= DEFAULT_LIMITS.bundle_bytes,
        413,
        'bundle_too_large',
      );
      requireThat(
        input.compatibility.agent_ui === RENDERER.agent_ui,
        422,
        'unsupported_renderer',
      );
    }
    const contentDigest = replay ? '' : digestBytes(input.html),
      size = replay ? 0 : Buffer.byteLength(input.html);
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'publisher', 403, 'publisher_required');
      return this.idempotent(
        tx,
        p,
        'bundle.register',
        key,
        input,
        async () => {
          requireThat(!replay, 409, 'idempotency_changed');
          await this.bundleQuota(tx, p, size, now);
          const manifest = {
            id: randomUUID(),
            tenant: p.tenant,
            publisher: p.id,
            digest: contentDigest,
            compatibility: input.compatibility,
            author: input.author,
            licence: input.licence,
            created_at: iso(now),
          };
          await tx.query(
            'INSERT INTO haip_bundles(tenant,id,publisher,manifest,html,retained_bytes) VALUES($1,$2,$3,$4,$5,$6)',
            [p.tenant, manifest.id, p.id, JSON.stringify(manifest), input.html, size],
          );
          await this.audit(tx, p, now, 'BundleRegistered', manifest);
          return manifest;
        },
        inputDigest,
      );
    });
  }
  private prepareRequest(input: RequestInput, limits: Limits): PreparedRequest {
    validate('RequestInput', input);
    const payload = canonicalise(input.payload),
      schema = canonicalise(input.response_schema);
    const material = {
      payload: input.payload,
      response_schema: input.response_schema,
      review_document: input.review_document,
    };
    const materialJSON = JSON.stringify(material);
    const prepared = {
      material,
      material_json: materialJSON,
      material_bytes: Buffer.byteLength(materialJSON),
      payload_bytes: Buffer.byteLength(payload),
      schema_bytes: Buffer.byteLength(schema),
      document_bytes: Buffer.byteLength(input.review_document),
      metadata_bytes: bytes(input.metadata ?? {}),
      provenance_bytes: bytes(input.execution?.provenance.references ?? {}),
      payload_digest: digestBytes(payload),
      response_schema_digest: digestBytes(schema),
      document_digest: digestBytes(input.review_document),
    };
    this.preparedLimits(prepared, limits);
    // Untrusted schema compilation and all large JSON canonicalisation happen without a tenant lock.
    validateResponseSchema(input.response_schema);
    return prepared;
  }
  private preparedLimits(prepared: PreparedRequest, limits: Limits) {
    requireThat(prepared.payload_bytes <= limits.payload_bytes, 413, 'payload_too_large');
    requireThat(prepared.document_bytes <= limits.payload_bytes, 413, 'document_too_large');
    requireThat(prepared.schema_bytes <= limits.response_bytes, 413, 'schema_too_large');
    requireThat(prepared.metadata_bytes <= limits.response_bytes, 413, 'metadata_too_large');
    requireThat(prepared.provenance_bytes <= limits.response_bytes, 413, 'provenance_too_large');
  }
  private async prepareCreation(
    p: Principal,
    input: RequestInput,
    key?: string,
    supersedesId?: string,
  ) {
    requireThat(p.kind === 'producer', 403, 'producer_required');
    let limits: Limits = DEFAULT_LIMITS;
    const operation = supersedesId ? 'supersede:' + supersedesId : 'request.create';
    const replay = await this.preflight(p, operation, key, async (tx, current, now) => {
      requireThat(
        input && typeof input.route === 'string' && input.route.length <= 160,
        400,
        'invalid_RequestInput',
      );
      if (supersedesId) await this.owned(tx, current, supersedesId);
      const route = await this.route(tx, current, input.route);
      requireThat(
        current.config.routes?.includes(input.route) &&
          route.config.allowed_producers.includes(current.id),
        403,
        'route_not_authorised',
      );
      limits = route.config.limits;
      await this.creationQuota(tx, current, input.route, 0, limits, now, false);
    });
    const canonical = canonicalise(input),
      inputDigest = digestBytes(canonical);
    const snapshot: RequestInput = JSON.parse(canonical);
    return {
      input: snapshot,
      inputDigest,
      prepared: replay ? undefined : this.prepareRequest(snapshot, limits),
    };
  }
  private async createIn(
    tx: Tx,
    p: Principal,
    now: Date,
    input: RequestInput,
    prepared: PreparedRequest,
    supersedes?: RequestRow,
  ) {
    requireThat(p.kind === 'producer', 403, 'producer_required');
    requireThat(input.protocol_revision === PROTOCOL_REVISION, 422, 'unsupported_revision');
    const supported = this.discovery().profiles as Record<string, string>;
    for (const [name, v] of Object.entries(input.profiles))
      requireThat(supported[name] === v, 422, 'unsupported_profile');
    requireThat(
      (input.purpose === 'authorise_execution') === !!input.execution,
      400,
      'purpose_binding_mismatch',
    );
    if (input.execution)
      requireThat(
        input.profiles[EXECUTION_PROFILE] === EXECUTION_VERSION,
        422,
        'execution_profile_required',
      );
    const route = await this.route(tx, p, input.route);
    requireThat(
      p.config.routes?.includes(input.route) && route.config.allowed_producers.includes(p.id),
      403,
      'route_not_authorised',
    );
    for (const [k, v] of Object.entries(route.config.required_profiles))
      requireThat(input.profiles[k] === v, 422, 'route_profile_required');
    const owner = (
      await tx.query("SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='human'", [
        p.tenant,
        p.config.owner ?? '',
      ])
    ).rows[0] as Principal | undefined;
    requireThat(
      owner?.config.enabled && owner.config.identity_certain !== false,
      409,
      'requester_identity_unavailable',
    );
    const limits = { ...route.config.limits };
    this.preparedLimits(prepared, limits);
    await this.creationQuota(
      tx,
      p,
      input.route,
      prepared.material_bytes + 6 * limits.response_bytes + 8192,
      limits,
      now,
    );
    const namespace = this.recovery
      ? (await this.recovery.check(tx, p.tenant)).generation
      : (await tx.query('SELECT generation FROM haip_tenants WHERE id=$1', [p.tenant])).rows[0]
          .generation;
    const reviewSeconds = Math.min(
      input.review_seconds ?? limits.review_seconds,
      limits.review_seconds,
    );
    const deadline = iso(now, reviewSeconds);
    if (input.execution) {
      requireThat(
        route.config.modes.includes(input.execution.mode),
        422,
        'unsupported_approval_mode',
      );
      requireThat(
        Date.parse(input.execution.valid_until) > now.getTime() &&
          input.execution.execution_seconds <= limits.execution_seconds,
        400,
        'invalid_execution_limits',
      );
      requireThat(
        input.execution.provenance.profile === EXECUTION_PROFILE &&
          input.execution.provenance.version === EXECUTION_VERSION,
        422,
        'unsupported_execution_provenance',
      );
      const { rows } = await tx.query(
        'SELECT * FROM haip_occurrences WHERE tenant=$1 AND producer=$2 AND occurrence=$3',
        [p.tenant, p.id, input.execution.action_occurrence_id],
      );
      if (rows[0])
        requireThat(
          supersedes && rows[0].request_id === supersedes.id && !rows[0].consumed,
          409,
          'occurrence_unavailable',
        );
      if (supersedes)
        requireThat(
          supersedes.data.request.execution?.action_occurrence_id ===
            input.execution.action_occurrence_id,
          409,
          'occurrence_changed',
        );
    }
    let bundle;
    if (input.bundle_id) {
      requireThat(input.profiles['haip.agent-ui'] === '1', 422, 'agent_ui_profile_required');
      if (!/^[a-f0-9-]{36}$/.test(input.bundle_id)) throw missing();
      const found = (
        await tx.query(
          'SELECT manifest,html FROM haip_bundles WHERE tenant=$1 AND id=$2 AND publisher=$3',
          [p.tenant, input.bundle_id, p.config.publisher ?? ''],
        )
      ).rows[0];
      if (!found?.html) throw missing();
      bundle = {
        id: found.manifest.id,
        publisher: found.manifest.publisher,
        digest: found.manifest.digest,
        compatibility: found.manifest.compatibility,
      };
    }
    const request: DecisionRequest = {
      id: randomUUID(),
      authority_namespace: namespace,
      protocol_revision: PROTOCOL_REVISION,
      purpose: input.purpose,
      profiles: input.profiles,
      tenant: p.tenant,
      producer: p.id,
      requester: { subject: owner.id, source: 'operator_directory' },
      route: input.route,
      authorisation_revision: route.revision,
      summary: input.summary,
      review: {
        artefact_digest: input.artefact.digest,
        representation: input.artefact.representation,
        digest_rules: input.artefact.digest_rules,
        payload_digest: prepared.payload_digest,
        response_schema_digest: prepared.response_schema_digest,
        document_digest: prepared.document_digest,
        ...(bundle ? { bundle } : {}),
      },
      ...(input.execution ? { execution: input.execution } : {}),
      limits,
      accepted_at: iso(now),
      review_deadline: input.execution
        ? new Date(
            Math.min(Date.parse(deadline), Date.parse(input.execution.valid_until)),
          ).toISOString()
        : deadline,
      private_delete_at: iso(
        now,
        limits.review_seconds +
          (input.execution
            ? limits.grant_seconds + limits.execution_seconds + limits.reconciliation_seconds
            : 0),
      ),
      audit_delete_at: iso(now, limits.audit_seconds),
      metadata: input.metadata ?? {},
      ...(supersedes ? { supersedes: supersedes.id } : {}),
    };
    validate('DecisionRequest', request);
    const material = prepared.material;
    // Reserve one maximum-size candidate and its idempotent response so creation cannot starve confirmation.
    const size = prepared.material_bytes + bytes(request) + 6 * limits.response_bytes + 8192;
    await this.retainedQuota(tx, p, size, limits);
    if (input.execution && this.recovery) {
      await this.recovery.assertUnconsumed(p.tenant, p.id, input.execution.action_occurrence_id);
      await this.recovery.reserve(p.tenant, p.id, input.execution.action_occurrence_id, namespace);
    }
    const data: RequestData = {
      request,
      request_digest: digest(request),
      decision_state: 'pending',
      audit_state: 'unanchored',
      grant_state: input.execution ? 'none' : 'not_applicable',
      execution_state: input.execution ? 'unclaimed' : 'not_applicable',
      revision: 0,
      records: [],
      ...(supersedes?.data.reminder_at ? { reminder_at: supersedes.data.reminder_at } : {}),
    };
    await tx.query(
      'INSERT INTO haip_requests(tenant,id,producer,route,data,material,retained_bytes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        p.tenant,
        request.id,
        p.id,
        input.route,
        JSON.stringify(data),
        prepared.material_json,
        size,
        now,
      ],
    );
    if (input.execution)
      await tx.query(
        `INSERT INTO haip_occurrences(tenant,producer,occurrence,request_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant,producer,occurrence) DO UPDATE SET request_id=EXCLUDED.request_id`,
        [p.tenant, p.id, input.execution.action_occurrence_id, request.id],
      );
    const row: RequestRow = {
      id: request.id,
      tenant: p.tenant,
      producer: p.id,
      route: input.route,
      data,
      material,
      retained_bytes: size,
    };
    await this.event(tx, p, row, now, 'created');
    await this.notifications(tx, p, row, now, route.config.reviewers);
    await this.save(tx, row);
    return this.statusIn(tx, p, row, now);
  }
  async create(p: Principal, input: RequestInput, key?: string) {
    const creation = await this.prepareCreation(p, input, key);
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      return this.idempotent(
        tx,
        p,
        'request.create',
        key,
        creation.input,
        () => {
          requireThat(creation.prepared, 409, 'idempotency_changed');
          return this.createIn(tx, p, now, creation.input, creation.prepared);
        },
        creation.inputDigest,
      );
    });
  }
  private requireStoredIntegrity(row: RequestRow) {
    let valid = false;
    try {
      validate('DecisionRequest', row.data.request);
      const request = row.data.request;
      valid =
        request.id === row.id &&
        request.tenant === row.tenant &&
        request.producer === row.producer &&
        request.route === row.route &&
        digest(request) === row.data.request_digest;
      if (valid && row.material)
        valid =
          typeof row.material.review_document === 'string' &&
          digestBytes(canonicalise(row.material.payload)) === request.review.payload_digest &&
          digestBytes(canonicalise(row.material.response_schema)) ===
            request.review.response_schema_digest &&
          digestBytes(row.material.review_document) === request.review.document_digest;
    } catch {
      valid = false;
    }
    requireThat(valid, 409, 'material_integrity_mismatch');
  }
  async material(p: Principal, id: string) {
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      this.requireStoredIntegrity(row);
      this.project(row, now);
      requireThat(row.material, 410, 'material_deleted');
      return {
        request: row.data.request,
        request_digest: row.data.request_digest,
        ...row.material,
        candidate: row.data.candidate ?? null,
      };
    });
  }
  async eligible(tx: Tx, p: Principal, row: RequestRow): Promise<void> {
    this.requireStoredIntegrity(row);
    requireThat(p.kind === 'human', 403, 'human_required');
    const route = await this.route(tx, p, row.route);
    requireThat(p.config.identity_certain !== false, 503, 'identity_uncertain');
    requireThat(
      route.revision === row.data.request.authorisation_revision &&
        route.config.reviewers.includes(p.id),
      409,
      'reviewer_ineligible',
    );
    const owner = (
      await tx.query(
        "SELECT config FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='human'",
        [p.tenant, row.data.request.requester.subject],
      )
    ).rows[0];
    requireThat(
      owner?.config.enabled && owner.config.identity_certain !== false,
      503,
      'requester_identity_uncertain',
    );
    if (route.config.separation_of_duties)
      requireThat(
        p.id !== row.data.request.requester.subject &&
          !(
            p.config.oidc_issuer === owner.config.oidc_issuer &&
            p.config.oidc_subject === owner.config.oidc_subject
          ),
        403,
        'separation_of_duties',
      );
  }
  pending(row: RequestRow, now: Date) {
    requireThat(
      row.data.decision_state === 'pending' &&
        now.getTime() < Date.parse(row.data.request.review_deadline) &&
        !row.data.invalidated &&
        !!row.material,
      409,
      'request_not_pending',
    );
  }
  async assign(p: Principal, id: string, key?: string) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      await this.eligible(tx, p, row);
      this.pending(row, now);
      return this.idempotent(tx, p, 'review.assign:' + id, key, {}, async () => {
        const old = row.data.review_claim;
        requireThat(
          !old || old.reviewer === p.id || Date.parse(old.expires_at) <= now.getTime(),
          409,
          'review_assigned',
        );
        row.data.review_claim = {
          id: old?.reviewer === p.id ? old.id : randomUUID(),
          reviewer: p.id,
          expires_at: new Date(
            Math.min(now.getTime() + 300000, Date.parse(row.data.request.review_deadline)),
          ).toISOString(),
        };
        await this.save(tx, row);
        return row.data.review_claim;
      });
    });
  }
  async propose(p: Principal, id: string, input: DecisionProposal, key?: string) {
    validate('DecisionProposal', input);
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      await this.eligible(tx, p, row);
      this.pending(row, now);
      return this.idempotent(tx, p, 'decision.propose:' + id, key, input, async () => {
        const r = row.data.request;
        requireThat(
          r.purpose === 'authorise_execution'
            ? ['authorise', 'refuse'].includes(input.decision)
            : ['approve', 'reject', 'answer'].includes(input.decision),
          400,
          'purpose_decision_mismatch',
        );
        requireThat(bytes(input.response) <= r.limits.response_bytes, 413, 'response_too_large');
        validateResponseSchema(row.material!.response_schema, input.response, true);
        const candidate: DecisionCandidate = {
          id: randomUUID(),
          request_id: id,
          request_digest: row.data.request_digest,
          reviewer: p.id,
          revision: (row.data.last_candidate_revision ?? row.data.candidate?.revision ?? 0) + 1,
          response: input.response,
          response_canonical: canonicalise(input.response),
          response_digest: digest(input.response),
          decision: input.decision,
          created_at: iso(now),
        };
        requireThat(candidate.revision <= 32, 429, 'proposal_revision_limit');
        const before = row.data.response_storage_bytes ?? 0;
        const after =
          before + 2 * bytes(candidate) - (row.data.candidate ? bytes(row.data.candidate) : 0);
        const reserve = 6 * r.limits.response_bytes + 8192;
        const extra = Math.max(reserve, after) - Math.max(reserve, before);
        // Previously reserved space remains usable even if a later registration or route
        // has a larger retained-data allowance. Only new storage needs another quota check.
        if (extra > 0) {
          const usage = (
            await tx.query(
              'SELECT COALESCE(sum(retained_bytes),0) AS total FROM haip_requests WHERE tenant=$1 AND producer=$2',
              [p.tenant, row.producer],
            )
          ).rows[0];
          const bundles = (
            await tx.query(
              "SELECT COALESCE(sum(b.retained_bytes),0) AS total FROM haip_bundles b JOIN haip_principals p ON p.tenant=b.tenant AND p.config->>'publisher'=b.publisher WHERE p.tenant=$1 AND p.id=$2",
              [p.tenant, row.producer],
            )
          ).rows[0];
          requireThat(
            Number(usage.total) + Number(bundles.total) + extra <= r.limits.retained_bytes,
            429,
            'retained_quota',
          );
        }
        row.retained_bytes = Number(row.retained_bytes) + extra;
        row.data.response_storage_bytes = after;
        await tx.query('UPDATE haip_requests SET retained_bytes=$3 WHERE tenant=$1 AND id=$2', [
          p.tenant,
          row.id,
          row.retained_bytes,
        ]);
        row.data.candidate = candidate;
        row.data.last_candidate_revision = candidate.revision;
        await this.save(tx, row);
        return candidate;
      });
    });
  }
  async confirm(
    p: Principal,
    id: string,
    candidateId: string,
    candidateDigest: string,
    key?: string,
  ) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      await this.eligible(tx, p, row);
      return this.idempotent(
        tx,
        p,
        'decision.confirm:' + id,
        key,
        { candidateId, candidateDigest },
        async () => {
          this.pending(row, now);
          const d = row.data;
          const c = d.candidate;
          requireThat(
            c && c.id === candidateId && c.reviewer === p.id && digest(c) === candidateDigest,
            409,
            'candidate_changed',
          );
          const producer = (
            await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
              p.tenant,
              row.producer,
            ])
          ).rows[0] as Principal;
          const execution = d.request.execution;
          if (execution && this.recovery) {
            await this.recovery.check(tx, p.tenant, d.request.authority_namespace);
            now.setTime((await tx.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime());
            this.pending(row, now);
          }
          if (execution)
            d.grant_deadline = new Date(
              Math.min(
                now.getTime() + d.request.limits.grant_seconds * 1000,
                Date.parse(execution.valid_until),
              ),
            ).toISOString();
          const receipt = this.signed<DecisionReceipt>(
            'DecisionReceipt',
            {
              request_id: id,
              request_digest: d.request_digest,
              purpose: d.request.purpose,
              candidate_id: c.id,
              candidate_digest: digest(c),
              reviewer: p.id,
              requester: d.request.requester.subject,
              response_digest: c.response_digest,
              decision: c.decision,
              confirmed_at: iso(now),
              ...(execution ? { grant_deadline: d.grant_deadline } : {}),
            },
            producer,
            now,
            d.request,
          );
          d.receipt = receipt;
          d.records.push(receipt);
          d.decision_state = 'confirmed';
          d.audit_state = 'pending';
          d.grant_state = execution
            ? c.decision === 'authorise'
              ? 'pending_anchor'
              : 'none'
            : 'not_applicable';
          d.decision_sequence = await this.audit(
            tx,
            producer,
            now,
            'DecisionReceipt',
            receipt.payload,
            d.request,
          );
          await this.event(tx, p, row, now, 'decision');
          await this.notifications(tx, p, row, now, [d.request.requester.subject]);
          await this.save(tx, row);
          return receipt;
        },
      );
    });
  }
  async invalidate(p: Principal, id: string, reason: 'cancelled' | 'revoked', key?: string) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(['operator', 'producer'].includes(p.kind), 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      return this.idempotent(tx, p, reason + ':' + id, key, {}, async () => {
        row.data.invalidated = reason;
        if (!row.data.receipt) delete row.data.candidate;
        if (row.data.decision_state === 'pending') row.data.decision_state = 'cancelled';
        if (['available', 'pending_anchor'].includes(row.data.grant_state))
          row.data.grant_state = 'revoked';
        await this.event(tx, p, row, now, reason);
        await this.save(tx, row);
        return this.statusIn(tx, p, row, now);
      });
    });
  }
  async supersede(p: Principal, id: string, input: RequestInput, key?: string) {
    const creation = await this.prepareCreation(p, input, key, id);
    input = creation.input;
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'producer', 403, 'producer_required');
      const old = await this.owned(tx, p, id);
      this.requireStoredIntegrity(old);
      return this.idempotent(
        tx,
        p,
        'supersede:' + id,
        key,
        input,
        async () => {
          requireThat(old.data.request.purpose === input.purpose, 409, 'purpose_immutable');
          requireThat(!old.data.claim, 409, 'occurrence_consumed');
          requireThat(creation.prepared, 409, 'idempotency_changed');
          const created = await this.createIn(tx, p, now, input, creation.prepared, old);
          old.data.invalidated = 'superseded';
          if (old.data.decision_state === 'pending') old.data.decision_state = 'superseded';
          if (!old.data.receipt) delete old.data.candidate;
          if (['available', 'pending_anchor'].includes(old.data.grant_state))
            old.data.grant_state = 'revoked';
          await this.event(tx, p, old, now, 'supersession');
          await this.save(tx, old);
          return created;
        },
        creation.inputDigest,
      );
    });
  }
  async authority(tx: Tx, p: Principal, row: RequestRow, now: Date, existingClaim = false) {
    this.requireStoredIntegrity(row);
    const d = row.data;
    const r = d.request;
    requireThat(
      r.purpose === 'authorise_execution' &&
        r.profiles[EXECUTION_PROFILE] === EXECUTION_VERSION &&
        r.execution,
      409,
      'execution_purpose_required',
    );
    requireThat(
      this.config.mode !== 'production' || this.recovery?.store.production,
      503,
      'independent_recovery_required',
    );
    if (this.recovery) {
      requireThat(r.authority_namespace, 409, 'namespace_missing');
      await this.recovery.check(tx, p.tenant, r.authority_namespace);
      now.setTime((await tx.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime());
    }
    const tenant = (await tx.query('SELECT fenced FROM haip_tenants WHERE id=$1', [p.tenant]))
      .rows[0];
    requireThat(!tenant.fenced, 503, 'admission_fenced');
    requireThat(
      !d.invalidated && d.receipt?.payload.decision === 'authorise',
      409,
      'authority_revoked',
    );
    requireThat(d.audit_state === 'anchored', 409, 'pending_anchor');
    requireThat(
      d.grant_deadline && now.getTime() < Date.parse(d.grant_deadline),
      409,
      'grant_expired',
    );
    requireThat(
      existingClaim ? d.grant_state === 'consumed' : d.grant_state === 'available',
      409,
      'grant_unavailable',
    );
    const reviewer = (
      await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
        p.tenant,
        d.receipt.payload.reviewer,
      ])
    ).rows[0] as Principal | undefined;
    requireThat(reviewer?.config.enabled, 409, 'reviewer_ineligible');
    await this.eligible(tx, reviewer, row);
  }
  async claim(p: Principal, id: string, input: ClaimInput, key?: string) {
    validate('ClaimInput', input);
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'producer', 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      this.requireStoredIntegrity(row);
      if (this.recovery)
        await this.recovery.check(tx, p.tenant, row.data.request.authority_namespace);
      return this.idempotent(tx, p, 'execution.claim:' + id, key, input, async () => {
        await this.authority(tx, p, row, now);
        const d = row.data;
        const execution = d.request.execution!;
        requireThat(
          input.execution_binding_digest === digest(execution),
          409,
          'execution_binding_changed',
        );
        const claimed = await tx.query(
          `UPDATE haip_occurrences SET consumed=true,execution_identity=$4 WHERE tenant=$1 AND producer=$2 AND occurrence=$3 AND consumed=false RETURNING occurrence`,
          [p.tenant, p.id, execution.action_occurrence_id, input.execution_identity],
        );
        requireThat(claimed.rowCount === 1, 409, 'occurrence_consumed');
        if (this.recovery) {
          await this.recovery.consume(
            p.tenant,
            p.id,
            execution.action_occurrence_id,
            input.execution_identity,
            d.request.authority_namespace!,
            d.request_digest,
          );
          await this.authority(tx, p, row, now);
        }
        const claim = this.signed<ExecutionClaim>(
          'ExecutionClaim',
          {
            id: randomUUID(),
            request_id: id,
            request_digest: d.request_digest,
            receipt_digest: digest(d.receipt),
            execution_identity: input.execution_identity,
            action_occurrence_id: execution.action_occurrence_id,
            execution_binding_digest: input.execution_binding_digest,
            claimed_at: iso(now),
            dispatch_before: d.grant_deadline!,
            execution_seconds: execution.execution_seconds,
          },
          p,
          now,
          d.request,
        );
        d.claim = claim;
        d.records.push(claim);
        d.grant_state = 'consumed';
        d.execution_state = 'claimed';
        await this.audit(tx, p, now, 'ExecutionClaim', claim.payload, d.request);
        await this.event(tx, p, row, now, 'claimed');
        await this.save(tx, row);
        return claim;
      });
    });
  }
  async admission(
    p: Principal,
    id: string,
    input: { claim_id: string; nonce: string; execution_identity: string },
  ) {
    validate('AdmissionInput', input);
    requireThat(
      typeof input.nonce === 'string' && /^[A-Za-z0-9_-]{16,160}$/.test(input.nonce),
      400,
      'invalid_nonce',
    );
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'producer', 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      await this.authority(tx, p, row, now, true);
      const d = row.data,
        claim = d.claim;
      requireThat(
        claim &&
          claim.payload.id === input.claim_id &&
          claim.payload.execution_identity === input.execution_identity &&
          !d.outcome,
        409,
        'claim_unavailable',
      );
      requireThat(
        d.records.filter((r) => r.protected.type === 'AdmissionStatus').length < 64,
        429,
        'admission_check_limit',
      );
      requireThat(
        !d.records.some(
          (r) =>
            r.protected.type === 'AdmissionStatus' &&
            (r.payload as { nonce?: string }).nonce === input.nonce,
        ),
        409,
        'nonce_reused',
      );
      const admission = this.signed(
        'AdmissionStatus',
        {
          claim_id: claim.payload.id,
          claim_digest: digest(claim),
          request_id: id,
          execution_identity: input.execution_identity,
          execution_binding_digest: claim.payload.execution_binding_digest,
          checked_at: iso(now),
          dispatch_before: claim.payload.dispatch_before,
          execution_seconds: claim.payload.execution_seconds,
          nonce: input.nonce,
          anchor: d.anchor,
        },
        p,
        now,
        d.request,
      );
      d.records.push(admission);
      d.execution_state = 'admitted';
      await this.audit(tx, p, now, 'AdmissionStatus', admission.payload, d.request);
      await this.save(tx, row);
      return admission;
    });
  }
  async outcome(
    p: Principal,
    id: string,
    input: ExecutionOutcome,
    key?: string,
    reconcile = false,
  ) {
    validate('ExecutionOutcome', input);
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === (reconcile ? 'operator' : 'producer'), 403, 'forbidden');
      const row = await this.owned(tx, p, id);
      this.requireStoredIntegrity(row);
      return this.idempotent(
        tx,
        p,
        (reconcile ? 'reconcile:' : 'outcome:') + id,
        key,
        input,
        async () => {
          const d = row.data;
          requireThat(
            d.claim && d.claim.payload.execution_identity === input.execution_identity,
            409,
            'claim_unavailable',
          );
          if (reconcile)
            requireThat(
              input.details.reason && input.details.evidence,
              400,
              'reconciliation_evidence_required',
            );
          if (d.outcome && !reconcile) {
            requireThat(
              digest(d.outcome.payload.outcome) === digest(input),
              409,
              'outcome_conflict',
            );
            return d.outcome;
          }
          requireThat(
            reconcile || input.status !== 'abandoned',
            403,
            'operator_reconciliation_required',
          );
          const record = this.signed(
            reconcile ? 'ExecutionReconciliation' : 'ExecutionOutcome',
            {
              request_id: id,
              claim_digest: digest(d.claim),
              outcome: input,
              recorded_at: iso(now),
              recorded_by: { kind: p.kind, subject: p.id },
            },
            { ...p, id: row.producer },
            now,
            d.request,
          );
          d.outcome = record;
          d.records.push(record);
          d.execution_state = input.status;
          const discard = Math.min(
            Date.parse(d.request.private_delete_at),
            now.getTime() + d.request.limits.reconciliation_seconds * 1000,
          );
          d.private_discard_at = new Date(
            Math.min(discard, Date.parse(d.private_discard_at ?? d.request.private_delete_at)),
          ).toISOString();
          await this.audit(
            tx,
            { ...p, id: row.producer },
            now,
            record.protected.type,
            record.payload,
            d.request,
          );
          await this.event(tx, p, row, now, 'outcome');
          await this.save(tx, row);
          return record;
        },
      );
    });
  }
  async events(p: Principal, after = 0) {
    requireThat(p.kind === 'producer', 403, 'producer_required');
    return this.store.read(async (tx) => {
      await this.principal(tx, p);
      const rows = (
        await tx.query(
          'SELECT sequence,record FROM haip_events WHERE tenant=$1 AND producer=$2 AND sequence>$3 ORDER BY sequence LIMIT 100',
          [p.tenant, p.id, after],
        )
      ).rows;
      return {
        items: rows.map((r) => r.record),
        next: rows.length ? Number(rows.at(-1)!.sequence) : after,
      };
    });
  }
  async export(p: Principal, id: string) {
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      this.requireStoredIntegrity(row);
      this.project(row, now);
      const audit = (
        await tx.query(
          'SELECT sequence,previous_head,head,record_digest,record FROM haip_audit WHERE tenant=$1 AND request_id=$2 ORDER BY sequence',
          [p.tenant, id],
        )
      ).rows;
      const binding = row.data.request.review.bundle;
      const bundle =
        row.material && binding
          ? (
              await tx.query(
                'SELECT manifest,html FROM haip_bundles WHERE tenant=$1 AND id=$2 AND publisher=$3',
                [p.tenant, binding.id, binding.publisher],
              )
            ).rows[0]
          : undefined;
      if (row.material && binding) requireBoundBundle(bundle, p.tenant, binding);
      return {
        request: row.data.request,
        request_digest: row.data.request_digest,
        records: row.data.records,
        audit,
        anchor: row.data.anchor ?? null,
        material: row.material
          ? {
              ...row.material,
              candidate: row.data.candidate ?? null,
              ...(bundle ? { bundle } : {}),
            }
          : null,
        verification:
          'Trust roots must be configured independently. Signatures attest records, not human understanding or external effects. Request audit entries are a filtered chain; verify complete checkpoints with the operator ledger export.',
      };
    });
  }
}
