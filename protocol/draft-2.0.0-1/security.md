# Reference security profile — draft

Use HTTPS for trusted host, OIDC, sandbox and webhooks in production. OIDC uses state,
nonce and PKCE; authentication rotates a server-side session. Cookies are host-only
`__Host-`, Secure, HttpOnly and SameSite=Lax. Human mutations require an exact Origin
and a session CSRF token. Trusted confirmation denies framing, executable producer
markup and app-accessible credentials. An initiating human must be established by
the operator directory; the production route requires requester/reviewer separation.

The app host uses a separate origin derived from tenant, authorised publisher and
bundle digest, with a scripts-only opaque inner frame. Exact source windows and
origins are checked in both bridge directions. The app receives one stored tool input
and one stored result, without a live MCP connection. Its only callable tool is
`haip_propose_decision`; confirmation, arbitrary tools, resource reads and external
navigation are rejected. CSP, permissions policy and iframe sandbox restrict network,
storage, forms, popups and navigation. Always retain the host view and response form.

Limits apply to uncompressed UTF-8/JCS material: bundle 5 MiB, payload 10 MiB, response
256 KiB, inline tool result 2 MiB, retained material 1 GiB per producer. Large payloads
are searched and paginated without silent truncation. Producer creation uses a
10/minute token bucket (burst 20), tenant 50/minute (burst 100), daily limits 200/1,000,
outstanding limits 100/500 and route daily limit 100. Existing authority remains
bounded by captured limits. Delivery quotas and failures must be visible.

One PostgreSQL transaction orders changes per tenant. It writes the state, audit chain,
producer events and transactional outbox together. Workers retry delivery for up to
24 hours; no notification adapter has approval authority. Webhook destinations are
operator-registered per producer, HTTPS only, allowlisted, DNS-checked and pinned for
each delivery; redirects and private network destinations are rejected. Receivers
must enforce five-minute replay tolerance and deduplicate before acknowledgement.

Each audit head commits to sequence, previous head and the signed record digest.
Checkpoint publication exposes only opaque ledger/generation identifiers, sequence,
head and signing metadata. Proofs disclose record digests rather than other producers'
private records. Production requires independently administered WORM storage,
conditional writes, exact versions and rejection of replacement or deleted versions.
The reference adapter uses Azure Blob locked retention. Independent administration
and restricted writer permissions must be verified operationally.
Development filesystem anchors in tests are explicitly not production WORM storage.

Deployment/restore, retention, key rotation and incident limits are in the operations
runbook. Missing identity, policy, keys, storage or independent anchoring must block
protected execution. This profile does not defend against a hostile binary owner,
and signatures do not establish human understanding or external effect correctness.
