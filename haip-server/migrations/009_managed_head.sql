CREATE TABLE haip_managed_head (
  singleton boolean PRIMARY KEY CHECK (singleton),
  binding text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  nonce uuid NOT NULL
);
