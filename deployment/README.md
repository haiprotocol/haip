# Deployment examples

These files are reviewed examples for the HAIP reference service. They do not install software, create a cloud resource, configure an account or establish production acceptance.

## Local use

Run the [local demonstration](../README.md#reference-service) for the API, reviewer sign-in, isolated Agent UI and signed receipts. `npm run check` also exercises local SMTP and HTTPS delivery and the built backup and recovery commands against PostgreSQL with verified TLS. The restart test uses disposable data and keeps signed checkpoint and safety records in a local fixture outside the database backup.

## Managed hosting

Use the [Vercel and Neon plan](vercel-neon.md) if HAIP needs a shared hosted service. The plan records the compatibility decisions, cost controls and remaining acceptance work. The systemd and Caddy examples below apply to the current standalone runtime.

## Production shape

The service uses one active process for each execution namespace. Every restart requires offline recovery and fresh provisioning, so the runtime must not scale horizontally or restart automatically. The trusted listener uses loopback port 8080 and the sandbox listener uses loopback port 8081. PostgreSQL, signing, identity, storage, TLS and recovery remain explicit operator responsibilities.

Use Node 24, PostgreSQL 17 or a separately validated compatible version, encrypted disks and a restricted database role. Production PostgreSQL connections require verified TLS. Reserve migration permissions for the controlled upgrade procedure and keep environment files at mode 0600.

With `HAIP_MODE=production`, run `node haip-server/dist/main.js --migrate` using a direct database connection and the migration role. This command only needs database configuration. Run bootstrap and recovery offline with a direct connection and the required administrative grants. Start the service with the restricted runtime role. These commands check the migration hashes and refuse missing or newer schema versions. The development runner applies migrations to its disposable database.

The uninstalled [`haip.service`](haip.service) example runs the built Node entry point with `Restart=no`. It assumes the service and its private configuration are already installed. It does not configure PostgreSQL, certificates, DNS, storage or monitoring.

## Storage

[`azure/main.bicep`](azure/main.bicep) defines an isolated Azure StorageV2 account with versioning, separate private checkpoint and safety containers, a default version-level policy for checkpoints, a container-level policy for safety records, a user-assigned runtime identity and a custom role scoped to both containers. Both policies use 91 days to leave room for Azure's whole-second expiry timestamps while meeting the exact 90-day minimum. Shared key access and public blob access are disabled. The storage firewall denies traffic unless the deployment supplies an allowed IPv4 CIDR or subnet.

The runtime role contains only blob add and read data actions, where read covers list and properties. It omits replacement, deletion, container administration and immutable-storage superuser actions. Azure permissions are additive, so acceptance must inspect every effective assignment and attempt each prohibited operation with the runtime identity.

`AzureAnchor` uses conditional add-only uploads without per-version policy or hold headers, then reads the exact returned version and checks the inherited Locked retention properties. `AzureSafetyStore` uses the separate safety container and also requires the inherited legal hold. This design keeps policy administration out of the runtime identity.

An independent administrator must lock the checkpoint container's default version-level policy and the safety container's container-level policy, then apply a container-level legal hold to the safety container before the runtime starts. The checkpoint container does not receive that legal hold. The same management action can clear a legal hold, so this remains an administrator step and is not part of the runtime role or Bicep deployment.

The template does not assign an administrator, lock either policy or apply the safety legal hold. Deploy it through the independently controlled storage administration path, review `what-if` output and record the exact template digest. Enabling version-level immutability changes the checkpoint container's capability. The template has not been deployed.

`AzureAnchor` is the implemented external storage adapter. R2 remains suitable for private encrypted backups with bounded deletion, but it does not replace the audit and safety store. No R2 uploader is included.

## Proxy

The Caddy example routes the trusted host to port 8080 and wildcard sandbox hosts to port 8081. It preserves the original Host header, including an explicit port, and rejects unknown HTTPS hosts with 421. HAIP supplies the CSP for application responses. Caddy adds the fixed browser isolation headers and denies framing on errors it generates. [Caddyfile](Caddyfile)

Use bare hostnames for `HAIP_TRUSTED_HOST` and `HAIP_SANDBOX_SITE`. For a non-default HTTPS port, set `HAIP_PROXY_HTTPS_PORT` and include the public port in the HAIP origin and sandbox pattern. Set `HAIP_TRUSTED_CERT_FILE`, `HAIP_TRUSTED_KEY_FILE`, `HAIP_SANDBOX_CERT_FILE` and `HAIP_SANDBOX_KEY_FILE` to private local paths. The sandbox certificate must cover `*.${HAIP_SANDBOX_SITE}`. The template does not request certificates or change DNS.

The trusted and sandbox sites must have different registrable domains. Configure wildcard DNS for the sandbox site, preserve Host through every proxy and keep both upstream listeners on loopback. Caddy must run under a restricted service account with access only to the certificate files it needs.

After building the project and installing its Chromium, run the local acceptance test with Caddy in `PATH`. It starts two loopback upstreams and uses temporary certificates for reserved `.test` sites. It also stops both upstreams and checks the proxy's error responses.

```sh
HAIP_TEST_CADDY=caddy node --import tsx --test tests/origins-tls-adapter.test.ts
```

## Backups

Run encrypted backup creation and pruning through an approved scheduler at least daily. Keep the raw 32-byte encryption key separate from backup objects, remove backups within 30 days and alert on every failure. Restoration targets must be empty, isolated and inaccessible to listeners and executors. The existing backup CLI writes an authenticated `.haipbak` file and does not upload it.

## Monitoring

Prometheus needs an operator credential for each tenant's `/v2/admin/metrics.prom` endpoint. Use `haip` or an `haip-` prefix for each scrape job so the scrape outage rule can identify its targets. Keep credentials in private files and use `authorization.credentials_file` in the scrape configuration. Install the deployment's alert routing and test receipt before recording the operations check as passed. [Alert rules](alerts.yml)

With `promtool`, `prometheus` and `alertmanager` in `PATH`, run the rule tests and the loopback delivery rehearsal. The rehearsal sends alerts to a disposable receiver and verifies that worker alerts resolve after the workers complete successful cycles.

```sh
promtool test rules deployment/alerts.test.yml
node --import tsx --test tests/alerts.integration.ts
```

## Development

The root `Dockerfile` and [`compose.dev.yml`](compose.dev.yml) package a local development service. They do not supply production TLS, independent anchoring or recovery acceptance. Compose publishes only loopback ports and does not publish PostgreSQL. See [`development.md`](development.md) for its private settings.

Use free services where their actual limits and safety properties fit. [`PROVIDERS.md`](../PROVIDERS.md) records the owner preferences. Provider terms, quotas and costs must be checked again before any deployment.
