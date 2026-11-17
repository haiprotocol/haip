# Acceptance adapters

## Origins and TLS

`origins-tls.mjs` performs GET requests against the exact trusted origin and two scope labels from the acceptance plan. It converts each 64-character hexadecimal scope to the reference service's base-36 DNS label. It resolves each hostname, pins the returned address set for that request, checks the TLS chain and hostname, records certificate digests and refuses redirects. It checks production isolation, CSP, connection allowlist, permissions and HSTS headers on sandbox success and error responses. It also checks that an unexpected trusted Host and a sandbox Host that disagrees with the path are refused.

Use the same private plan file supplied to the acceptance runner. Configure `origins_tls.command` as the following argument array, with your own paths, and remove that check's `unrun_reason`.

```json
[
  "node",
  "deployment/adapters/origins-tls.mjs",
  "/private/haip-acceptance/plan.json",
  "/private/haip-acceptance/evidence"
]
```

The evidence directory must be outside the repository with mode 0700. Each evidence file is created once with mode 0600. The adapter emits a digest and an opaque file reference. Raw bodies, cookies and credential values are omitted. The evidence file records the plan digest, source commit, DNS addresses, TLS details, selected security headers, response status, body size and body digest. A SHA-256 digest identifies retained bytes but does not authenticate their author.

An existing reviewer session may be supplied as `HAIP_ACCEPTANCE_REVIEW_COOKIE`, containing exactly `__Host-haip=` followed by its opaque value. Declare that variable in both `adapter_env` and `secret_env` in the plan. The adapter sends it only to `/auth/session` on the trusted origin. It does not start a login, follow a callback, assign a review, submit a proposal or confirm a decision. GET requests may still create ordinary access logs and consume rate limits.

## Browser check

Run the browser check on an isolated tenant with a test producer, publisher and reviewer. Build and register the choice View from the [HTTP walkthrough](../../examples/http/README.md). Copy `examples/http/review.json`, set `bundle_id` to that registration, set `profiles.haip.agent-ui` to `2` as a string and set `metadata.haip_acceptance_fixture` to `origins_tls`. Create the request with the test producer and use its UUID for `--review-id`. Each run needs a fresh request.

```sh
node deployment/adapters/origins-tls.mjs /private/haip-acceptance/plan.json /private/haip-acceptance/evidence --review-id REVIEW_UUID
```

Use those arguments in `origins_tls.command` and allow at least 210 seconds for the runner check. Install the project's Chromium with `npx playwright install chromium`. Run from a desktop session and allow the display variables in `adapter_env` if the system needs them. Sign in manually in the browser that opens. Its profile is disposable and the report records only probe results, browser version and a digest of the request ID.

The adapter observes the actual OIDC callback and checks that the browser keeps the session on the trusted host. A sibling page attempts to frame the authenticated review. A second window at the expected sandbox origin sends a proposal, then the authorised View proposes the same choice as a control. The candidate remains pending for human confirmation. The adapter also checks renderer fetch refusal and observes Chromium's enforced WebRTC denial on the sandbox wrapper.

## Coverage

Header probes alone return `blocked` after successful checks. A live run with a disposable review can return `passed` when the TLS, routing, session and browser checks pass. A failed probe returns `failed` with the affected assertion. The other acceptance checks record the provider, identity and recovery evidence separately.

The trusted health probe requires the current runtime headers. An unexpected trusted Host must receive 403, 404 or 421 without a redirect. A front-end proxy that closes the connection instead remains a failed probe requiring review. The sandbox probes require the current reference service policy, including its empty connection allowlist and absent network reporting destinations.

## Identity

Use an isolated tenant with a test requester and a distinct reviewer who each have a mapped provider account. Add both to a disposable route with separation of duties enabled. Create a pending review from `examples/http/review.json` with a producer owned by the test requester, and set `metadata.haip_acceptance_fixture` to `external_identity`. The adapter checks the marker, owner and empty candidate slot before attempting a requester proposal. Use a fresh review for each run.

Prepare a private JSON settings file containing `issuer`, `client_id`, `client_auth`, `review_id`, `reviewer` and `requester`. The issuer must be the exact HTTPS issuer. Set `client_auth` to `client_secret_basic` or `client_secret_post` and use HAIP directory principal IDs for the two people. If the service uses OAuth discovery, set `discovery` to `oauth2`. With a disposable third account outside the directory, set `unmapped_account` to `true` to exercise its refusal.

