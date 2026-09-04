# Deployment examples

These files are reviewed examples for the HAIP reference service. They do not install software, create a cloud resource, configure an account or establish production acceptance.

## Production shape

The service uses one active process for each execution namespace. Every restart requires offline recovery and fresh provisioning, so the runtime must not scale horizontally or restart automatically. The trusted listener uses loopback port 8080 and the sandbox listener uses loopback port 8081. PostgreSQL, signing, identity, storage, TLS and recovery remain explicit operator responsibilities.

Use Node 24, PostgreSQL 17 or a separately validated compatible version, encrypted disks and a restricted database role. Production PostgreSQL connections require verified TLS. Reserve migration permissions for the controlled upgrade procedure and keep environment files at mode 0600.

The uninstalled [`haip.service`](haip.service) example runs the built Node entry point with `Restart=no`. It assumes the service and its private configuration are already installed. It does not configure PostgreSQL, certificates, DNS, storage or monitoring.

## Storage

[`azure/main.bicep`](azure/main.bicep) defines an isolated Azure StorageV2 account with versioning, separate private checkpoint and safety containers, a default 90-day version-level policy for checkpoints, a 90-day container-level policy for safety records, a user-assigned runtime identity and a custom role scoped to both containers. Shared key access and public blob access are disabled. The storage firewall denies traffic unless the deployment supplies an allowed IPv4 CIDR or subnet.

The runtime role contains only blob add and read data actions, where read covers list and properties. It omits replacement, deletion, container administration and immutable-storage superuser actions. Azure permissions are additive, so acceptance must inspect every effective assignment and attempt each prohibited operation with the runtime identity.

`AzureAnchor` uses conditional add-only uploads without per-version policy or hold headers, then reads the exact returned version and checks the inherited Locked retention properties. `AzureSafetyStore` uses the separate safety container and also requires the inherited legal hold. This design keeps policy administration out of the runtime identity.

An independent administrator must lock the checkpoint container's default version-level policy and the safety container's container-level policy, then apply a container-level legal hold to the safety container before the runtime starts. The checkpoint container does not receive that legal hold. The same management action can clear a legal hold, so this remains an administrator step and is not part of the runtime role or Bicep deployment.

The template does not assign an administrator, lock either policy or apply the safety legal hold. Deploy it through the independently controlled storage administration path, review `what-if` output and record the exact template digest. Enabling version-level immutability changes the checkpoint container's capability. The template has not been deployed.

`AzureAnchor` is the implemented external storage adapter. R2 remains suitable for private encrypted backups with bounded deletion, but it does not replace the audit and safety store. No R2 uploader is included.

## Proxy

[`Caddyfile`](Caddyfile) routes the exact trusted host to port 8080 and a wildcard sandbox site to port 8081 while preserving the original Host header. It uses operator-supplied certificate and key files, adds the fixed browser isolation headers at the proxy boundary and supplies restrictive headers for proxy errors. HAIP still supplies the trusted host's request-specific frame policy.

Set `HAIP_TRUSTED_HOST` to a hostname without a scheme or path, and set `HAIP_SANDBOX_SITE` to the separate registrable site below the wildcard. Set `HAIP_TRUSTED_CERT_FILE`, `HAIP_TRUSTED_KEY_FILE`, `HAIP_SANDBOX_CERT_FILE` and `HAIP_SANDBOX_KEY_FILE` to private local paths. The sandbox certificate must cover `*.${HAIP_SANDBOX_SITE}`. The template does not request certificates or change DNS.

The trusted and sandbox sites must have different registrable domains. Configure wildcard DNS for the sandbox site, preserve Host through every proxy and keep both upstream listeners on loopback. Caddy must run under a restricted service account with access only to the certificate files it needs.

## Backups

Run encrypted backup creation and pruning through an approved scheduler at least daily. Keep the raw 32-byte encryption key separate from backup objects, remove backups within 30 days and alert on every failure. Restoration targets must be empty, isolated and inaccessible to listeners and executors. The existing backup CLI writes an authenticated `.haipbak` file and does not upload it.

## Monitoring

Prometheus needs an operator credential for each tenant's `/v2/admin/metrics.prom` endpoint. Keep scrape configuration private. [`alerts.yml`](alerts.yml) contains example rules without credentials, identities or request content. Install real routing separately and test delivery before recording the operations check as passed.

## Development

The root `Dockerfile` and [`compose.dev.yml`](compose.dev.yml) package a local development service. They do not supply production TLS, independent anchoring or recovery acceptance. Compose publishes only loopback ports and does not publish PostgreSQL. See [`development.md`](development.md) for its private settings.

Use free services where their actual limits and safety properties fit. [`PROVIDERS.md`](../PROVIDERS.md) records the owner preferences. Provider terms, quotas and costs must be checked again before any deployment.
