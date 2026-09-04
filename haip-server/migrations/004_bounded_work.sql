-- Additive operational controls. Existing signed material and grant clocks are unchanged.
CREATE TABLE haip_tenant_operations (
  tenant text NOT NULL REFERENCES haip_tenants(id), name text NOT NULL,
  succeeded_at timestamptz, failed_at timestamptz, PRIMARY KEY(tenant,name)
);
-- Legacy global stamps cannot be attributed to a tenant and are deliberately not copied.
CREATE TABLE haip_bundle_windows (
  tenant text NOT NULL REFERENCES haip_tenants(id), day date NOT NULL,
  scope text NOT NULL CHECK (scope IN ('tenant','publisher')),
  subject text NOT NULL, count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY(tenant,day,scope,subject)
);
INSERT INTO haip_bundle_windows(tenant,day,scope,subject,count)
SELECT tenant,(created_at AT TIME ZONE 'UTC')::date,'tenant','',count(*)
FROM haip_bundles WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
GROUP BY tenant,(created_at AT TIME ZONE 'UTC')::date;
INSERT INTO haip_bundle_windows(tenant,day,scope,subject,count)
SELECT tenant,(created_at AT TIME ZONE 'UTC')::date,'publisher',publisher,count(*)
FROM haip_bundles WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
GROUP BY tenant,(created_at AT TIME ZONE 'UTC')::date,publisher;
CREATE INDEX haip_bundles_owner ON haip_bundles(tenant,publisher) INCLUDE(retained_bytes);
CREATE INDEX haip_requests_page ON haip_requests(tenant,created_at DESC,id);
CREATE INDEX haip_requests_pending ON haip_requests(tenant,(data->'request'->>'review_deadline'),producer)
WHERE data->>'decision_state'='pending';
CREATE INDEX haip_requests_pending_anchor ON haip_requests(tenant,((data->>'decision_sequence')::bigint),id)
WHERE data->>'audit_state'='pending';
-- ISO UTC deadlines sort lexically. Generated values keep all mutation paths in sync,
-- including revocation and offline recovery, without rewriting captured deadlines.
ALTER TABLE haip_requests ADD COLUMN maintenance_at text GENERATED ALWAYS AS (LEAST(
  CASE WHEN data->>'decision_state'='pending' THEN data->'request'->>'review_deadline' END,
  CASE WHEN data->>'grant_state' IN ('available','pending_anchor') THEN data->>'grant_deadline' END,
  CASE WHEN data->>'material_deleted' IS DISTINCT FROM 'true'
    THEN LEAST(data->'request'->>'private_delete_at',data->>'private_discard_at') END,
  data->'request'->>'audit_delete_at'
)) STORED;
CREATE INDEX haip_requests_maintenance ON haip_requests(tenant,maintenance_at,id);
CREATE INDEX haip_outbox_deliverable ON haip_outbox(tenant,created_at,id,next_at)
WHERE state='pending' AND kind IN ('smtp','webhook');
