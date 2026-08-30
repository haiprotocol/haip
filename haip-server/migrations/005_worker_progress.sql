-- Readiness and collection indexes only: captured timestamps and signed records are unchanged.
CREATE INDEX haip_outbox_ready ON haip_outbox(tenant,next_at,created_at,id)
WHERE state='pending';
CREATE INDEX haip_outbox_ready_delivery ON haip_outbox(tenant,next_at,created_at,id)
WHERE state='pending' AND kind IN ('smtp','webhook');
CREATE INDEX haip_sessions_expiry ON haip_sessions(expires_at,token_hash);
CREATE INDEX haip_bundles_retention ON haip_bundles(tenant,created_at,id)
WHERE html IS NOT NULL;
CREATE INDEX haip_requests_retained_bundle ON haip_requests(tenant,(data->'request'->'review'->'bundle'->>'id'))
WHERE material IS NOT NULL;
CREATE INDEX haip_audit_retention ON haip_audit(tenant,created_at,sequence)
WHERE record IS NOT NULL;
CREATE INDEX haip_outbox_retention ON haip_outbox(tenant,created_at,id);
CREATE INDEX haip_idempotency_retention ON haip_idempotency(tenant,created_at)
WHERE result IS NOT NULL;
CREATE INDEX haip_notification_retention ON haip_notification_windows(tenant,hour);
CREATE INDEX haip_incidents_code ON haip_incidents(tenant,code);
