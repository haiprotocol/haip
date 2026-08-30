import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS } from '@haip/protocol';
import { digest, digestBytes } from '@haip/protocol/crypto';
import type { ReviewService, RequestRow } from './service.js';
import type { Principal, RouteConfig } from './config.js';
import { requireThat } from './errors.js';
const name = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(v);
export async function registerPrincipal(
  service: ReviewService,
  p: Principal,
  input: Principal & { token?: string },
) {
  requireThat(p.kind === 'operator', 403, 'operator_required');
  requireThat(
    name(input.id) &&
      ['producer', 'publisher', 'human'].includes(input.kind) &&
      typeof input.config?.enabled === 'boolean',
    400,
    'invalid_principal',
  );
  if (input.kind === 'human')
    requireThat(
      !input.token &&
        typeof input.config.oidc_issuer === 'string' &&
        input.config.oidc_issuer.length > 0 &&
        typeof input.config.oidc_subject === 'string' &&
        input.config.oidc_subject.length > 0,
      400,
      'invalid_human',
    );
  if (input.token)
    requireThat(/^[A-Za-z0-9_-]{32,200}$/.test(input.token), 400, 'invalid_credential');
  if (input.config.webhook) {
    const url = new URL(input.config.webhook);
    requireThat(
      url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.hash &&
        service.config.webhookHosts.includes(url.hostname),
      400,
      'webhook_destination_rejected',
    );
  }
  if (input.config.email)
    requireThat(
      input.config.email_verified === true && /^[^\s<>@]+@[^\s<>@]+$/.test(input.config.email),
      400,
      'verified_email_required',
    );
  return service.store.transaction(p.tenant, async (tx, now) => {
    await service.principal(tx, p);
    const old = (
      await tx.query('SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2', [
        p.tenant,
        input.id,
      ])
    ).rows[0];
    requireThat(!old || old.kind === input.kind, 409, 'principal_kind_immutable');
    requireThat(
      !old ||
        input.kind !== 'human' ||
        (old.config.oidc_issuer === input.config.oidc_issuer &&
          old.config.oidc_subject === input.config.oidc_subject),
      409,
      'human_identity_immutable',
    );
    if (input.kind === 'producer') {
      const publisher = (
        await tx.query(
          "SELECT id FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='publisher'",
          [p.tenant, input.config.publisher ?? ''],
        )
      ).rows[0];
      requireThat(publisher && name(input.config.owner), 400, 'publisher_and_owner_required');
    }
    await tx.query(
      `INSERT INTO haip_principals(tenant,id,kind,token_hash,config) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(tenant,id) DO UPDATE SET config=EXCLUDED.config,token_hash=COALESCE(EXCLUDED.token_hash,haip_principals.token_hash)`,
      [
        p.tenant,
        input.id,
        input.kind,
        input.token ? digestBytes(input.token) : null,
        JSON.stringify(input.config),
      ],
    );
    if (old && input.kind === 'human' && old.config.enabled && !input.config.enabled) {
      const rows = (await tx.query('SELECT * FROM haip_requests WHERE tenant=$1', [p.tenant]))
        .rows as RequestRow[];
      for (const row of rows) {
        if (
          row.data.request.requester.subject !== input.id &&
          row.data.receipt?.payload.reviewer !== input.id &&
          row.data.candidate?.reviewer !== input.id &&
          row.data.review_claim?.reviewer !== input.id
        )
          continue;
        if (!row.data.receipt) delete row.data.candidate;
        if (row.data.review_claim?.reviewer === input.id) delete row.data.review_claim;
        if (
          row.data.receipt?.payload.reviewer === input.id ||
          row.data.request.requester.subject === input.id
        ) {
          row.data.invalidated =
            row.data.request.requester.subject === input.id
              ? 'requester_removed'
              : 'reviewer_removed';
          if (['pending_anchor', 'available'].includes(row.data.grant_state))
            row.data.grant_state = 'revoked';
        }
        await service.event(tx, p, row, now, 'reviewer_removed');
        await service.save(tx, row);
      }
    }
    if (
      old &&
      input.kind === 'producer' &&
      ((old.config.enabled && !input.config.enabled) ||
        old.config.owner !== input.config.owner ||
        old.config.publisher !== input.config.publisher ||
        digest(old.config.routes ?? []) !== digest(input.config.routes ?? []))
    ) {
      for (const row of (
        await tx.query('SELECT * FROM haip_requests WHERE tenant=$1 AND producer=$2', [
          p.tenant,
          input.id,
        ])
      ).rows as RequestRow[]) {
        if (
          input.config.enabled &&
          old.config.owner === input.config.owner &&
          old.config.publisher === input.config.publisher &&
          input.config.routes?.includes(row.route)
        )
          continue;
        row.data.invalidated = 'producer_authorisation_changed';
        if (!row.data.receipt) delete row.data.candidate;
        if (row.data.decision_state === 'pending') row.data.decision_state = 'cancelled';
        if (['pending_anchor', 'available'].includes(row.data.grant_state))
          row.data.grant_state = 'revoked';
        await service.event(tx, p, row, now, 'producer_authorisation_changed');
        await service.save(tx, row);
      }
    }
    await service.audit(tx, p, now, 'PrincipalConfigured', {
      id: input.id,
      kind: input.kind,
      enabled: input.config.enabled,
    });
    return { id: input.id, kind: input.kind };
  });
}
export async function registerRoute(
  service: ReviewService,
  p: Principal,
  id: string,
  input: RouteConfig,
) {
  requireThat(p.kind === 'operator', 403, 'operator_required');
  requireThat(
    name(id) &&
      Array.isArray(input.reviewers) &&
      input.reviewers.every(name) &&
      typeof input.separation_of_duties === 'boolean' &&
      Array.isArray(input.allowed_producers) &&
      input.allowed_producers.every(name) &&
      Array.isArray(input.modes) &&
      input.required_profiles,
    400,
    'invalid_route',
  );
  requireThat(
    service.config.mode !== 'production' || input.separation_of_duties,
    400,
    'separation_of_duties_required',
  );
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const [k, v] of Object.entries(limits))
    requireThat(
      Number.isSafeInteger(v) && v > 0 && v <= DEFAULT_LIMITS[k as keyof typeof DEFAULT_LIMITS],
      400,
      'invalid_route_limits',
    );
  const config = { ...input, limits };
  return service.store.transaction(p.tenant, async (tx, now) => {
    await service.principal(tx, p);
    const old = (
      await tx.query('SELECT * FROM haip_routes WHERE tenant=$1 AND id=$2', [p.tenant, id])
    ).rows[0];
    // Membership has targeted invalidation; authorising rule changes advance its own revision.
    const auth = (c: RouteConfig) =>
      digest({
        separation_of_duties: c.separation_of_duties,
        required_profiles: c.required_profiles,
        modes: c.modes,
        limits: c.limits,
      });
    const changed = old && auth(old.config) !== auth(config);
    const revision = old ? old.revision + (changed ? 1 : 0) : 1;
    await tx.query(
      'INSERT INTO haip_routes(tenant,id,revision,config) VALUES($1,$2,$3,$4) ON CONFLICT(tenant,id) DO UPDATE SET revision=EXCLUDED.revision,config=EXCLUDED.config',
      [p.tenant, id, revision, JSON.stringify(config)],
    );
    if (old) {
      for (const row of (
        await tx.query('SELECT * FROM haip_requests WHERE tenant=$1 AND route=$2', [p.tenant, id])
      ).rows as RequestRow[]) {
        const reviewer = row.data.receipt?.payload.reviewer;
        if (row.data.review_claim && !config.reviewers.includes(row.data.review_claim.reviewer))
          delete row.data.review_claim;
        const producerRemoved = !config.allowed_producers.includes(row.producer);
        if (changed || producerRemoved || (reviewer && !config.reviewers.includes(reviewer))) {
          row.data.invalidated = changed
            ? 'authorisation_changed'
            : producerRemoved
              ? 'producer_removed'
              : 'reviewer_removed';
          if (row.data.decision_state === 'pending') row.data.decision_state = 'cancelled';
          if (!row.data.receipt) delete row.data.candidate;
          if (['available', 'pending_anchor'].includes(row.data.grant_state))
            row.data.grant_state = 'revoked';
          await service.event(tx, p, row, now, row.data.invalidated);
          await service.save(tx, row);
        } else if (row.data.candidate && !config.reviewers.includes(row.data.candidate.reviewer)) {
          delete row.data.candidate;
        }
        await service.save(tx, row);
      }
    }
    await service.audit(tx, p, now, 'RouteConfigured', { id, revision, config });
    return { id, revision, config };
  });
}
function validBootstrapToken(token: string): boolean {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,200}$/.test(token)) return false;
  const hex = /^(?:[a-fA-F0-9]{2}){32,100}$/.test(token);
  const bytes = Buffer.from(token, hex ? 'hex' : 'base64url');
  if (bytes.length < 32 || (!hex && bytes.toString('base64url') !== token)) return false;
  // Reject obvious repeated-byte fixtures. Input validation cannot prove a random source;
  // operators must generate the token with a CSPRNG, never a password or repeated template.
  for (let period = 1; period <= 16; period++)
    if (bytes.every((byte, index) => byte === bytes[index % period])) return false;
  return true;
}

/** Local provisioning entry point. No HTTP bootstrap or default credentials exist. */
export async function bootstrapTenant(
  service: ReviewService,
  tenant: string,
  operator: string,
  token: string,
): Promise<void> {
  requireThat(
    name(tenant) && name(operator) && validBootstrapToken(token),
    400,
    'invalid_bootstrap',
  );
  await service.store.transaction(tenant, async (tx) => {
    await tx.query(
      'INSERT INTO haip_tenants(id,ledger_id,generation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [tenant, randomUUID(), randomUUID()],
    );
    await tx.query(
      "INSERT INTO haip_principals(tenant,id,kind,token_hash,config) VALUES($1,$2,'operator',$3,'{\"enabled\":true}') ON CONFLICT DO NOTHING",
      [tenant, operator, digestBytes(token)],
    );
  });
}
