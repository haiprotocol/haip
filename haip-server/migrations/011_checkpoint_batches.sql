ALTER TABLE haip_outbox ADD COLUMN checkpoint_batch_count smallint;
ALTER TABLE haip_outbox ADD CONSTRAINT haip_outbox_open_checkpoint CHECK (
  checkpoint_batch_count IS NULL OR (
    kind='checkpoint' AND state='pending' AND attempts=0 AND request_id IS NULL
    AND checkpoint_batch_count BETWEEN 1 AND 99
  )
);
CREATE UNIQUE INDEX haip_outbox_one_open_checkpoint ON haip_outbox(tenant)
  WHERE checkpoint_batch_count IS NOT NULL;
