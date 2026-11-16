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

## Local fixtures

Tests use a generated certificate authority and reserved `.test` names routed to loopback. `--fixture-ca CA_FILE` labels the evidence `local_fixture`. With `--review-id`, headless Chromium uses the public keys first verified by the TLS probes and signs in through the local identity fixture. A successful fixture exercise reports `blocked` for deployment acceptance.

```sh
node deployment/adapters/origins-tls.mjs /private/haip-fixture/plan.json /private/haip-fixture/evidence --fixture-ca /private/haip-fixture/ca.pem
```

With PostgreSQL 17, Dex, Caddy, OpenSSL and `htpasswd` available locally, the identity test runs both token authentication methods over loopback HTTPS. It uses temporary accounts and a temporary certificate authority. The test observes outbound token exchanges, including refusal of an altered PKCE challenge.

```sh
HAIP_TEST_DEX=dex HAIP_TEST_CADDY=caddy node --import tsx --test tests/dex-oidc.integration.ts
```
