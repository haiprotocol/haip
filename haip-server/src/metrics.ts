import type { ReviewService } from './service.js';
import type { Principal } from './config.js';
import { requireThat } from './errors.js';
/** No request identifiers, payloads, addresses, credentials or reviewer names are metric labels. */
export class Metrics {
  private readonly requests = new Map<
    string,
    { total: number; failures: number; conflicts: number }
  >();
  observe(tenant: string, status: number) {
    const counter = this.requests.get(tenant) ?? { total: 0, failures: 0, conflicts: 0 };
    counter.total++;
    if (status >= 400) counter.failures++;
    if (status === 409) counter.conflicts++;
    this.requests.set(tenant, counter);
  }
  async snapshot(service: ReviewService, principal: Principal) {
    requireThat(principal.kind === 'operator', 403, 'operator_required');
    return service.store.read(async (tx) => {
      await service.principal(tx, principal);
      const t = principal.tenant;
      const requests = (
        await tx.query(
          `SELECT count(*) AS retained,
        count(*) FILTER(WHERE data->>'decision_state'='pending') AS pending,
        count(*) FILTER(WHERE data->>'execution_state' IN ('uncertain','claimed','admitted') AND data->'outcome' IS NULL) AS unresolved_execution,
        COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(created_at) FILTER(WHERE data->>'decision_state'='pending')),0) AS oldest_pending_seconds,
        COALESCE(sum(retained_bytes),0) AS retained_bytes FROM haip_requests WHERE tenant=$1`,
          [t],
        )
      ).rows[0];
      const jobs = (
        await tx.query(
          `SELECT kind,state,count(*) AS count,
        COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)),0) AS oldest_seconds
        FROM haip_outbox WHERE tenant=$1 GROUP BY kind,state`,
          [t],
        )
      ).rows;
      const reviewers = Number(
        (
          await tx.query(
            `SELECT count(*) FROM haip_principals
        WHERE tenant=$1 AND kind='human' AND config->>'enabled'='true'`,
            [t],
          )
        ).rows[0].count,
      );
      const fenced = (await tx.query('SELECT fenced FROM haip_tenants WHERE id=$1', [t])).rows[0]
        .fenced;
      const incidents = (
        await tx.query(
          'SELECT id,code,created_at FROM haip_incidents WHERE tenant=$1 ORDER BY id DESC LIMIT 50',
          [t],
        )
      ).rows;
      const operations = (
        await tx.query(
          'SELECT name,succeeded_at,failed_at FROM haip_tenant_operations WHERE tenant=$1 ORDER BY name',
          [t],
        )
      ).rows;
      const counters = this.requests.get(t) ?? { total: 0, failures: 0, conflicts: 0 };
      return {
        admission_fenced: fenced,
        requests: Object.fromEntries(
          Object.entries(requests).map(([key, value]) => [key, Number(value)]),
        ),
        enabled_reviewers: reviewers,
        pending_per_reviewer: reviewers ? Number(requests.pending) / reviewers : null,
        delivery: jobs.map((r) => ({
          ...r,
          count: Number(r.count),
          oldest_seconds: Number(r.oldest_seconds),
        })),
        incidents,
        operations,
        http_since_process_start: counters,
        policy_and_executor_evidence: 'external_executor_responsibility',
      };
    });
  }
}
export function prometheus(snapshot: Awaited<ReturnType<Metrics['snapshot']>>) {
  const lines = ['# HAIP metrics are scoped to the authenticated operator tenant.'];
  const metric = (name: string, value: number, type = 'gauge', labels = '') => {
    lines.push(`# TYPE haip_${name} ${type}`, `haip_${name}${labels} ${value}`);
  };
  metric('admission_fenced', Number(snapshot.admission_fenced));
  for (const [name, value] of Object.entries(snapshot.requests)) metric(name, value);
  metric('enabled_reviewers', snapshot.enabled_reviewers);
  for (const [name, value] of Object.entries(snapshot.http_since_process_start))
    metric('http_' + name + '_total', value, 'counter');
  lines.push('# TYPE haip_outbox_jobs gauge', '# TYPE haip_outbox_oldest_seconds gauge');
  for (const r of snapshot.delivery) {
    const labels = `{kind="${r.kind}",state="${r.state}"}`;
    lines.push(
      `haip_outbox_jobs${labels} ${r.count}`,
      `haip_outbox_oldest_seconds${labels} ${r.oldest_seconds}`,
    );
  }
  metric('incidents_retained', snapshot.incidents.length);
  lines.push(
    '# TYPE haip_operation_last_success_seconds gauge',
    '# TYPE haip_operation_last_failure_seconds gauge',
  );
  for (const name of ['outbox', 'retention']) {
    const operation = snapshot.operations.find((o) => o.name === name);
    lines.push(
      `haip_operation_last_success_seconds{operation="${name}"} ${operation?.succeeded_at ? new Date(operation.succeeded_at).getTime() / 1000 : 0}`,
      `haip_operation_last_failure_seconds{operation="${name}"} ${operation?.failed_at ? new Date(operation.failed_at).getTime() / 1000 : 0}`,
    );
  }
  return lines.join('\n') + '\n';
}
