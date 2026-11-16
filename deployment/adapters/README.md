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

## Local fixtures

Tests use a generated certificate authority and reserved `.test` names routed to loopback. `--fixture-ca CA_FILE` labels the evidence `local_fixture`. With `--review-id`, headless Chromium uses the public keys first verified by the TLS probes and signs in through the local identity fixture. A successful fixture exercise reports `blocked` for deployment acceptance.

```sh
node deployment/adapters/origins-tls.mjs /private/haip-fixture/plan.json /private/haip-fixture/evidence --fixture-ca /private/haip-fixture/ca.pem
```
