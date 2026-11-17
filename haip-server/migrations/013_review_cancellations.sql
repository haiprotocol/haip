WITH first_cancellation AS (
  SELECT DISTINCT ON (tenant, request_id) tenant, request_id, created_at
  FROM haip_events
  WHERE record->'payload'->'state'->>'decision' IN ('cancelled', 'superseded')
  ORDER BY tenant, request_id, sequence
), recorded AS (
  SELECT r.tenant, r.id, LEAST(e.created_at, recovery.recovered_at) AS cancelled_at
  FROM haip_requests AS r
  LEFT JOIN first_cancellation AS e ON e.tenant=r.tenant AND e.request_id=r.id
  LEFT JOIN haip_recoveries AS recovery ON recovery.tenant=r.tenant
    AND recovery.old_generation::text=r.data->'request'->>'authority_namespace'
  WHERE r.data->>'decision_state' IN ('cancelled', 'superseded')
    AND NOT (r.data ? 'review_cancelled_at')
)
UPDATE haip_requests AS r SET data=jsonb_set(
  r.data, '{review_cancelled_at}',
  to_jsonb(to_char(recorded.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
FROM recorded
WHERE r.tenant=recorded.tenant AND r.id=recorded.id AND recorded.cancelled_at IS NOT NULL;
