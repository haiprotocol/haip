CREATE TABLE haip_creation_windows (
  tenant text NOT NULL REFERENCES haip_tenants(id), day date NOT NULL,
  scope text NOT NULL CHECK (scope IN ('tenant','producer','route')),
  subject text NOT NULL, count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY(tenant,day,scope,subject)
);
-- Earlier drafts counted retained requests. Deleted rows cannot be reconstructed,
-- so upgrades conservatively exhaust today's tenant quota; existing review continues.
INSERT INTO haip_creation_windows(tenant,day,scope,subject,count)
SELECT id,(clock_timestamp() AT TIME ZONE 'UTC')::date,'tenant','',1000 FROM haip_tenants;
