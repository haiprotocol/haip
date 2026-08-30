# HAIP 2 worker and boundary follow-up

This addresses the review of draft PR #5 at
`67b6f1752e5865cd0fa0843dac54885340cdce2a`, after the
[first review fixes](REVIEW-FIXES.md). The packages and protocol remain unreleased
`2.0.0-draft.1`. This changes only HAIP; no Plasm repository or paid service is involved.

## Worker progress

- Cleanup no longer drains an unbounded loop before listeners open. Each call
  examines at most 500 requests per tenant, in pages of 50. An in-memory cursor
  advances past inspected rows, including unchanged rows, without editing captured
  timestamps or signed records. The call returns progress and whether unvisited
  work remains. Listeners open after the first bounded call; a single timer continues
  remaining work after one second, returning to 15 minutes when caught up.
- The original liveness issue needed a full stalled page, not one stalled row.
  A completely unchanged page ends that tenant's current call. Later rows remain
  reachable on continuation; a wholly stalled set ends its pass and cannot request
  endless immediate retries. A deduplicated `retention_stalled` incident calls for
  investigation. Restart begins a fresh bounded pass.
- Seven housekeeping collections run once per tenant per call, each changing at
  most 500 rows. Already-cleared fields are excluded. A 501-row lookahead determines
  whether collection can continue. Expired sessions are collected once globally,
  outside tenant advisory locks, with the same batch bound.
- Additive migration `005_worker_progress.sql` supplies readiness indexes for both
  anchored and unanchored delivery queries, ordered by tenant, ready time, creation
  time and ID. Collection indexes support the bounded selectors. Existing migration
  bytes are unchanged.
- A checkpoint with more pending decisions persists a 30-second continuation delay.
  Every later page re-verifies independent storage; its retained acceptance receipt
  is diagnostic only. The delay survives restart and does not extend a grant clock.

These bounds are per tenant, not a service-wide time limit. Query duration, tenant
count and provider latency still need deployment monitoring. Stalled records are
never made authoritative by rewriting their deadlines.

## Remaining review items

| Item                     | Change                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export bundle integrity  | The app and export paths share validation of HTML digest and manifest identity, tenant, publisher and compatibility against the accepted request binding. Missing required bytes fail closed; private material remains withheld at its exact expiry.                                                                                         |
| Inbox full count         | `RequestList` now contains `items` and `next_offset`, with no `total`. A 51-row lookahead returns at most 50 summaries. The next offset never exceeds the existing 100,000 cap. Schema, generated types and both OpenAPI copies agree.                                                                                                       |
| Login completion         | Callback state is bound to the initiating authenticated-cookie state. A new login using the same pending browser cookie replaces its generation. One-use claims precede OIDC exchange; finalisation checks the generation and atomically retires any initiating active session before replacement. No database lock is held during OIDC I/O. |
| Bootstrap credentials    | Require at least 32 decoded bytes in canonical base64url or hexadecimal, rejecting obvious repeated-byte fixtures. Operators must still use a cryptographically secure generator: input checks cannot establish entropy.                                                                                                                     |
| Browser boundaries       | Add opener, embedder and resource policies on trusted and sandbox responses. HTTPS and distinct registrable sites apply to remote development as well as production; only two loopback hosts may use the development exception.                                                                                                              |
| Webhook and audit guards | Reject the special `192.88.99.0/24` relay range, including mapped IPv6 forms, and return controlled 404 when audit signing cannot find its tenant.                                                                                                                                                                                           |

The `RequestList` shape changes an unpublished draft; no published version is
silently revised. The shipped host already uses only `items` and `next_offset`.
Offset pagination and visibility filtering can still inspect earlier rows. A null
next offset at the cap does not prove that no older matching requests exist.

The review's callback-URL-only login-CSRF claim was not reproduced: the original
host-only, Secure, HttpOnly login cookie already prevents a different browser's
callback URL from completing a login. The additional changes address session
binding and delayed concurrent callbacks, including anonymous and expired-session
starts. `SameSite=Lax` remains necessary for the supported top-level provider GET
redirect. An unrelated or stale state cannot consume a newer login generation.
Nonce/PKCE, identity or session-insert failures preserve the existing session while
consuming the matching callback claim. No new persistent browser identifier is added.

`/review/:id` returning 404 for unknown or inaccessible requests is intentional.
Its authenticated database read checks visibility and derives the exact allowed
sandbox origin. It does not write lifecycle transitions.

The [HTML embedder-policy requirements](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-embedder-policies)
explain the explicit sandbox resource policy, while the
[IANA special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)
identifies the excluded relay addresses. Local browser and network fixtures test
the implementation; they do not validate a production proxy or DNS configuration.

## Verification and release boundary

Regressions exercise full stalled pages followed by healthy work, bounded collection
with already-cleared records, PostgreSQL index plans, delayed checkpoint continuation
and storage re-verification, exact export expiry, pagination through the offset cap,
real cross-site browser redirects, session replacement failures and opener isolation.
Screenshot capture temporarily expands the actual viewport so the isolated app
is on screen; full-page capture alone omitted its pixels when it was off screen.
Normal-viewport interaction and confirmation remain tested with the same headers.
Final clean-copy and hosted results are recorded separately from the earlier 46-test
and 68-test evidence. The PR's checks identify the tested revision.

Keep the PR a draft. Actual identity/storage permissions, independent administration,
production origins, delivery, backup/restore and restart acceptance remain the
[deployment gates](deployment/acceptance.md). The work adds no Amazon dependency,
provisions no resource, publishes no package or image and performs no merge or deployment.
