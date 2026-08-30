# Development container

The root `Dockerfile` and `deployment/compose.dev.yml` package the current HAIP 2
reference service. They are development examples, not a production image release.
No registry push, cloud account or paid service is required. Archived HAIP 1
containers do not run HAIP 2.

The image uses pinned official Node 24 and PostgreSQL 17 bases. The service runs
without root, with a read-only filesystem and restricted capabilities. Compose
publishes only loopback ports 8080/8081; PostgreSQL has no published port. The build
context excludes local settings, private keys, archives and research. Use disposable
data and development identities only.

Create an explicit private environment file outside tracked source, containing:

| Variable                                                 | Required value                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `HAIP_DEV_POSTGRES_PASSWORD`                             | A generated development database password; no default exists                                 |
| `HAIP_DEV_SIGNING_KEY_FILE`                              | Absolute path to a development Ed25519 private PEM                                           |
| `HAIP_DEV_SIGNING_KEY_ID`                                | Active key ID in the manifest                                                                |
| `HAIP_DEV_TRUST_MANIFEST_FILE`                           | Absolute path to a matching public trust manifest, issuer `http://localhost:8080` by default |
| `HAIP_DEV_OIDC_ISSUER`                                   | Exact development issuer reachable by both the browser and the container                     |
| `HAIP_DEV_OIDC_CLIENT_ID`, `HAIP_DEV_OIDC_CLIENT_SECRET` | Explicit registered development client credentials                                           |

Register the callback as `http://localhost:8080/auth/callback`, adjusting it and
the trust issuer if setting `HAIP_DEV_PORT`. `HAIP_DEV_SANDBOX_PORT` changes the
separate sandbox listener. Optional `HAIP_DEV_OIDC_DISCOVERY` and
`HAIP_DEV_OIDC_CLIENT_AUTH` follow the normal runtime settings.
`HAIP_DEV_OIDC_LOCAL_HTTP=true` is only for an isolated HTTP identity fixture.
Container loopback refers to that container; a host-only OIDC server is not made
reachable by merely using `localhost` in this Compose file. No identity provider
is provisioned by Compose.

The two individual key/manifest mounts must be readable by the image's UID 1000.
Keep their parent directory private on the host and never mount a whole credential
directory. The manifest contains public keys only; see [operations](../OPERATIONS.md)
for trust and key handling.

From the repository root, with your explicit private settings file:

```sh
docker compose --env-file /absolute/path/to/development.env -f deployment/compose.dev.yml config --quiet
docker compose --env-file /absolute/path/to/development.env -f deployment/compose.dev.yml up --build -d postgres
```

For a new database, temporarily supply `HAIP_BOOTSTRAP_TENANT`,
`HAIP_BOOTSTRAP_OPERATOR` and a fresh `HAIP_BOOTSTRAP_TOKEN` in the current process
environment through your private configuration. Pass their names, not secret values,
to the one-off bootstrap process:

```sh
docker compose --env-file /absolute/path/to/development.env -f deployment/compose.dev.yml run --build --rm -e HAIP_BOOTSTRAP_TENANT -e HAIP_BOOTSTRAP_OPERATOR -e HAIP_BOOTSTRAP_TOKEN haip node haip-server/dist/main.js --bootstrap
docker compose --env-file /absolute/path/to/development.env -f deployment/compose.dev.yml up --build -d haip
```

Remove bootstrap variables from ordinary process configuration. Provision directory
entries, publishers, producers and routes through the operator API. Open
`http://localhost:8080/inbox` only after mapping the development OIDC identities.
Stopping Compose without deleting volumes retains its development database.

This configuration deliberately has no anchor. Reviews can be confirmed, audit
checkpoints remain pending and execution admission stays fenced. It does not
configure production identity, DNS/TLS, immutable storage, alerting or recovery.
The production gates in [acceptance](acceptance.md) remain outstanding.

Linux CI builds this image and runs `scripts/smoke-container.ts` with disposable
PostgreSQL and the existing local identity fixture. The smoke validates Compose
configuration; its runtime test uses Linux host networking with loopback listeners,
not the Compose network. Evidence distinguishes those checks and does not claim
production deployment or hosted documentation rendering.
