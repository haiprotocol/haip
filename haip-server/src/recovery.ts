import { randomUUID } from 'node:crypto';
import { digest, digestBytes, verifyRecord } from '@haip/protocol/crypto';
import type { SignedRecord } from '@haip/protocol';
import type { ReviewService, RequestRow } from './service.js';
import type { AnchorStore } from './anchor.js';
import type { Tx } from './store.js';
import { requireThat } from './errors.js';

/** Separate from database backups. Entries are immutable and retained indefinitely. */
export interface SafetyStore {
  readonly production: boolean;
  read(key: string): Promise<SignedRecord | undefined>;
  create(key: string, record: SignedRecord): Promise<SignedRecord>;
}

/** The reference runtime has one active process per namespace, with no transparent failover. */
export class RecoveryGuard {
  private readonly owner = randomUUID();
  constructor(
    readonly service: ReviewService,
    readonly store: SafetyStore,
  ) {}
  private scope(tenant: string) {
    return digest({ issuer: this.service.config.issuer, tenant });
  }
  private key(tenant: string, kind: string, identity: unknown) {
    return digest({ scope: this.scope(tenant), kind, identity }).slice(7);
  }
  private verify(key: string, record: SignedRecord) {
    verifyRecord(record, this.service.config.trust, {
      issuer: this.service.config.issuer,
      audience: 'haip.recovery',
      type: 'RecoveryFence',
      purpose: 'service',
      tenant: key,
    });
    const payload = record.payload as { key: string; value: unknown };
    requireThat(payload.key === key, 503, 'recovery_record_invalid');
    return payload.value;
  }
  private async get(key: string) {
    const record = await this.store.read(key);
    return record ? this.verify(key, record) : undefined;
  }
  private async put(key: string, value: unknown) {
    const record = this.service.signed(
      'RecoveryFence',
      { key, value },
      { id: 'haip.recovery', tenant: key, kind: 'operator', config: { enabled: true } },
      new Date(),
    );
    const accepted = await this.store.create(key, record);
    requireThat(
      digest(this.verify(key, accepted)) === digest(value),
      409,
      'recovery_fence_conflict',
    );
  }
  async activate(tenant: string, ledger: string, generation: string) {
    await this.put(this.key(tenant, 'ledger', ''), { ledger });
    requireThat(
      !(await this.get(this.key(tenant, 'retired', generation))),
      503,
      'namespace_retired',
    );
    await this.put(this.key(tenant, 'activation', generation), { generation, owner: this.owner });
  }
  async assertActive(tenant: string, generation: string) {
    requireThat(
      !(await this.get(this.key(tenant, 'retired', generation))),
      503,
      'namespace_retired',
    );
    const activation = await this.get(this.key(tenant, 'activation', generation));
    requireThat(
      activation && digest(activation) === digest({ generation, owner: this.owner }),
      503,
      'namespace_recovery_required',
    );
  }
  async retire(tenant: string, generation: string) {
    await this.put(this.key(tenant, 'retired', generation), { retired: true, generation });
  }
  async reserve(tenant: string, producer: string, occurrence: string, generation: string) {
    // Same occurrence may be superseded within a generation, never after retirement.
    await this.put(this.key(tenant, 'occurrence', { producer, occurrence }), { generation });
  }
  async consume(
    tenant: string,
    producer: string,
    occurrence: string,
    identity: string,
    generation: string,
    requestDigest: string,
  ) {
    const value = {
      generation,
      request_digest: requestDigest,
      execution_identity: digest(identity),
    };
    // If either write succeeds but the response/transaction is lost, no replacement identity is allowed.
    await this.put(this.key(tenant, 'execution_identity', { producer, identity }), value);
    await this.put(this.key(tenant, 'consumed', { producer, occurrence }), value);
  }
  async assertUnconsumed(tenant: string, producer: string, occurrence: string) {
    requireThat(
      !(await this.get(this.key(tenant, 'consumed', { producer, occurrence }))),
      409,
      'occurrence_consumed',
    );
  }
  async check(tx: Tx, tenant: string, namespace?: string) {
    const current = (await tx.query('SELECT * FROM haip_tenants WHERE id=$1', [tenant])).rows[0];
    requireThat(current && !current.fenced, 503, 'admission_fenced');
    if (namespace) requireThat(current.generation === namespace, 409, 'namespace_retired');
    await this.assertActive(tenant, current.generation);
    return current;
  }
}

