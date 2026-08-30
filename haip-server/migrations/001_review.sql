CREATE TABLE IF NOT EXISTS haip_tenants (
  id text PRIMARY KEY, ledger_id uuid NOT NULL UNIQUE, generation uuid NOT NULL UNIQUE,
  fenced boolean NOT NULL DEFAULT true, audit_sequence bigint NOT NULL DEFAULT 0,
  audit_head text NOT NULL DEFAULT '', config jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS haip_principals (
  tenant text NOT NULL REFERENCES haip_tenants(id), id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('producer','publisher','operator','human')),
  token_hash text UNIQUE, config jsonb NOT NULL, PRIMARY KEY (tenant,id)
);
CREATE TABLE IF NOT EXISTS haip_routes (
  tenant text NOT NULL REFERENCES haip_tenants(id), id text NOT NULL,
  revision integer NOT NULL CHECK (revision>0), config jsonb NOT NULL,
  PRIMARY KEY (tenant,id)
);
CREATE TABLE IF NOT EXISTS haip_bundles (
  tenant text NOT NULL, id uuid NOT NULL, publisher text NOT NULL,
  manifest jsonb NOT NULL, html text, retained_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant,id),
  FOREIGN KEY(tenant,publisher) REFERENCES haip_principals(tenant,id)
);
CREATE TABLE IF NOT EXISTS haip_requests (
  tenant text NOT NULL, id uuid NOT NULL, producer text NOT NULL, route text NOT NULL,
  data jsonb NOT NULL, material jsonb, retained_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant,id),
  FOREIGN KEY(tenant,producer) REFERENCES haip_principals(tenant,id),
  FOREIGN KEY(tenant,route) REFERENCES haip_routes(tenant,id)
);
CREATE INDEX IF NOT EXISTS haip_requests_owner ON haip_requests(tenant,producer,created_at);
CREATE INDEX IF NOT EXISTS haip_requests_route ON haip_requests(tenant,route,created_at);
CREATE TABLE IF NOT EXISTS haip_occurrences (
  tenant text NOT NULL, producer text NOT NULL, occurrence text NOT NULL,
  request_id uuid NOT NULL, execution_identity text, consumed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(tenant,producer,occurrence), UNIQUE(tenant,producer,execution_identity)
);
CREATE TABLE IF NOT EXISTS haip_idempotency (
  tenant text NOT NULL, actor text NOT NULL, operation text NOT NULL, key text NOT NULL,
  digest text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,actor,operation,key)
);
CREATE TABLE IF NOT EXISTS haip_audit (
  tenant text NOT NULL, sequence bigint NOT NULL, request_id uuid,
  previous_head text NOT NULL, head text NOT NULL, record_digest text NOT NULL, record text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant,sequence)
);
CREATE TABLE IF NOT EXISTS haip_outbox (
  id uuid PRIMARY KEY, tenant text NOT NULL, producer text, request_id uuid,
  kind text NOT NULL CHECK(kind IN ('webhook','smtp','checkpoint')), destination text,
  body jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), accepted jsonb, error text
);
CREATE INDEX IF NOT EXISTS haip_outbox_pending ON haip_outbox(state,next_at);
CREATE TABLE IF NOT EXISTS haip_events (
  tenant text NOT NULL, producer text NOT NULL, id uuid NOT NULL,
  request_id uuid NOT NULL, record jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(tenant,id)
);
CREATE TABLE IF NOT EXISTS haip_sessions (
  token_hash text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS haip_notification_windows (
  tenant text NOT NULL, recipient text NOT NULL, hour timestamptz NOT NULL,
  count integer NOT NULL, PRIMARY KEY(tenant,recipient,hour)
);
