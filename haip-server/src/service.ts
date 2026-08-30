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
      profiles: { [EXECUTION_PROFILE]: EXECUTION_VERSION, 'haip.mcp-app': '1-draft.1' },
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
  async owned(tx: Tx, p: Principal, id: string): Promise<RequestRow> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw missing();
    const { rows } = await tx.query('SELECT * FROM haip_requests WHERE tenant=$1 AND id=$2', [
      p.tenant,
      id,
    ]);
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
  ): Promise<T> {
    requireThat(
      key && key.length <= 160 && /^[\x21-\x7e]+$/.test(key),
      400,
      'idempotency_key_required',
    );
    const hash = digest(input);
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
  async refresh(tx: Tx, p: Principal, row: RequestRow, now: Date): Promise<void> {
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
    if (
      now.getTime() >=
        Math.min(
          Date.parse(d.request.private_delete_at),
          Date.parse(d.private_discard_at ?? d.request.private_delete_at),
        ) &&
      !d.material_deleted
    ) {
      row.material = null;
      d.material_deleted = true;
      delete d.candidate;
      if (d.decision_state === 'pending') d.decision_state = 'expired';
      row.retained_bytes = 0;
      await tx.query(
        'UPDATE haip_requests SET material=NULL,retained_bytes=0 WHERE tenant=$1 AND id=$2',
        [p.tenant, row.id],
      );
      await tx.query('UPDATE haip_idempotency SET result=NULL WHERE tenant=$1 AND operation=$2', [
        p.tenant,
        'decision.propose:' + row.id,
      ]);
      await tx.query(
        "UPDATE haip_outbox SET body='{}',destination=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE tenant=$1 AND request_id=$2 AND kind='smtp'",
        [p.tenant, row.id],
      );
      if (d.request.execution) d.invalidated = 'retention';
      if (['available', 'pending_anchor'].includes(d.grant_state)) d.grant_state = 'revoked';
      await this.audit(
        tx,
        p,
        now,
        'MaterialDiscarded',
        { request_id: row.id, request_digest: d.request_digest, reason: 'retention' },
        d.request,
      );
      reason = 'material_deleted';
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
        await this.refresh(tx, p, row, now);
        await this.notifications(tx, p, row, now, [row.data.request.requester.subject]);
        return this.statusIn(tx, p, row, now);
      });
    });
  }
  async statusIn(tx: Tx, p: Principal, row: RequestRow, now: Date) {
    await this.refresh(tx, p, row, now);
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
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      return this.statusIn(tx, p, await this.owned(tx, p, id), now);
    });
  }
  async list(p: Principal, filter: string | undefined, offset = 0) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(['producer', 'human', 'operator'].includes(p.kind), 403, 'forbidden');
      const { rows } = await tx.query(
        'SELECT * FROM haip_requests WHERE tenant=$1 ORDER BY created_at DESC,id',
        [p.tenant],
      );
      const visible = [];
      for (const row of rows as RequestRow[]) {
        if (p.kind === 'producer' && row.producer !== p.id) continue;
        if (
          p.kind === 'human' &&
          !(await this.route(tx, p, row.route)).config.reviewers.includes(p.id)
        )
          continue;
        await this.refresh(tx, p, row, now);
        if (filter && row.data.decision_state !== filter) continue;
        visible.push({
          id: row.id,
          summary: row.data.request.summary,
          deadline: row.data.request.review_deadline,
          decision: row.data.decision_state,
          audit: row.data.audit_state,
          grant: row.data.grant_state,
          execution: row.data.execution_state,
          assignment:
            row.data.review_claim && Date.parse(row.data.review_claim.expires_at) > now.getTime()
              ? row.data.review_claim
              : null,
        });
      }
      return {
        items: visible.slice(offset, offset + 50),
        total: visible.length,
        next_offset: offset + 50 < visible.length ? offset + 50 : null,
      };
    });
  }
  async registerBundle(p: Principal, input: BundleRegistration, key?: string) {
    validate('BundleRegistration', input);
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'publisher', 403, 'publisher_required');
      return this.idempotent(tx, p, 'bundle.register', key, input, async () => {
        requireThat(
          Buffer.byteLength(input.html) <= DEFAULT_LIMITS.bundle_bytes,
          413,
          'bundle_too_large',
        );
        requireThat(
          input.compatibility.ext_apps === RENDERER.ext_apps &&
            input.compatibility.mcp_sdk === RENDERER.mcp_sdk,
          422,
          'unsupported_renderer',
        );
        const size = Buffer.byteLength(input.html);
        const total = Number(
          (
            await tx.query(
              'SELECT COALESCE(sum(retained_bytes),0) AS total FROM haip_bundles WHERE tenant=$1 AND publisher=$2',
              [p.tenant, p.id],
            )
          ).rows[0].total,
        );
        requireThat(total + size <= DEFAULT_LIMITS.retained_bytes, 429, 'retained_quota');
        const producers = (
          await tx.query(
            "SELECT id FROM haip_principals WHERE tenant=$1 AND kind='producer' AND config->>'publisher'=$2",
            [p.tenant, p.id],
          )
        ).rows;
        for (const producer of producers) {
          const retained = Number(
            (
              await tx.query(
                'SELECT COALESCE(sum(retained_bytes),0) AS total FROM haip_requests WHERE tenant=$1 AND producer=$2',
                [p.tenant, producer.id],
              )
            ).rows[0].total,
          );
          requireThat(
            retained + total + size <= DEFAULT_LIMITS.retained_bytes,
            429,
            'retained_quota',
          );
        }
        const manifest = {
          id: randomUUID(),
          tenant: p.tenant,
          publisher: p.id,
          digest: digestBytes(input.html),
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
      });
    });
  }
  async creationQuota(
    tx: Tx,
    p: Principal,
    route: string,
    size: number,
    limits: Limits,
    now: Date,
  ): Promise<void> {
    const { rows } = await tx.query(
      `SELECT producer,route,created_at,retained_bytes,data->>'decision_state' AS state,data->'request'->>'review_deadline' AS deadline FROM haip_requests WHERE tenant=$1`,
      [p.tenant],
    );
    const own = rows.filter((r) => r.producer === p.id);
    const day = iso(now).slice(0, 10);
    // Daily counts survive request/audit deletion and credential rotation.
    // The tenant transaction lock serialises checks and increments together.
    for (const [scope, subject, maximum] of [
      ['tenant', '', 1000],
      ['producer', p.id, 200],
      ['route', route, 100],
    ] as const) {
      const used = await tx.query(
        'SELECT count FROM haip_creation_windows WHERE tenant=$1 AND day=$2 AND scope=$3 AND subject=$4',
        [p.tenant, day, scope, subject],
      );
      requireThat((used.rows[0]?.count ?? 0) < maximum, 429, 'daily_quota');
      await tx.query(
        `INSERT INTO haip_creation_windows(tenant,day,scope,subject,count) VALUES($1,$2,$3,$4,1)
         ON CONFLICT(tenant,day,scope,subject) DO UPDATE SET count=haip_creation_windows.count+1`,
        [p.tenant, day, scope, subject],
      );
    }
    requireThat(
      own.filter((r) => r.state === 'pending' && Date.parse(r.deadline) > now.getTime()).length <
        100 &&
        rows.filter((r) => r.state === 'pending' && Date.parse(r.deadline) > now.getTime()).length <
          500,
      429,
      'outstanding_quota',
    );
    // Token buckets are scoped to stable producer/tenant identities, never credentials.
    const tenantRow = (await tx.query('SELECT config FROM haip_tenants WHERE id=$1', [p.tenant]))
      .rows[0];
    const config = tenantRow.config;
    config.buckets ??= {};
    for (const [name, rate, burst] of [
      ['tenant', 50, 100],
      [`producer:${p.id}`, 10, 20],
    ] as const) {
      const old = config.buckets[name] ?? { tokens: burst, at: now.getTime() };
      const tokens = Math.min(
        burst,
        old.tokens + (Math.max(0, now.getTime() - old.at) * rate) / 60000,
      );
      requireThat(tokens >= 1, 429, 'creation_rate');
      config.buckets[name] = { tokens: tokens - 1, at: now.getTime() };
    }
    await tx.query('UPDATE haip_tenants SET config=$2 WHERE id=$1', [
      p.tenant,
      JSON.stringify(config),
    ]);
    const bundles = Number(
      (
        await tx.query(
          'SELECT COALESCE(sum(retained_bytes),0) AS total FROM haip_bundles WHERE tenant=$1 AND publisher=$2',
          [p.tenant, p.config.publisher ?? ''],
        )
      ).rows[0].total,
    );
    requireThat(
      own.reduce((sum, r) => sum + Number(r.retained_bytes), 0) + bundles + size <=
        limits.retained_bytes,
      429,
      'retained_quota',
    );
  }
  async createIn(tx: Tx, p: Principal, now: Date, input: RequestInput, supersedes?: RequestRow) {
    requireThat(p.kind === 'producer', 403, 'producer_required');
    validate('RequestInput', input);
    const namespace = this.recovery
      ? (await this.recovery.check(tx, p.tenant)).generation
      : (await tx.query('SELECT generation FROM haip_tenants WHERE id=$1', [p.tenant])).rows[0]
          .generation;
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
    validateResponseSchema(input.response_schema);
    requireThat(bytes(input.payload) <= limits.payload_bytes, 413, 'payload_too_large');
    requireThat(
      Buffer.byteLength(input.review_document) <= limits.payload_bytes,
      413,
      'document_too_large',
    );
    requireThat(bytes(input.response_schema) <= limits.response_bytes, 413, 'schema_too_large');
    let bundle;
    if (input.bundle_id) {
      requireThat(input.profiles['haip.mcp-app'] === '1-draft.1', 422, 'app_profile_required');
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
        payload_digest: digest(input.payload),
        response_schema_digest: digest(input.response_schema),
        document_digest: digestBytes(input.review_document),
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
    const material = {
      payload: input.payload,
      response_schema: input.response_schema,
      review_document: input.review_document,
    };
    // Reserve one maximum-size candidate and its idempotent response so creation cannot starve confirmation.
    const size = bytes(material) + bytes(request) + 6 * limits.response_bytes + 8192;
    await this.creationQuota(tx, p, input.route, size, limits, now);
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
        JSON.stringify(material),
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
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      return this.idempotent(tx, p, 'request.create', key, input, () =>
        this.createIn(tx, p, now, input),
      );
    });
  }
  async material(p: Principal, id: string) {
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      await this.refresh(tx, p, row, now);
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
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      requireThat(p.kind === 'producer', 403, 'producer_required');
      const old = await this.owned(tx, p, id);
      return this.idempotent(tx, p, 'supersede:' + id, key, input, async () => {
        requireThat(old.data.request.purpose === input.purpose, 409, 'purpose_immutable');
        requireThat(!old.data.claim, 409, 'occurrence_consumed');
        const created = await this.createIn(tx, p, now, input, old);
        old.data.invalidated = 'superseded';
        if (old.data.decision_state === 'pending') old.data.decision_state = 'superseded';
        if (!old.data.receipt) delete old.data.candidate;
        if (['available', 'pending_anchor'].includes(old.data.grant_state))
          old.data.grant_state = 'revoked';
        await this.event(tx, p, old, now, 'supersession');
        await this.save(tx, old);
        return created;
      });
    });
  }
  async authority(tx: Tx, p: Principal, row: RequestRow, now: Date, existingClaim = false) {
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
    return this.store.transaction(p.tenant, async (tx) => {
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
    return this.store.transaction(p.tenant, async (tx, now) => {
      p = await this.principal(tx, p);
      const row = await this.owned(tx, p, id);
      await this.refresh(tx, p, row, now);
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