```sh
node deployment/adapters/external-identity.mjs /private/haip-acceptance/plan.json /private/haip-acceptance/evidence /private/haip-acceptance/identity.json
```

Use those arguments in `external_identity.command` and set `timeout_ms` to `900000`. Install Chromium with `npx playwright install chromium` and use a desktop session. Include any required display variables in the plan's `adapter_env`. The adapter opens a new tab for each attempt. Use the reviewer account twice, the requester once and the reviewer for each of the three altered requests. Use the unmapped account if configured, then sign in as the reviewer once more. Each attempt allows 100 seconds. Running the adapter directly displays the prompts in the terminal.

For a passing live result, retain a redacted observation of the configured authentication method at the token endpoint. In the settings file, add a `provider_observation` object containing `source_commit`, `service_artifact_digest`, `configuration_revision`, `identity_revision`, `issuer`, `client_id`, `client_auth`, `digest`, `reference` and `recorded_at`. Copy the identity component's revision from the plan. The digest covers the retained observation, the reference starts with `private-evidence:`, and the timestamp is in UTC. The adapter checks those bindings and the evidence reference. A successful browser run with the token endpoint observation pending reports `blocked`. The files record probe results and digests. Keep credentials, cookies, callback URLs and token contents out of those files and the retained observation.

## Azure storage

Build the exact checkout with `npm run build`. Use the isolated Azure account and containers configured for the acceptance run. The account in the plan's `anchor` component uses provider `Azure Blob Storage` and the actual Azure region. The adapter selects the reviewed subscription in a scoped Azure CLI Reader session and reads signed blobs through the configured HAIP runtime identity. Both credential paths use TLS and the storage endpoints selected from the account name.

Configure `immutable_storage.command` with these arguments, replacing the paths and removing its `unrun_reason`. Allow 90 seconds for the check.

```sh
node deployment/adapters/azure-immutable-storage.mjs /private/haip-acceptance/plan.json /private/haip-acceptance/evidence /private/haip-acceptance/storage.json
```

In `storage.json`, set `plan_digest` to `sha256:` followed by the SHA-256 of the final plan file bytes. Set `account`, `resource_group`, `subscription_id`, `tenant_id`, `runtime_client_id` and `anchor_prefix` from the deployment. Use `x-ms-version-id` as returned by Azure, preserving its fractional seconds. Set `trust_manifest` to the deployed public manifest JSON object for the plan's trusted origin.

Provide `checkpoint` and `safety` objects, each with `container`, `key`, `version_id` and `digest`. For the checkpoint, confirm a disposable review, wait for its authenticated status to report `anchored`, then take `key`, `version_id` and `digest` from `anchor.acceptance`. For safety, use the signed `RecoveryFence` produced by the same deployment's disposable exercise. Record its exact key and Azure version ID and calculate `sha256:` followed by the SHA-256 of that version's original bytes. The adapter verifies both signatures and checks that each signed record belongs at the supplied key.

Set `runtime_credential` to `managed_identity` when the configured user-assigned identity is available on the machine running the adapter. If the deployment uses a service principal and client secret, set `runtime_credential` to `client_secret`. Supply the existing runtime credential as `HAIP_ACCEPTANCE_AZURE_RUNTIME_CLIENT_SECRET`, listed in both `adapter_env` and `secret_env`. Include `AZURE_CONFIG_DIR` in `adapter_env` when using a separate Azure CLI session directory. For a hosted managed identity, include the required identity endpoint environment names and declare any endpoint credentials as secrets.

