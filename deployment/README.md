# Deployment configuration examples

These files are not installed or deployed. Configure and validate isolated infrastructure
before production. The service uses one active process per execution namespace; restart
requires offline recovery and fresh provisioning. See `OPERATIONS.md`.

Expose loopback port 8080 through TLS on the exact trusted origin. Route a separate
wildcard sandbox domain to loopback port 8081, preserving Host. Never add cookies or
shared storage to sandbox origins. Do not expose the local OIDC fixture outside tests.
Use an encrypted PostgreSQL connection and a restricted runtime role; reserve migration
permissions for the controlled upgrade procedure. Keep environment files mode 0600.

Prometheus must use an operator credential for each tenant's `/v2/admin/metrics.prom`.
Keep its scrape configuration private. The example alerts do not contain credentials,
reviewer identities or request contents. Choose actual notification routing separately.

Run encrypted backup creation and pruning through an approved scheduler, pruning at
least daily. Keep encryption keys separate, remove backups by 30 days and alert on
failures. Restoration targets must be empty and isolated from listeners and executors.

Use free tiers first and no Amazon services; see `PROVIDERS.md` for the owner’s
preferences and verified provider constraints. R2 is a candidate for encrypted backups,
not a substitute for irreversible audit retention. No cloud account is configured here.

The optional production backend uses Azure Blob Storage with versioning and version-level
immutable storage enabled. Checkpoints require a Locked policy covering at least 90 days;
safety records additionally require indefinite legal holds. The runtime uses conditional
creation and reads the exact version, rejecting additional or deleted versions. Retention
headers are rounded up to whole seconds so they never shorten the signed deadline.

Use a separate administrator and a custom least-privilege runtime identity. Permit object
creation and exact-version/property/list reads. Deny deletion, policy administration,
retention reduction and legal-hold removal. Do not expire the safety prefix. Test the
actual allowed/denied operations in an isolated account before accepting the deployment.
A local adapter fixture cannot prove Azure RBAC, retention or administrator independence.

[Azure immutable storage documentation](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview)
explains locked retention and legal holds. Nothing here provisions resources or approves
a paid service.
