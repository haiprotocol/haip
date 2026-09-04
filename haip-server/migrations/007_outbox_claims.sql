-- Persisted claims keep slow delivery outside the tenant transaction while fencing stale workers.
ALTER TABLE haip_outbox ADD COLUMN claim_generation integer NOT NULL DEFAULT 0;
ALTER TABLE haip_outbox ADD COLUMN claim_until timestamptz;
ALTER TABLE haip_outbox ADD COLUMN claim_revision text;
ALTER TABLE haip_outbox ADD CONSTRAINT haip_outbox_claim_pair CHECK ((claim_until IS NULL)=(claim_revision IS NULL));
DROP INDEX IF EXISTS haip_outbox_deliverable;
DROP INDEX IF EXISTS haip_outbox_ready;
DROP INDEX IF EXISTS haip_outbox_ready_delivery;
CREATE INDEX haip_outbox_ready ON haip_outbox(tenant,(GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz))),created_at,id) WHERE state='pending';
CREATE INDEX haip_outbox_ready_delivery ON haip_outbox(tenant,(GREATEST(next_at,COALESCE(claim_until,'-infinity'::timestamptz))),created_at,id) WHERE state='pending' AND kind IN ('smtp','webhook');
