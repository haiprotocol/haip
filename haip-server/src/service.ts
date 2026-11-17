import { randomUUID } from 'node:crypto';
import {
  canonicalise,
  digest,
  digestBytes,
  signRecord,
  verifyCheckpointProof,
  verifyRecord,
} from '@haip/protocol/crypto';
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
  type AdmissionStatus,
  type Limits,
  type ClaimInput,
  type ExecutionOutcome,
  type BundleRegistration,
  type AnchorProof,
} from '@haip/protocol';
import type { Store, Tx } from './store.js';
import {
  authenticatedCredentialHash,
  type Principal,
  type RouteConfig,
  type ServiceConfig,
} from './config.js';
import { isAnchorConflict, type AnchorStore } from './anchor.js';
import { missing, ProtocolError, requireThat } from './errors.js';
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
  review_cancelled_at?: string;
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
function checkpointEvidence(data: RequestData) {
  const anchor = data.anchor as AnchorProof | undefined;
  if (anchor?.checkpoint && anchor.acceptance) return anchor;
}
function checkStored<T>(check: () => T): T {
  try {
    return check();
  } catch {
    throw new ProtocolError(409, 'material_integrity_mismatch');
  }
}
function requireOriginalRecord(record: SignedRecord, original: SignedRecord | undefined) {
  checkStored(() =>
    requireThat(
      original && digest(record) === digest(original),
      409,
      'material_integrity_mismatch',
    ),
  );
}
function checkpointBinding(
  evidence: AnchorProof,
  receipt: Signed<DecisionReceipt>,
  decisionSequence?: number,
) {
  return checkStored(() => digest({ evidence, receipt, decisionSequence }));
}
async function resampleTime(tx: Tx, now: Date) {
  const { rows } = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  now.setTime(rows[0]!.now.getTime());
}
const iso = (now: Date, seconds = 0) => new Date(now.getTime() + seconds * 1000).toISOString();
const bytes = (v: unknown) => Buffer.byteLength(canonicalise(v));
const statementTimeUtc = `to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const privateExpiry = (data: RequestData) =>
  Math.min(
    Date.parse(data.request.private_delete_at),
    Date.parse(data.private_discard_at ?? data.request.private_delete_at),
  );
function reviewExpiry(data: RequestData) {
  const deadline = Date.parse(data.request.review_deadline);
  const material = privateExpiry(data);
  return Number.isFinite(material) ? Math.min(deadline, material) : deadline;
}
export function reviewStateSql(now: '$2' | '$3') {
  const privateDue = `(r.data->>'material_deleted'='true' OR LEAST(r.data->'request'->>'private_delete_at',r.data->>'private_discard_at') <= ${now})`;
  const decision = `CASE WHEN r.data->>'decision_state'='pending' AND
    (r.data->'request'->>'review_deadline' <= ${now} OR ${privateDue}) THEN 'expired' ELSE r.data->>'decision_state' END`;
  return { privateDue, decision };
}
const checkpointBatchSeconds = 300;
const checkpointBatchSize = 100;
export class ReviewService {
  recovery?: import('./recovery.js').RecoveryGuard;
  constructor(
    readonly store: Store,
    readonly config: ServiceConfig,
    readonly anchor?: AnchorStore,
  ) {}
  discovery() {
    return {
      name: 'HAIP — Human-Agent Interaction Protocol',
      revisions: [PROTOCOL_REVISION],
      profiles: { [EXECUTION_PROFILE]: EXECUTION_VERSION, 'haip.agent-ui': RENDERER.agent_ui },
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
    const {
      rows: [stored],
    } = await tx.query<Principal & { token_hash: string | null }>(
      'SELECT tenant,id,kind,config,token_hash FROM haip_principals WHERE tenant=$1 AND id=$2',
      [p.tenant, p.id],
    );
    requireThat(stored?.config.enabled && stored.kind === p.kind, 401, 'unauthenticated');
    const { token_hash: bearer, ...current } = stored;
    const hash = p[authenticatedCredentialHash];
    if (hash === undefined) return current;
    if (current.kind === 'human') {
      const session = await tx.query(
        `SELECT 1 FROM haip_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()
         AND data->>'tenant'=$2 AND data->>'id'=$3`,
        [hash, current.tenant, current.id],
      );
      requireThat(session.rowCount === 1, 401, 'unauthenticated');
    } else {
      requireThat(bearer === hash, 401, 'unauthenticated');
    }
    return { ...current, [authenticatedCredentialHash]: hash };
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
  async owned(
    tx: Tx,
    p: Principal,
    id: string,
    access: boolean | 'status' = true,
  ): Promise<RequestRow> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw missing();
    const { rows } = await tx.query(
      `SELECT tenant,id,producer,route,data,retained_bytes,${access === true ? 'material' : 'NULL::jsonb AS material'}
       FROM haip_requests WHERE tenant=$1 AND id=$2 AND data->'request'->>'audit_delete_at' > ${statementTimeUtc}`,
      [p.tenant, id],
    );
    const row: RequestRow | undefined = rows[0];
    if (!row) throw missing();
    if (p.kind === 'producer' && row.producer === p.id) return row;
    if (p.kind === 'operator') return row;
    if (p.kind === 'human') {
      const requester = row.data.request.requester;
      if (
        access === 'status' &&
        requester?.subject === p.id &&
        requester.source === 'operator_directory' &&
        p.config.identity_certain !== false
      )
        return row;
      const route = await this.route(tx, p, row.route);
      if (route.config.reviewers.includes(p.id)) return row;
    }
    throw missing();
  }
  private requireRetainedAudit(request: DecisionRequest, now: Date) {
    if (!(now.getTime() < Date.parse(request.audit_delete_at))) throw missing();
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
      `SELECT digest,CASE WHEN created_at > statement_timestamp()-($5::integer * interval '1 second')
        AND COALESCE(result->'request'->>'audit_delete_at' > ${statementTimeUtc}, true)
        THEN result END AS result FROM haip_idempotency WHERE tenant=$1 AND actor=$2 AND operation=$3 AND key=$4`,
      [p.tenant, p.id, operation, key, DEFAULT_LIMITS.audit_seconds],
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
    await this.queueCheckpoint(
      tx,
      p.tenant,
      now,
      checkpoint,
      type === 'DecisionReceipt' ? request?.id : undefined,
    );
    return seq;
  }

  private async queueCheckpoint(
    tx: Tx,
    tenant: string,
    now: Date,
    checkpoint: SignedRecord,
    confirmation?: string,
  ): Promise<void> {
    const immediate = confirmation !== undefined;
    const {
      rows: [batch],
    } = await tx.query<{
      id: string;
      checkpoint_batch_count: number;
      collecting: boolean;
    }>(
      `SELECT id,checkpoint_batch_count,next_at>clock_timestamp() AS collecting
       FROM haip_outbox WHERE tenant=$1 AND checkpoint_batch_count IS NOT NULL FOR UPDATE`,
      [tenant],
    );
    const body = JSON.stringify(checkpoint);
    if (batch?.collecting) {
      const count = batch.checkpoint_batch_count + 1;
      const due = immediate || count === checkpointBatchSize;
      await tx.query(
        `UPDATE haip_outbox SET body=$2,request_id=$3,checkpoint_batch_count=$4,
         next_at=CASE WHEN $4::smallint IS NULL THEN $5 ELSE next_at END WHERE id=$1`,
        [batch.id, body, confirmation ?? null, due ? null : count, now],
      );
      if (due) this.store.noteOutboxJob(tx, batch.id);
      return;
    }
    if (batch)
      await tx.query('UPDATE haip_outbox SET checkpoint_batch_count=NULL WHERE id=$1', [batch.id]);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO haip_outbox(id,tenant,request_id,kind,body,created_at,next_at,checkpoint_batch_count)
       VALUES($1,$2,$3,'checkpoint',$4,$5,$6,$7)`,
      [
        id,
        tenant,
        confirmation ?? null,
        body,
        now,
        immediate ? now : iso(now, checkpointBatchSeconds),
        immediate ? null : 1,
      ],
    );
    this.store.noteOutboxJob(tx, id);
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
    if (producer.config.webhook) {
      const job = randomUUID();
      await tx.query(
        "INSERT INTO haip_outbox(id,tenant,producer,request_id,kind,destination,body) VALUES($1,$2,$3,$4,'webhook',$5,$6)",
        [job, p.tenant, row.producer, row.id, producer.config.webhook, JSON.stringify(record)],
      );
      this.store.noteOutboxJob(tx, job);
    }
    await this.audit(tx, producer, now, 'RequestChangedEvent', record.payload, d.request);
  }
  async notifications(
    tx: Tx,
    row: RequestRow,
    now: Date,
    recipients: readonly string[],
    recipientRole: 'reviewer' | 'requester',
  ): Promise<void> {
    if (!this.config.smtp) return;
    const link = `${this.config.origin}/review/${row.id}`;
    const text = row.data.material_deleted
      ? `Review ${row.id}\nReview material was deleted.\n${link}\nSign in to view the current status.`
      : `Review ${row.id}\n${row.data.request.summary}\nDeadline: ${row.data.request.review_deadline}\n${link}\nSign in to review. This email cannot approve a request.`;
    for (const id of [...new Set(recipients)]) {
      const { rows } = await tx.query(
        "SELECT config FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='human'",
        [row.tenant, id],
      );
      const c = rows[0]?.config;
      if (!c?.enabled || !c.email_verified || !c.email) continue;
      const job = randomUUID();
      await tx.query(
        "INSERT INTO haip_outbox(id,tenant,producer,request_id,kind,destination,body,created_at) VALUES($1,$2,$3,$4,'smtp',$5,$6,$7)",
        [
          job,
          row.tenant,
          row.producer,
          row.id,
          c.email,
          JSON.stringify({
            recipient_id: id,
            recipient_role: recipientRole,
            subject: 'HAIP review update',
            text,
          }),
          now,
        ],
      );
      this.store.noteOutboxJob(tx, job);
    }
  }
  /** Effective expiry is visible immediately, without making a GET request an audit actor. */
  private project(row: RequestRow, now: Date): { reason?: string; materialDiscarded: boolean } {
    const d = row.data;
    let reason: string | undefined;
    if (d.decision_state === 'pending' && now.getTime() >= reviewExpiry(d)) {
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
    const materialDiscarded = !d.material_deleted && now.getTime() >= privateExpiry(d);
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
        `UPDATE haip_outbox SET body='{}',destination=NULL,accepted=NULL,claim_until=NULL,claim_revision=NULL,
           state=CASE WHEN state='pending' THEN 'expired' ELSE state END
         WHERE tenant=$1 AND request_id=$2 AND kind='smtp'`,
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
      this.requireStoredIntegrity(row);
      this.pending(row, now);
      return this.idempotent(tx, p, 'remind:' + id, key, {}, async () => {
        requireThat(
          !row.data.reminder_at || now.getTime() - Date.parse(row.data.reminder_at) >= 86400000,
          429,
          'reminder_limit',
        );
        row.data.reminder_at = iso(now);
        const route = await this.route(tx, p, row.route);
        await this.notifications(tx, row, now, route.config.reviewers, 'reviewer');
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
        if (!row.data.material_deleted) {
          row.data.private_discard_at = iso(now);
          await this.refresh(tx, p, row, now, p);
          await this.notifications(tx, row, now, [row.data.request.requester.subject], 'requester');
        }
        return this.statusIn(tx, p, row, now);
      });
    });
  }
  async statusIn(tx: Tx, p: Principal, row: RequestRow, now: Date, readOnly = false) {
    if (readOnly) this.project(row, now);
    else await this.refresh(tx, p, row, now);
    const d = row.data;
    const { receipt, claim, outcome } = this.statusEvidence(row, readOnly);
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
      receipt: receipt ?? null,
      claim: claim ?? null,
      outcome: outcome ?? null,
      anchor: receipt ? (d.anchor ?? null) : null,
      delivery: deliveries,
      review_link: `${this.config.origin}/review/${row.id}`,
      polling_link: `${this.config.origin}/v2/requests/${row.id}`,
    };
  }
  async status(p: Principal, id: string) {
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      return this.statusIn(tx, p, await this.owned(tx, p, id, 'status'), now, true);
    });
  }
  async hitlReview(p: Principal, id: string) {
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id, 'status');
      const d = row.data;
      requireThat(d.request.purpose === 'review', 409, 'hitl_review_only');
      this.requireStoredIntegrity(row);
      this.project(row, now);
      const receipt = this.requireBoundReceipt(row);
      let candidate: DecisionCandidate | undefined;
      if (
        d.decision_state === 'confirmed' &&
        !d.material_deleted &&
        (p.kind !== 'human' ||
          p.id !== d.request.requester.subject ||
          (await this.route(tx, p, row.route)).config.reviewers.includes(p.id))
      ) {
        const material = await tx.query(
          'SELECT 1 FROM haip_requests WHERE tenant=$1 AND id=$2 AND material IS NOT NULL',
          [p.tenant, row.id],
        );
        if (material.rowCount) candidate = this.requireBoundCandidate(row, receipt);
      }
      return {
        request: d.request,
        decisionState: d.decision_state,
        auditState: d.audit_state,
        receipt,
        candidate,
        expiredAt: d.decision_state === 'expired' ? iso(new Date(reviewExpiry(d))) : undefined,
        cancelledAt: d.review_cancelled_at,
      };
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
      const { privateDue, decision } = reviewStateSql('$3');
      const visible = `r.tenant=$1 AND ${access} AND r.data->'request'->>'audit_delete_at' > $3
        AND ($4::text IS NULL OR (${decision})=$4)`;
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
       AND data->'request'->>'review_deadline' > $3 AND data->'request'->>'audit_delete_at' > $3`,
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
      requireThat(input.compatibility.agent_ui === RENDERER.agent_ui, 422, 'unsupported_renderer');
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
  private async prepareRequest(input: RequestInput, limits: Limits): Promise<PreparedRequest> {
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
    // Schema compilation runs in a bounded worker after preparation and before acquiring the tenant lock.
    await validateResponseSchema(input.response_schema);
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
      prepared: replay ? undefined : await this.prepareRequest(snapshot, limits),
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
      limits.audit_seconds,
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
      requireThat(
        input.profiles['haip.agent-ui'] === RENDERER.agent_ui,
        422,
        'agent_ui_profile_required',
      );
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
        created_at: found.manifest.created_at,
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
        Math.min(
          limits.audit_seconds,
          limits.review_seconds +
            (input.execution
              ? limits.grant_seconds + limits.execution_seconds + limits.reconciliation_seconds
              : 0),
        ),
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
      const checkedAt = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!
        .now;
      this.requireRetainedAudit(request, checkedAt);
      if (supersedes) this.requireRetainedAudit(supersedes.data.request, checkedAt);
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
    await this.notifications(tx, row, now, route.config.reviewers, 'reviewer');
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
  private requireCurrentRequest(row: RequestRow) {
    const request = row.data?.request as DecisionRequest | undefined;
    requireThat(request?.protocol_revision === PROTOCOL_REVISION, 409, 'unsupported_revision');
    const profiles = request.profiles as unknown;
    requireThat(
      !!profiles && typeof profiles === 'object' && !Array.isArray(profiles),
      409,
      'unsupported_profile',
    );
    const supported = this.discovery().profiles as Record<string, string>;
    for (const [name, version] of Object.entries(profiles))
      requireThat(supported[name] === version, 409, 'unsupported_profile');
    if (request.review?.bundle)
      requireThat(
        request.profiles['haip.agent-ui'] === RENDERER.agent_ui,
        409,
        'agent_ui_profile_required',
      );
  }
  private requireStoredIntegrity(row: RequestRow) {
    this.requireCurrentRequest(row);
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
  private recordInScope(row: RequestRow, record: SignedRecord | undefined, ...types: string[]) {
    const header = record?.protected;
    const payload = record?.payload as { request_id?: string } | undefined;
    return (
      !!header &&
      types.includes(header.type) &&
      header.tenant === row.tenant &&
      header.audience === row.producer &&
      payload?.request_id === row.id
    );
  }
  private requireStoredRecord(row: RequestRow, record: SignedRecord, ...types: string[]) {
    checkStored(() => {
      validate('SignedRecord', record);
      const request = row.data.request;
      requireThat(
        this.recordInScope(row, record, ...types) &&
          digest(record.protected.profiles) === digest(request.profiles),
        409,
        'material_integrity_mismatch',
      );
      verifyRecord(record, this.config.trust, {
        issuer: this.config.issuer,
        tenant: row.tenant,
        audience: row.producer,
        type: record.protected.type,
        purpose: request.purpose,
      });
    });
  }
  private requireBoundReceipt(row: RequestRow) {
    const d = row.data;
    const receipt = d.receipt;
    if (!receipt && d.decision_state !== 'confirmed') return;
    requireThat(receipt, 409, 'material_integrity_mismatch');
    return checkStored(() => {
      this.requireStoredRecord(row, receipt, 'DecisionReceipt');
      const payload = receipt.payload;
      validate('DecisionReceipt', payload);
      requireThat(
        payload.request_digest === d.request_digest &&
          payload.requester === d.request.requester.subject &&
          payload.purpose === d.request.purpose &&
          payload.confirmed_at === receipt.protected.issued_at &&
          Date.parse(payload.confirmed_at) >= Date.parse(d.request.accepted_at) &&
          Date.parse(payload.confirmed_at) < Date.parse(d.request.review_deadline),
        409,
        'material_integrity_mismatch',
      );
      return receipt;
    });
  }
  private requireBoundCandidate(
    row: RequestRow,
    receipt?: Signed<DecisionReceipt>,
    candidate = row.data.candidate,
  ) {
    if (!candidate && !receipt) return;
    requireThat(candidate, 409, 'material_integrity_mismatch');
    return checkStored(() => {
      validate('DecisionCandidate', candidate);
      const response = canonicalise(candidate.response);
      const execution = row.data.request.purpose === 'authorise_execution';
      requireThat(
        candidate.request_id === row.id &&
          candidate.request_digest === row.data.request_digest &&
          candidate.response_canonical === response &&
          candidate.response_digest === digestBytes(response) &&
          (execution ? ['authorise', 'refuse'] : ['answer', 'approve', 'reject']).includes(
            candidate.decision,
          ),
        409,
        'material_integrity_mismatch',
      );
      if (receipt)
        requireThat(
          receipt.payload.candidate_id === candidate.id &&
            receipt.payload.candidate_digest === digest(candidate) &&
            receipt.payload.response_digest === candidate.response_digest &&
            receipt.payload.reviewer === candidate.reviewer &&
            receipt.payload.decision === candidate.decision &&
            Date.parse(candidate.created_at) <= Date.parse(receipt.payload.confirmed_at),
          409,
          'material_integrity_mismatch',
        );
      return candidate;
    });
  }
  private requireBoundClaim(row: RequestRow, receipt: Signed<DecisionReceipt> | undefined) {
    const d = row.data;
    const claim = d.claim;
    if (!claim) return;
    return checkStored(() => {
      this.requireStoredRecord(row, claim, 'ExecutionClaim');
      const payload = claim.payload;
      const execution = d.request.execution;
      validate('ExecutionClaim', payload);
      requireThat(
        receipt?.payload.decision === 'authorise' &&
          execution &&
          payload.request_digest === d.request_digest &&
          payload.receipt_digest === digest(receipt) &&
          payload.execution_binding_digest === digest(execution) &&
          payload.action_occurrence_id === execution.action_occurrence_id &&
          payload.execution_seconds === execution.execution_seconds &&
          payload.dispatch_before === receipt.payload.grant_deadline &&
          payload.claimed_at === claim.protected.issued_at &&
          Date.parse(payload.claimed_at) >= Date.parse(receipt.payload.confirmed_at) &&
          Date.parse(payload.claimed_at) < Date.parse(payload.dispatch_before),
        409,
        'material_integrity_mismatch',
      );
      return claim;
    });
  }
  private requireBoundOutcome(
    row: RequestRow,
    claim: Signed<ExecutionClaim> | undefined,
    outcome = row.data.outcome,
  ) {
    if (!outcome) return;
    return checkStored(() => {
      this.requireStoredRecord(row, outcome, 'ExecutionOutcome', 'ExecutionReconciliation');
      validate('ExecutionOutcome', outcome.payload.outcome);
      requireThat(
        claim &&
          outcome.payload.claim_digest === digest(claim) &&
          outcome.payload.outcome.execution_identity === claim.payload.execution_identity &&
          outcome.payload.recorded_at === outcome.protected.issued_at,
        409,
        'material_integrity_mismatch',
      );
      return outcome;
    });
  }
  private requireExportRecords(row: RequestRow, receipt: Signed<DecisionReceipt> | undefined) {
    checkStored(() => {
      const claim = this.requireBoundClaim(row, receipt);
      const outcome = this.requireBoundOutcome(row, claim);
      const pending = new Set(
        [receipt, claim, outcome].filter((record) => record !== undefined).map(digest),
      );
      requireThat(Array.isArray(row.data.records), 409, 'material_integrity_mismatch');
      for (const record of row.data.records) {
        switch (record.protected?.type) {
          case 'DecisionReceipt':
            requireOriginalRecord(record, receipt);
            break;
          case 'ExecutionClaim':
            requireOriginalRecord(record, claim);
            break;
          case 'AdmissionStatus': {
            this.requireStoredRecord(row, record, 'AdmissionStatus');
            const payload = record.payload as AdmissionStatus;
            validate('AdmissionStatus', payload);
            requireThat(
              claim &&
                payload.claim_digest === digest(claim) &&
                payload.claim_id === claim.payload.id &&
                payload.execution_identity === claim.payload.execution_identity &&
                payload.execution_binding_digest === claim.payload.execution_binding_digest &&
                payload.dispatch_before === claim.payload.dispatch_before &&
                payload.execution_seconds === claim.payload.execution_seconds &&
                payload.checked_at === record.protected.issued_at,
              409,
              'material_integrity_mismatch',
            );
            continue;
          }
          case 'ExecutionOutcome':
          case 'ExecutionReconciliation':
            this.requireBoundOutcome(row, claim, record as RequestData['outcome']);
            break;
          default:
            throw new ProtocolError(409, 'material_integrity_mismatch');
        }
        pending.delete(digest(record));
      }
      requireThat(pending.size === 0, 409, 'material_integrity_mismatch');
    });
  }
  private statusEvidence(row: RequestRow, readOnly: boolean) {
    const d = row.data;
    if (d.request.protocol_revision !== PROTOCOL_REVISION)
      return {
        receipt: this.recordInScope(row, d.receipt, 'DecisionReceipt') ? d.receipt : undefined,
        claim: this.recordInScope(row, d.claim, 'ExecutionClaim') ? d.claim : undefined,
        outcome: this.recordInScope(row, d.outcome, 'ExecutionOutcome', 'ExecutionReconciliation')
          ? d.outcome
          : undefined,
      };
    try {
      const receipt = this.requireBoundReceipt(row);
      if (receipt)
        checkStored(() =>
          requireThat(digest(d.request) === d.request_digest, 409, 'material_integrity_mismatch'),
        );
      const claim = this.requireBoundClaim(row, receipt);
      return { receipt, claim, outcome: this.requireBoundOutcome(row, claim) };
    } catch (error) {
      if (readOnly) throw error;
      // Allow revocation and deletion to commit even when the signed evidence is damaged.
      return {};
    }
  }
  private async readMaterial(tx: Tx, p: Principal, id: string, now: Date) {
    const row = await this.owned(tx, await this.principal(tx, p), id);
    this.requireStoredIntegrity(row);
    this.project(row, now);
    requireThat(row.material, 410, 'material_deleted');
    const candidate = this.requireBoundCandidate(row, this.requireBoundReceipt(row));
    return {
      request: row.data.request,
      request_digest: row.data.request_digest,
      ...row.material,
      candidate: candidate ?? null,
    };
  }
  async material(p: Principal, id: string) {
    return this.store.read((tx, now) => this.readMaterial(tx, p, id, now));
  }
  async appMaterial(p: Principal, id: string) {
    requireThat(p.kind === 'human', 403, 'human_required');
    return this.store.read(async (tx, now) => {
      const material = await this.readMaterial(tx, p, id, now);
      const binding = material.request.review.bundle;
      requireThat(binding, 404, 'not_found');
      const { rows } = await tx.query<{ html: unknown; manifest: unknown }>(
        'SELECT html,manifest FROM haip_bundles WHERE tenant=$1 AND id=$2 AND publisher=$3',
        [p.tenant, binding.id, binding.publisher],
      );
      const bundle = rows[0];
      requireBoundBundle(bundle, p.tenant, binding);
      return { material, bundle };
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
    this.requireCurrentRequest(row);
    this.requireRetainedAudit(row.data.request, now);
    requireThat(
      row.data.decision_state === 'pending' &&
        now.getTime() < reviewExpiry(row.data) &&
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
    const proposalJSON = canonicalise(input);
    input = JSON.parse(proposalJSON);
    const proposalDigest = digestBytes(proposalJSON);
    let schema: unknown;
    let schemaDigest: string | undefined;
    const replay = await this.preflight(
      p,
      'decision.propose:' + id,
      key,
      async (tx, current, now) => {
        const row = await this.owned(tx, current, id);
        await this.eligible(tx, current, row);
        this.pending(row, now);
        const r = row.data.request;
        requireThat(
          r.purpose === 'authorise_execution'
            ? ['authorise', 'refuse'].includes(input.decision)
            : ['approve', 'reject', 'answer'].includes(input.decision),
          400,
          'purpose_decision_mismatch',
        );
        requireThat(bytes(input.response) <= r.limits.response_bytes, 413, 'response_too_large');
        schema = row.material!.response_schema;
        schemaDigest = r.review.response_schema_digest;
      },
    );
    if (!replay) await validateResponseSchema(schema, input.response, true);
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      await this.eligible(tx, p, row);
      this.pending(row, now);
      const candidate = await this.idempotent(
        tx,
        p,
        'decision.propose:' + id,
        key,
        input,
        async () => {
          requireThat(!replay, 409, 'idempotency_changed');
          const r = row.data.request;
          requireThat(
            r.review.response_schema_digest === schemaDigest,
            409,
            'material_integrity_mismatch',
          );
          requireThat(
            r.purpose === 'authorise_execution'
              ? ['authorise', 'refuse'].includes(input.decision)
              : ['approve', 'reject', 'answer'].includes(input.decision),
            400,
            'purpose_decision_mismatch',
          );
          requireThat(bytes(input.response) <= r.limits.response_bytes, 413, 'response_too_large');
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
          // Previously reserved space remains usable even if a later registration or route has a larger retained-data allowance. Only new storage needs another quota check.
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
        },
        proposalDigest,
      );
      if (candidate !== row.data.candidate) this.requireBoundCandidate(row, undefined, candidate);
      return candidate;
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
      const receipt = await this.idempotent(
        tx,
        p,
        'decision.confirm:' + id,
        key,
        { candidateId, candidateDigest },
        async () => {
          this.pending(row, now);
          const d = row.data;
          const c = this.requireBoundCandidate(row);
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
          if (execution && this.recovery)
            await this.recovery.check(tx, p.tenant, d.request.authority_namespace);
          p = await this.principal(tx, p);
          await resampleTime(tx, now);
          this.pending(row, now);
          if (execution)
            d.grant_deadline = new Date(
              Math.min(
                now.getTime() + d.request.limits.grant_seconds * 1000,
                Date.parse(execution.valid_until),
                Date.parse(d.request.audit_delete_at),
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
          await this.notifications(tx, row, now, [d.request.requester.subject], 'requester');
          await this.save(tx, row);
          return receipt;
        },
      );
      if (receipt !== row.data.receipt) {
        const original = this.requireBoundReceipt(row);
        if (row.material && !row.data.material_deleted && now.getTime() < privateExpiry(row.data))
          this.requireBoundCandidate(row, original);
        requireOriginalRecord(receipt, original);
      }
      return receipt;
    });
  }
  closePendingReview(row: RequestRow, now: Date, state: 'cancelled' | 'superseded') {
    const d = row.data;
    if (d.decision_state !== 'pending') return;
    if (now.getTime() >= reviewExpiry(d)) {
      d.decision_state = 'expired';
      return;
    }
    d.decision_state = state;
    d.review_cancelled_at = iso(now);
  }
  async invalidate(p: Principal, id: string, reason: 'cancelled' | 'revoked', key?: string) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(['operator', 'producer'].includes(p.kind), 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      return this.idempotent(tx, p, reason + ':' + id, key, {}, async () => {
        row.data.invalidated = reason;
        if (!row.data.receipt) delete row.data.candidate;
        this.closePendingReview(row, now, 'cancelled');
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
          this.closePendingReview(old, now, 'superseded');
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
  async fenceAnchor(tx: Tx, tenant: string, code: string) {
    await tx.query('INSERT INTO haip_incidents(tenant,code) VALUES($1,$2)', [tenant, code]);
    await tx.query('UPDATE haip_tenants SET fenced=true WHERE id=$1', [tenant]);
    await tx.query(
      "UPDATE haip_requests SET data=jsonb_set(data,'{audit_state}','\"conflict\"') WHERE tenant=$1",
      [tenant],
    );
  }
  private async verifyCheckpoint(p: Principal, id: string, grantState: 'available' | 'consumed') {
    if (!this.anchor) return;
    const snapshot = await this.store.read(async (tx, now) => {
      const producer = await this.principal(tx, p);
      requireThat(producer.kind === 'producer', 403, 'producer_required');
      const row = await this.owned(tx, producer, id, false);
      const { data } = row;
      if (
        data.request.purpose !== 'authorise_execution' ||
        data.invalidated ||
        data.audit_state !== 'anchored' ||
        data.grant_state !== grantState ||
        !data.grant_deadline ||
        !(now.getTime() < Date.parse(data.grant_deadline))
      )
        return;
      const tenant = (
        await tx.query<{ ledger_id: string; generation: string; fenced: boolean }>(
          'SELECT ledger_id,generation,fenced FROM haip_tenants WHERE id=$1',
          [producer.tenant],
        )
      ).rows[0];
      if (!tenant || tenant.fenced || data.request.authority_namespace !== tenant.generation)
        return;
      this.requireCurrentRequest(row);
      const receipt = this.requireBoundReceipt(row);
      requireThat(receipt, 409, 'material_integrity_mismatch');
      return {
        tenant,
        evidence: checkpointEvidence(data),
        decisionSequence: data.decision_sequence,
        receipt,
      };
    });
    if (!snapshot) return;
    // Provider I/O runs outside the tenant lock. The write transaction must still match the evidence just read.
    const { tenant, evidence } = snapshot;
    try {
      requireThat(evidence, 503, 'anchor_history_invalid');
      const payload = evidence.checkpoint.payload as
        { ledger_id?: string; generation?: string; sequence?: number } | undefined;
      requireThat(
        payload?.ledger_id === tenant.ledger_id &&
          payload.generation === tenant.generation &&
          typeof payload.sequence === 'number' &&
          typeof snapshot.decisionSequence === 'number' &&
          payload.sequence >= snapshot.decisionSequence,
        503,
        'anchor_history_invalid',
      );
      checkStored(() => {
        validate('AnchorProof', evidence);
        verifyRecord(evidence.checkpoint, this.config.trust, {
          issuer: this.config.issuer,
          tenant: tenant.ledger_id,
          audience: 'haip.audit',
          type: 'AuditCheckpoint',
          purpose: 'service',
        });
        requireThat(
          evidence.proof[0]?.sequence === snapshot.decisionSequence,
          409,
          'material_integrity_mismatch',
        );
        verifyCheckpointProof(evidence, digest(snapshot.receipt));
      });
      await this.anchor.verifyAcceptance(evidence.checkpoint, evidence.acceptance);
      return checkpointBinding(evidence, snapshot.receipt, snapshot.decisionSequence);
    } catch (error) {
      if (error instanceof ProtocolError && isAnchorConflict(error.code)) {
        await this.store.transaction(p.tenant, async (tx) => {
          const current = await tx.query(
            'SELECT 1 FROM haip_tenants WHERE id=$1 AND generation=$2 AND NOT fenced',
            [p.tenant, tenant.generation],
          );
          if (current.rowCount) await this.fenceAnchor(tx, p.tenant, error.code);
        });
      }
      throw error;
    }
  }
  private requireGrantDeadline(data: RequestData, now: Date) {
    requireThat(
      data.grant_deadline && now.getTime() < Date.parse(data.grant_deadline),
      409,
      'grant_expired',
    );
  }
  private async recheckGrantWindow(tx: Tx, data: RequestData, now: Date) {
    await resampleTime(tx, now);
    this.requireRetainedAudit(data.request, now);
    this.requireGrantDeadline(data, now);
    requireThat(now.getTime() < privateExpiry(data), 409, 'authority_revoked');
  }
  async authority(
    tx: Tx,
    p: Principal,
    row: RequestRow,
    now: Date,
    existingClaim = false,
    checkpointDigest?: string,
  ) {
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
    requireThat(
      this.config.mode !== 'production' || this.anchor?.production,
      503,
      'independent_anchor_required',
    );
    if (this.recovery) {
      requireThat(r.authority_namespace, 409, 'namespace_missing');
      await this.recovery.check(tx, p.tenant, r.authority_namespace);
      await resampleTime(tx, now);
    }
    this.requireRetainedAudit(r, now);
    const tenant = (await tx.query('SELECT fenced FROM haip_tenants WHERE id=$1', [p.tenant]))
      .rows[0];
    requireThat(!tenant.fenced, 503, 'admission_fenced');
    requireThat(!d.invalidated, 409, 'authority_revoked');
    const receipt = this.requireBoundReceipt(row);
    requireThat(receipt?.payload.decision === 'authorise', 409, 'authority_revoked');
    requireThat(d.audit_state === 'anchored', 409, 'pending_anchor');
    this.requireGrantDeadline(d, now);
    requireThat(
      existingClaim ? d.grant_state === 'consumed' : d.grant_state === 'available',
      409,
      'grant_unavailable',
    );
    requireThat(
      row.material && !d.material_deleted && now.getTime() < privateExpiry(d),
      409,
      'authority_revoked',
    );
    requireThat(
      d.grant_deadline === receipt.payload.grant_deadline,
      409,
      'material_integrity_mismatch',
    );
    this.requireBoundCandidate(row, receipt);
    if (this.anchor) {
      const evidence = checkpointEvidence(d);
      requireThat(
        evidence && checkpointDigest === checkpointBinding(evidence, receipt, d.decision_sequence),
        409,
        'anchor_recheck_required',
      );
    }
    const reviewer = (
      await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
        p.tenant,
        receipt.payload.reviewer,
      ])
    ).rows[0] as Principal | undefined;
    requireThat(reviewer?.config.enabled, 409, 'reviewer_ineligible');
    await this.eligible(tx, reviewer, row);
    return receipt;
  }
  async claim(p: Principal, id: string, input: ClaimInput, key?: string) {
    validate('ClaimInput', input);
    const checkpointDigest = await this.verifyCheckpoint(p, id, 'available');
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'producer', 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      this.requireStoredIntegrity(row);
      if (this.recovery) {
        await this.recovery.check(tx, p.tenant, row.data.request.authority_namespace);
        await resampleTime(tx, now);
        this.requireRetainedAudit(row.data.request, now);
      }
      const claim = await this.idempotent(tx, p, 'execution.claim:' + id, key, input, async () => {
        await this.authority(tx, p, row, now, false, checkpointDigest);
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
        await this.recheckGrantWindow(tx, d, now);
        if (this.recovery) {
          await this.recovery.consume(
            p.tenant,
            p.id,
            execution.action_occurrence_id,
            input.execution_identity,
            d.request.authority_namespace!,
            d.request_digest,
          );
          await this.authority(tx, p, row, now, false, checkpointDigest);
          await this.recheckGrantWindow(tx, d, now);
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
      if (claim !== row.data.claim) {
        const receipt = this.requireBoundReceipt(row);
        if (row.material && !row.data.material_deleted && now.getTime() < privateExpiry(row.data))
          this.requireBoundCandidate(row, receipt);
        requireOriginalRecord(claim, this.requireBoundClaim(row, receipt));
      }
      return claim;
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
    const checkpointDigest = await this.verifyCheckpoint(p, id, 'consumed');
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'producer', 403, 'producer_required');
      const row = await this.owned(tx, p, id);
      const receipt = await this.authority(tx, p, row, now, true, checkpointDigest);
      const d = row.data,
        claim = this.requireBoundClaim(row, receipt);
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
      await this.recheckGrantWindow(tx, d, now);
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
      const claim = this.requireBoundClaim(row, this.requireBoundReceipt(row));
      const prior = this.requireBoundOutcome(row, claim);
      const report = await this.idempotent(
        tx,
        p,
        (reconcile ? 'reconcile:' : 'outcome:') + id,
        key,
        input,
        async () => {
          const d = row.data;
          requireThat(
            claim && claim.payload.execution_identity === input.execution_identity,
            409,
            'claim_unavailable',
          );
          if (reconcile)
            requireThat(
              input.details.reason && input.details.evidence,
              400,
              'reconciliation_evidence_required',
            );
          if (prior && !reconcile) {
            requireThat(digest(prior.payload.outcome) === digest(input), 409, 'outcome_conflict');
            return prior;
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
              claim_digest: digest(claim),
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
      if (report !== row.data.outcome) this.requireBoundOutcome(row, claim, report);
      return report;
    });
  }
  async events(p: Principal, after = 0) {
    requireThat(p.kind === 'producer', 403, 'producer_required');
    return this.store.read(async (tx, now) => {
      await this.principal(tx, p);
      const rows = (
        await tx.query(
          `SELECT e.sequence,e.record FROM haip_events e
           JOIN haip_requests r ON r.tenant=e.tenant AND r.id=e.request_id AND r.producer=e.producer
           WHERE e.tenant=$1 AND e.producer=$2 AND e.sequence>$3 AND r.data->'request'->>'audit_delete_at' > $4
           ORDER BY e.sequence LIMIT 100`,
          [p.tenant, p.id, after, iso(now)],
        )
      ).rows;
      return {
        items: rows.map((r) => r.record),
        next: rows.length ? Number(rows.at(-1)!.sequence) : after,
      };
    });
  }
  async ledger(p: Principal, after: number) {
    requireThat(p.kind === 'operator', 403, 'operator_required');
    return this.store.read(async (tx, now) => {
      await this.principal(tx, p);
      const { rows } = await tx.query(
        `SELECT a.tenant,a.sequence,a.request_id,a.previous_head,a.head,a.record_digest,
          CASE WHEN a.created_at>$3 AND (a.request_id IS NULL OR r.data->'request'->>'audit_delete_at' > $4)
          THEN a.record END AS record,a.created_at
         FROM haip_audit a LEFT JOIN haip_requests r ON r.tenant=a.tenant AND r.id=a.request_id
         WHERE a.tenant=$1 AND a.sequence>$2 ORDER BY a.sequence LIMIT 100`,
        [p.tenant, after, iso(now, -DEFAULT_LIMITS.audit_seconds), iso(now)],
      );
      return rows;
    });
  }
  async export(p: Principal, id: string) {
    return this.store.read(async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      this.requireStoredIntegrity(row);
      this.project(row, now);
      const receipt = this.requireBoundReceipt(row);
      const candidate = row.material ? this.requireBoundCandidate(row, receipt) : undefined;
      this.requireExportRecords(row, receipt);
      const audit = (
        await tx.query(
          'SELECT sequence,previous_head,head,record_digest,record FROM haip_audit WHERE tenant=$1 AND request_id=$2 ORDER BY sequence',
          [p.tenant, id],
        )
      ).rows;
      requireThat(
        audit.every(
          ({ record, record_digest }) =>
            record === null ||
            (typeof record === 'string' && digestBytes(record) === record_digest),
        ),
        409,
        'material_integrity_mismatch',
      );
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
              candidate: candidate ?? null,
              ...(bundle ? { bundle } : {}),
            }
          : null,
        verification:
          'Trust roots must be configured independently. Signatures attest records, not human understanding or external effects. Request audit entries are a filtered chain; verify complete checkpoints with the operator ledger export.',
      };
    });
  }
}
