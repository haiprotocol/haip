CREATE TABLE haip_request_admission (
  bucket text NOT NULL,
  key_digest text NOT NULL,
  hits integer NOT NULL CHECK (hits >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (bucket,key_digest)
);
CREATE INDEX haip_request_admission_expiry ON haip_request_admission (expires_at,bucket,key_digest);
