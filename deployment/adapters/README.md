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

## Coverage

Successful probes return `blocked`. This adapter does not exercise actual session issuance, hostile browser framing, unexpected message sources or browser network enforcement. Seeing the intended headers, or reading an authenticated session, does not prove those browser properties. The missing evidence must be supplied by an exercised browser adapter before the full `origins_tls` check can pass. Failed TLS, routing or header probes return `failed`.

The trusted health probe requires the current runtime headers. An unexpected trusted Host must receive 403, 404 or 421 without a redirect. A front-end proxy that closes the connection instead remains a failed probe requiring review. The sandbox probes require the current reference service policy, including its empty connection allowlist and absent network reporting destinations.

## Local fixtures

Tests use a generated certificate authority and reserved `.test` names routed to loopback. The explicit `--fixture-ca CA_FILE` option is for this rehearsal only. It labels the evidence `local_fixture`, fixes resolution to loopback, restricts all names to `.test` and retains the incomplete browser coverage. Custom certificate authorities are refused outside fixture mode. A fixture result does not establish provider acceptance.

```sh
node deployment/adapters/origins-tls.mjs /private/haip-fixture/plan.json /private/haip-fixture/evidence --fixture-ca /private/haip-fixture/ca.pem
```