/** Offline recovery: stop listeners/executors first. Never reconstruct missing authority. */
export async function recoverTenant(
  service: ReviewService,
  anchor: AnchorStore,
  guard: RecoveryGuard,
  tenant: string,
  operator: string,
  freshToken: string,
) {
  requireThat(
    /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(operator) && /^[A-Za-z0-9_-]{32,200}$/.test(freshToken),
    400,
    'invalid_recovery_operator',
  );
  await service.store.transaction(tenant, async (tx) => {
    requireThat(
      (await tx.query('UPDATE haip_tenants SET fenced=true WHERE id=$1 RETURNING id', [tenant]))
        .rowCount,
      404,
      'tenant_not_found',
    );
  });
  const previous = (
    await service.store.pool.query('SELECT * FROM haip_tenants WHERE id=$1', [tenant])
  ).rows[0];
  requireThat(
    !(
      await service.store.pool.query('SELECT 1 FROM haip_principals WHERE token_hash=$1', [
        digestBytes(freshToken),
      ])
    ).rowCount,
    400,
    'fresh_recovery_credential_required',
  );
  // Retirement must survive failure of every subsequent database operation.
  await guard.retire(tenant, previous.generation);
  const remote = await anchor.history(previous.ledger_id, previous.generation);
  let history = remote.length ? 'matching_retained_prefix' : 'indeterminate';
  for (const checkpoint of remote) {
    const local = (
      await service.store.pool.query(
        'SELECT head FROM haip_audit WHERE tenant=$1 AND sequence=$2',
        [tenant, checkpoint.sequence],
      )
    ).rows[0];
    if (local?.head !== checkpoint.head) history = 'missing_or_conflicting_history';
  }
  const generation = randomUUID();
  await service.store.transaction(tenant, async (tx, now) => {
    const locked = (await tx.query('SELECT generation FROM haip_tenants WHERE id=$1', [tenant]))
      .rows[0];
    requireThat(locked.generation === previous.generation, 409, 'recovery_changed');
    for (const row of (await tx.query('SELECT * FROM haip_requests WHERE tenant=$1', [tenant]))
      .rows as RequestRow[]) {
      const d = row.data;
      d.invalidated = 'namespace_retired';
      d.material_deleted = true;
      delete d.candidate;
      delete d.review_claim;
      if (d.decision_state === 'pending') d.decision_state = 'cancelled';
      if (d.request.execution) {
        if (d.grant_state !== 'consumed') d.grant_state = 'revoked';
        // A restored outcome may omit later reconciliation. Do not assert completion from it.
        d.execution_state = 'uncertain';
      }
      await service.save(tx, row);
    }
    // Conservatively reapply ALL possible deletions and revocations from a missing tail.
    // Original retained signatures stay intact; private content and old credentials do not.
    await tx.query('UPDATE haip_requests SET material=NULL,retained_bytes=0 WHERE tenant=$1', [
      tenant,
    ]);
    await tx.query('UPDATE haip_bundles SET html=NULL,retained_bytes=0 WHERE tenant=$1', [tenant]);
    await tx.query('UPDATE haip_idempotency SET result=NULL WHERE tenant=$1', [tenant]);
    await tx.query(
      "UPDATE haip_outbox SET state='expired',body='{}',destination=NULL WHERE tenant=$1 AND state='pending'",
      [tenant],
    );
    await tx.query(
      "UPDATE haip_principals SET token_hash=NULL,config=jsonb_set(config,'{enabled}','false') WHERE tenant=$1",
      [tenant],
    );
    await tx.query(
      "DELETE FROM haip_sessions WHERE data->'principal'->>'tenant'=$1 OR data->>'tenant'=$1",
      [tenant],
    );
    await tx.query(
      'UPDATE haip_routes SET revision=revision+1,config=config||\'{"reviewers":[],"allowed_producers":[]}\'::jsonb WHERE tenant=$1',
      [tenant],
    );
    await tx.query(
      "INSERT INTO haip_principals(tenant,id,kind,token_hash,config) VALUES($1,$2,'operator',$3,'{\"enabled\":true}') ON CONFLICT(tenant,id) DO UPDATE SET token_hash=EXCLUDED.token_hash,config=EXCLUDED.config WHERE haip_principals.kind='operator'",
      [tenant, operator, digestBytes(freshToken)],
    );
    requireThat(
      (
        await tx.query(
          "SELECT 1 FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='operator' AND token_hash=$3",
          [tenant, operator, digestBytes(freshToken)],
        )
      ).rowCount,
      409,
      'recovery_operator_conflict',
    );
    await tx.query(
      'INSERT INTO haip_recoveries(tenant,old_generation,new_generation,history_state) VALUES($1,$2,$3,$4)',
      [tenant, previous.generation, generation, history],
    );
    await tx.query('INSERT INTO haip_incidents(tenant,code,details) VALUES($1,$2,$3)', [
      tenant,
      'namespace_retired',
      JSON.stringify({
        previous: previous.generation,
        generation,
        history,
        recovered_at: now.toISOString(),
      }),
    ]);
    await tx.query('UPDATE haip_tenants SET generation=$2,fenced=true WHERE id=$1', [
      tenant,
      generation,
    ]);
  });
  return {
    tenant,
    retired_generation: previous.generation,
    generation,
    history_state: history,
    admission: 'fenced_until_startup_and_fresh_provisioning',
  };
}
