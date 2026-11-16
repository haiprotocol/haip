-- Older drafts could keep a summary in mail queued after a request was discarded.
UPDATE haip_outbox AS mail
SET body='{}', destination=NULL, accepted=NULL, claim_until=NULL, claim_revision=NULL,
    state=CASE WHEN mail.state='pending' THEN 'expired' ELSE mail.state END
FROM haip_requests AS review
WHERE mail.tenant=review.tenant AND mail.request_id=review.id AND mail.kind='smtp'
  AND review.data->'material_deleted'='true'::jsonb;
