BEGIN;

DO $roles$
BEGIN
  IF current_database() IN ('postgres', 'neondb', 'template0', 'template1') THEN
    RAISE EXCEPTION 'Use a dedicated HAIP database';
  END IF;

  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('haip_runtime', 'haip_backup')) <> 2 THEN
    RAISE EXCEPTION 'Create the dedicated HAIP login roles first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('haip_runtime', 'haip_backup') AND (
      NOT r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
      OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
      OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid)
      OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'public' AND n.nspowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = r.oid)
    )
  ) THEN
    RAISE EXCEPTION 'HAIP login roles must not own schema objects or have administrative roles';
  END IF;
END
$roles$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO haip_runtime, haip_backup;

GRANT SELECT ON haip_migrations, haip_managed_head, haip_tenants TO haip_runtime;
GRANT UPDATE (sequence, nonce) ON haip_managed_head TO haip_runtime;
GRANT UPDATE (fenced, audit_sequence, audit_head, config) ON haip_tenants TO haip_runtime;
GRANT SELECT, INSERT ON haip_incidents TO haip_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  haip_audit, haip_bundle_windows, haip_bundles, haip_creation_windows, haip_events,
  haip_idempotency, haip_notification_windows, haip_occurrences, haip_outbox,
  haip_principals, haip_request_admission, haip_requests, haip_routes,
  haip_sessions, haip_tenant_operations
  TO haip_runtime;
GRANT USAGE ON haip_events_sequence_seq, haip_incidents_id_seq TO haip_runtime;

GRANT SELECT ON
  haip_audit, haip_bundle_windows, haip_bundles, haip_creation_windows, haip_events,
  haip_idempotency, haip_incidents, haip_managed_head, haip_migrations,
  haip_notification_windows, haip_occurrences, haip_operations, haip_outbox,
  haip_principals, haip_recoveries, haip_request_admission, haip_requests,
  haip_routes, haip_sessions, haip_tenant_operations, haip_tenants
  TO haip_backup;
GRANT SELECT ON haip_events_sequence_seq, haip_incidents_id_seq TO haip_backup;

COMMIT;
