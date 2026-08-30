-- Additive upgrade: signed objects and their captured deadlines remain byte-for-byte unchanged.
CREATE TABLE IF NOT EXISTS haip_incidents (
  id bigserial PRIMARY KEY, tenant text NOT NULL, code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), details jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS haip_operations (
  name text PRIMARY KEY, succeeded_at timestamptz, failed_at timestamptz
);
ALTER TABLE haip_events ADD COLUMN IF NOT EXISTS sequence bigserial;
CREATE UNIQUE INDEX IF NOT EXISTS haip_events_sequence ON haip_events(sequence);
CREATE INDEX IF NOT EXISTS haip_events_cursor ON haip_events(tenant,producer,sequence);
CREATE TABLE IF NOT EXISTS haip_recoveries (
  tenant text NOT NULL, old_generation uuid NOT NULL, new_generation uuid NOT NULL,
  recovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  history_state text NOT NULL, PRIMARY KEY(tenant,old_generation)
);