The adapter issues management GET requests and blob lists, properties and pinned reads. It requires versioning, the two locked policies, the safety legal hold and at least 90 days of locked retention from each signed issue time. An enabled lifecycle deletion rule with no prefix, or with any prefix that can match the safety container, fails the check. Review the resulting private file and its digest alongside the writer permissions and independent administration evidence. The file records the plan and settings digests, policy ETag digests when returned, exact version digests and retention times. [Azure policy API](https://learn.microsoft.com/en-us/rest/api/storagerp/blob-containers/get-immutability-policy?view=rest-storagerp-2025-08-01) [Azure lifecycle scope](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-faq)

## Azure writer

Configure `writer_permissions.command` on the approved isolated deployment with these arguments. Allow 240 seconds and remove the check's `unrun_reason`.

```sh
node deployment/adapters/azure-writer-permissions.mjs /private/haip-acceptance/plan.json /private/haip-acceptance/evidence /private/haip-acceptance/storage.json
```

Use the same settings and pinned originals as the immutable storage check. Add a fresh `writer_probe_id` UUID for each approved run. For `managed_identity`, add `runtime_identity_resource_id` from the Bicep output and give the Azure CLI Reader access to inspect that resource as well as the storage scopes and their role definitions. A `client_secret` principal reads its own identity in Microsoft Graph and must belong to the deployment's tenant. Set the plan's `independent_administration_asserted` after that administration has been verified. Recalculate `plan_digest` after adding the command to the final plan. [Read a service principal](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-get?view=graph-rest-1.0)

The preflight resolves the exact runtime principal, checks the effective role assignments at and above both evidence containers and follows the provider's pagination. It includes inherited and group grants returned by Azure. Assignments must be scoped to the two evidence containers and limited to blob add and read. The immutable storage preflight also checks the deployed policies and exact signed originals before a canary is written. An administrator must independently check the scope and any delegated access outside the role listing. [Azure role listing](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)

Each run creates two small blobs under `haip-acceptance/writer-probes/`, one per container. They are retained by the tested policies. Record their expected retention and cost before authorising the probe. The adapter repeats the conditional create, tries to replace and delete the exact synthetic versions, and rereads them after the denials. Blob hold and retention probes target the checkpoint canary. The management probes use the already configured private access values, a hold tag confirmed absent and an unused policy ETag. An unexpected success stops the exercise, and an account key response body is discarded. A passing result includes the same assignment digests before and after the probes. [Clear Legal Hold](https://learn.microsoft.com/en-us/rest/api/storagerp/blob-containers/clear-legal-hold?view=rest-storagerp-2025-08-01) [Extend Immutability Policy](https://learn.microsoft.com/en-us/rest/api/storagerp/blob-containers/extend-immutability-policy?view=rest-storagerp-2025-08-01)

## Backup recovery

Run this check with an isolated standalone deployment, an empty PostgreSQL restore target and the storage settings reviewed for the Azure writer and immutable storage checks. Stop the source listeners, callers and covered executors before the drill. Keep the target disconnected from traffic. The recovery command permanently retires the backed-up generation in the independent safety store.

In the single disposable tenant, create an execution-purpose request with `metadata.haip_acceptance_fixture` set to `backup_recovery`. Review and authorise it using the ordinary human flow, wait for its checkpoint and take an encrypted `.haipbak` while the grant is available and private material is present. Keep the checkpoint and safety records outside the backup. Record the original tenant, ledger UUID, generation UUID and request UUID. Use a server tarball from the exact release candidate and install its pinned dependencies before running the check.

Prepare a private settings file. The `plan_digest` covers the final plan file bytes. Set `server_archive` to the absolute path of the `@haip/server` npm tarball whose SHA-256 is in `deployment.service_artifact_digest`. Set `node_modules` to the absolute path of the installed dependency directory. Provide the encrypted file's absolute `backup` path and its `backup_digest`. Set `target_database`, `tenant`, `ledger_id`, `generation` and `request_id` to the reviewed identifiers. Set `storage_settings` to the absolute path of the Azure writer settings and `storage_settings_digest` to the SHA-256 of that file. Prefix each SHA-256 value with `sha256:`.

Supply the direct restore URL as `HAIP_ACCEPTANCE_RESTORE_DATABASE_URL`. Use the normal `HAIP_DATABASE_CA_FILE`, `HAIP_BACKUP_KEY_FILE` and `HAIP_PG_BIN` settings. Provide the signing key, key ID, trust manifest and OIDC variables from the isolated deployment. The adapter sets the origins from the plan and uses the storage account and writer identity from the reviewed storage settings. A client-secret writer uses `HAIP_ACCEPTANCE_AZURE_RUNTIME_CLIENT_SECRET`. A managed identity uses its configured identity endpoints. Include these variables in `adapter_env` as needed and list credentials in `secret_env`.

Configure `backup_recovery.command` with those paths and allow 300 seconds. Use a private evidence directory on encrypted storage, where the adapter stages its temporary copies and the authenticated restore uses scratch space.

```json
[
  "node",
  "deployment/adapters/backup-recovery.mjs",
  "/private/haip-acceptance/plan.json",
  "/private/haip-acceptance/evidence",
  "/private/haip-acceptance/recovery.json"
]
```

The adapter checks both input digests, restores with verified PostgreSQL TLS, applies pending migrations and verifies the signed canary before retirement. It runs the packaged offline recovery command, then checks the new fence, revoked grant, preserved receipt, cleared email copies and replacement operator. The evidence contains assertions and digests. A failing drill can leave the disposable target populated or the old generation retired. Review the recorded phase before using a fresh target for another attempt.

## Restart rollback

Use the same adapter command in `restart_rollback.command`, with its own recovery settings and two empty databases. Reuse the encrypted backup and independent storage from the recovery check. Give each invocation its own restore target if both checks are in the same plan. Set `target_database` to the restart target and `rollback_database` to the second database. Use distinct names. Allow 900 seconds for the check.

Provide the two administrative URLs as `HAIP_ACCEPTANCE_RESTART_DATABASE_URL` and `HAIP_ACCEPTANCE_ROLLBACK_DATABASE_URL`. Provide the runtime URLs for the same databases as `HAIP_ACCEPTANCE_RECOVERED_RUNTIME_DATABASE_URL` and `HAIP_ACCEPTANCE_ROLLBACK_RUNTIME_DATABASE_URL`. The runtime logins must be distinct from the restore roles and lack administrative role flags and membership in the restore roles. Set `HAIP_ACCEPTANCE_PRE_RECOVERY_PRODUCER_TOKEN` to the original bearer token for the synthetic review's producer. Use the plan's `adapter_env` and `secret_env` entries for those values.

The check restores the same signed canary to both targets and recovers one copy. It starts the packaged runtime on temporary loopback ports using the runtime database role. It verifies both listeners and the new operator, then attempts a claim using the original producer credential and again after reprovisioning that producer. The second attempt must return `namespace_retired`. The check stops the recovered process and verifies that a second start of its generation and a start against the old database copy both refuse before opening listeners. A passing drill leaves both disposable copies fenced.

## Outage expiry

Use a disposable installation with an isolated checkpoint store and a test producer that has no executor. Create three `fixed_mock` requests for distinct occurrences in the same tenant and generation. Set `metadata.haip_acceptance_fixture` to `outage_expiry`, `metadata.haip_acceptance_probe` to one fresh UUID and `metadata.haip_acceptance_role` to `fresh`, `preclaim` or `control` respectively. Set the shorter deadlines with `execution.valid_until` and keep the route revision fixed. Have the reviewer confirm each request normally and wait for the checkpoint. The two short grants must still be available and expire within the next 180 seconds. The control grant must remain valid for more than 60 seconds after the later short deadline.

In the private settings document, provide `plan_digest` for the final plan bytes, the UUID as `probe_id`, the `tenant` and `producer` IDs, a separately obtained `trust_manifest`, and a `requests` object mapping `fresh`, `preclaim` and `control` to the three request UUIDs. Put the producer token in `HAIP_ACCEPTANCE_OUTAGE_PRODUCER_TOKEN` and declare it in both `adapter_env` and `secret_env`.

Set `control_command` to the argument array for the independent operator's reviewed outage controller, starting with an absolute executable path. The adapter appends an action (`begin` or `restore`), the probe UUID, the plan digest and a lease length in seconds. Have the controller validate the reviewed target, interrupt checkpoint access for the isolated runtime while preserving safety record access, and return success after applying the requested action. The controller must restore access when its lease expires, even if the acceptance runner exits. The `restore` action should be safe to repeat. List the controller's environment variables in `control_env` and the plan's `adapter_env`, and list any credentials in `secret_env`. The producer token is only available to the API probe.

Configure `outage_expiry.command` and allow 360 seconds. Put the check first if other checks could run past the short deadlines. The adapter consumes the preclaim as a synthetic test claim. The short grants remain ineligible after the outage, and the longer control grant gets a fresh claim and admission after storage is restored. The adapter performs no external effect and leaves the three request records for review. Reserve a fresh set of requests for another run.

```json
[
  "node",
  "deployment/adapters/outage-expiry.mjs",
  "/private/haip-acceptance/plan.json",
  "/private/haip-acceptance/evidence",
  "/private/haip-acceptance/outage.json"
]
```

## Checkpoint conflicts

Use a disposable installation with its own signing key, isolated checkpoint and safety storage, and four test tenants without executors. Prepare two confirmed, anchored `fixed_mock` grants in each tenant. Use different occurrences and wait for the first grant to anchor before confirming the second so the grants refer to different checkpoints. Set `metadata.haip_acceptance_fixture` to `duplicate_conflict`, set `metadata.haip_acceptance_probe` to a fresh UUID for that tenant, and set `metadata.haip_acceptance_role` to `fresh` or `preclaim`. Give both grants enough time to complete the drill.

Set `plan_digest`, `storage_settings` (the absolute path to the reviewed Azure storage settings) and `storage_settings_digest` (the prefixed SHA-256 of those settings). In `cases`, provide `extra`, `missing`, `changed` and `deleted` objects. Each contains a distinct `tenant` and `probe_id`, the scoped `producer` ID, and the two UUIDs as `fresh_request` and `preclaim_request`. In `conflicting_checkpoint`, supply an `AuditCheckpoint` signed offline with the disposable installation's key for the `extra` case. Use the `fresh` request's checkpoint ledger, generation and sequence and replace its head with a different SHA-256 digest. Keep the signing key out of the settings and the adapter environment.

Supply distinct producer and operator tokens for each tenant. Name them `HAIP_ACCEPTANCE_CONFLICT_<CASE>_PRODUCER_TOKEN` and `HAIP_ACCEPTANCE_CONFLICT_<CASE>_OPERATOR_TOKEN`, using the uppercase case name. Declare them in `adapter_env` and `secret_env`. Supply the storage runtime credential in the same way as for the immutable storage check.

Configure `control_command` as the independently supervised fault controller's argument array with an absolute executable path. The adapter appends the case name, probe UUID, plan digest, storage origin, checkpoint container, blob key and pinned version ID. Give the controller separate credentials through `control_env`. Limit it to the reviewed key in the disposable namespace. It must make the specified condition visible to both the adapter and the service's checkpoint reader while leaving the preclaim checkpoint readable. The cases cover a new current version alongside the retained original, an empty listing, a single different current version and a listing that shows the pinned version without a current object. Use controlled responses where a real fault would require removing a retained version. Record any test versions the controller creates and their expected retention. [Azure versioning](https://learn.microsoft.com/en-us/azure/storage/blobs/versioning-overview)

Configure `duplicate_conflict.command`, allow 720 seconds and schedule it after exercises that need the same installation's ordinary storage access. The adapter checks all four namespaces before mutation. It then replays the original signed publication, submits the conflicting head conditionally, exercises each version fault and checks for the new incident and the tenant-wide refusal of claims and permits. Each affected namespace remains fenced for inspection.

```sh
node deployment/adapters/checkpoint-conflict.mjs /private/haip-acceptance/plan.json /private/haip-acceptance/evidence /private/haip-acceptance/conflict.json
```

## Notifications

Use an isolated review route, producer, requester and reviewer with a disposable mailbox, an HTTPS delivery receiver and an empty replay inbox. Map the two human accounts to distinct HAIP directory entries and give the requester the verified test mailbox address. Create a pending review without execution authority and set `metadata.haip_acceptance_fixture` to `notifications` and `metadata.haip_acceptance_probe` to a fresh UUID. Start soon enough that its creation webhook remains within the five-minute replay window when the confirmation webhook arrives. Retain an earlier, now expired, signed delivery for a different review owned by the same test producer.

Set `plan_digest`, `probe_id`, `tenant`, `producer`, `requester`, `reviewer`, `recipient`, `review_id`, `expired_request_id`, `trust_manifest`, `replay_endpoint` and `redirect_target` in the private settings. The endpoints are exact HTTPS URLs. The replay endpoint runs the same receiver implementation with its own inbox. Provide the scoped token in `HAIP_ACCEPTANCE_NOTIFICATION_PRODUCER_TOKEN` and declare it in `adapter_env` and `secret_env`.

Set `control_command` to the observer argument array starting with an absolute executable path. List its environment in `control_env` and `adapter_env` and declare its credentials in `secret_env`. The adapter appends the action, probe UUID, plan digest and action argument where specified. The observer should verify these bindings and return one JSON document on stdout. Return `null` for a mail, delivery or redirect observation that has yet to arrive.

| Action | Argument | Observation |
| --- | --- | --- |
| `mail` | Review UUID | The actual mailbox receipt as `recipient`, `review_link`, `received_at` and `message_digest` over the original message bytes |
| `deliveries` | Review UUID | The `created` and `decision` deliveries, each with its signed `envelope`, `committed_at` and `acknowledged_at` |
| `replay_state` | Review UUID | The durable inbox `rows` as `event_id`, `event_digest` and `revision`, plus `pending_revision` |
| `expired` | Earlier review UUID | The original signed envelope whose delivery timestamp is at least five minutes old |
| `arm_redirect` | Exact target URL | Switch the disposable delivery receiver to return a redirect to the monitored target |
| `redirect` | Redirect test request UUID | The signed `envelope`, `location`, `response_status` and `target_hits` for the monitored target |
| `restore_redirect` | None | Return the receiver to its normal delivery mode |

Record mailbox, commit and acknowledgement times in UTC. The replay endpoint acknowledges valid deliveries with a 2xx response after its transaction commits and refuses expired deliveries with a 4xx response. Use an empty response or JSON. Keep the redirected endpoint isolated and restore normal delivery when the controller lease expires, even if the adapter exits. The adapter also requests restoration when it finishes.

Configure `notifications.command`, allow 900 seconds and use a desktop session with Chromium installed. Sign in in this order when the tabs open. Use the requester, then the reviewer who confirms the disposable review in the trusted host, and then the requester again from the received link. The adapter verifies the browser and receipt, compares signed deliveries with the producer event stream, and checks replay, expiry and the redirect failure. It retains digests and observations without message bodies, cookies or tokens.

```sh
node deployment/adapters/notifications.mjs /private/haip-acceptance/plan.json /private/haip-acceptance/evidence /private/haip-acceptance/notifications.json
```

## Local fixtures

Tests use a generated certificate authority and reserved `.test` names routed to loopback. `--fixture-ca CA_FILE` labels the evidence `local_fixture`. With `--review-id`, headless Chromium uses the public keys first verified by the TLS probes and signs in through the local identity fixture. A successful fixture exercise reports `blocked` for deployment acceptance.

```sh
node deployment/adapters/origins-tls.mjs /private/haip-fixture/plan.json /private/haip-fixture/evidence --fixture-ca /private/haip-fixture/ca.pem
```

With PostgreSQL 17, Dex, Caddy, OpenSSL and `htpasswd` available locally, the identity test runs both token authentication methods over loopback HTTPS. It uses temporary accounts and a temporary certificate authority. The test observes outbound token exchanges, including refusal of an altered PKCE challenge.

```sh
HAIP_TEST_DEX=dex HAIP_TEST_CADDY=caddy node --import tsx --test tests/dex-oidc.integration.ts
```

After `npm run build`, run the backup adapter test to pack the server, restore a signed review over loopback PostgreSQL TLS and exercise recovery, restart and rollback against separate fixture storage. A successful local drill reports `blocked` for deployment acceptance.

```sh
node --import tsx --test tests/backup-recovery-adapter.test.ts
```

The outage adapter test uses signed grants over loopback HTTPS. It exercises recovery, an outstanding outage after the controller reports success, and restoration after the outage starts without an acknowledgement.

```sh
node --import tsx --test tests/outage-expiry-adapter.test.ts
```

The checkpoint conflict test uses the real checkpoint implementation, a fixture for versioned storage, and four tenants served over loopback HTTPS. It exercises the live adapter's approval check through the runner and the permitted scenarios through the collector.

```sh
node --import tsx --test tests/checkpoint-conflict-adapter.test.ts
```

The notification check runs through the acceptance runner with Chromium, a local mailbox and a dedicated PostgreSQL receiver database. It exercises opening the received link, commit before acknowledgement, replay, the five-minute cutoff and the visible redirect error.

```sh
node --import tsx --test tests/notification-acceptance.test.ts
```
