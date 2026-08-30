# HAIP 2 acceptance matrix

This maps the agreed plan to concrete evidence. **Local** means the HAIP-owned
implementation is exercised by isolated fixtures, locally or in hosted CI, not
certified for a deployed system.
**External** identifies Plasm or real infrastructure that has not been validated here.
Contracts remain draft. Original results and source hashes are in
`research/haip2-2026-08-30/validation/manifest.json`.
The first hosted run passed 46 tests and 25 cross-language comparisons; its versions,
tested commit and retained artefacts are in the
[remote CI record](research/haip2-2026-08-30/validation/remote-ci-33334308802/manifest.json).
The [review follow-up](REVIEW-FIXES.md) records the subsequent safety fixes and
expanded 68-test clean-copy and hosted suites, plus nine development-container
checks. [New evidence](research/haip2-2026-08-30/validation/review-fixes-bc1feed/README.md)
is retained separately; historical records are not overwritten by later runs.
The [worker and boundary follow-up](WORKER-FOLLOW-UP.md) records the subsequent
bounded-maintenance, export, pagination, login and browser changes.
Its [separate evidence](research/haip2-2026-08-30/validation/worker-follow-up-7daeefa/README.md)
records 85 passing tests, 25 comparisons and nine container checks on `7daeefa`.

| Plan area             | HAIP evidence                                                                                                                                                               | Remaining boundary                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Protocol independence | `conformance/review.mjs`, `conformance.test.ts`, HTTP/schema tests; no service internals in reusable fixtures or Plasm data in generic requests                             | Local; other implementations can reuse fixtures                               |
| Evolution             | Unsupported revision/profile and signed metadata in `http.test.ts`; migration checksum/downgrade refusal in `recovery.test.ts`; rotation boundaries in `primitives.test.ts` | Local; future revisions must retain invariants                                |
| Purpose/profiles      | HTTP purpose refusal and SDK profile/binding verification                                                                                                                   | Local; review never upgrades to execution                                     |
| Independent review    | Browser OIDC and independent choice App, signed response/events; reusable HTTP fixture                                                                                      | Local                                                                         |
| Independent execution | HTTP counter, original records/fence, duplicate outcomes and lost reporting; refusal/crash cases                                                                            | Local fixed mock action; no general runtime                                   |
| Isolation             | Producer/tenant/publisher denial, same-digest registration checks, scoped events/metrics, separate sandbox origins, wrong-source messages                                   | Local; deployment DNS/origin policy external                                  |
| Request integrity     | Creation retry/conflict, frozen candidates, supersession and consumed-occurrence refusal                                                                                    | Local                                                                         |
| Confirmation          | Human OIDC, exact candidate digest, concurrent confirmation, producer/App refusal                                                                                           | Local                                                                         |
| Separation of duties  | Operator-resolved owner, self-review and same-OIDC-identity alias refusal, identity uncertainty and disable/re-enable cases                                                 | Local; real directory mapping operational                                     |
| Targeted invalidation | Reviewer/owner/producer removal, re-addition, unrelated route/producer-pool additions                                                                                       | Local; removed assignment cannot retain its lease                             |
| Browser security      | Chromium CSRF/origin, framing, escaping and sandbox attacks; HTTP state/nonce/PKCE, session fixation and concurrent callback tests                                          | Concrete local attacks, not exhaustive proof                                  |
| Large plans           | Near-10-MiB payload and search through all 1,000 steps                                                                                                                      | Local browser test                                                            |
| Dependency drift      | Exact ext-apps 1.7.4/MCP SDK 1.29.0 assertions, lockfile, rebuild and replay                                                                                                | Local; Plasm renderer remains separate                                        |
| Mode selection        | HAIP unsupported mode/profile/provenance refusal; generic `fixed_mock` advertised                                                                                           | Plasm durable preference/context classification external                      |
| Live approval         | Captured deadlines, no grant extension, process-generation restart refusal                                                                                                  | Plasm live context/commit expiry/sticky execution external                    |
| Live credentials      | No credential transport through HAIP Apps                                                                                                                                   | Plasm frozen tokens, refresh refusal and destination checks external          |
| Reconstruction        | No fabricated reconstruction support advertised                                                                                                                             | Plasm catalogues, symbols, overlays and deterministic reconstruction external |
| Delayed approval      | HAIP review/notification lifecycle independent of producer session                                                                                                          | Plasm continuation beyond TTL/restart without Redis external                  |
| Policy                | HAIP route/identity checks fail closed and bind rule revision                                                                                                               | Plasm policy loaders, every entrance and cached failures external             |
| Concurrency           | Concurrent HTTP confirmations/claims; permanent identity/occurrence writes                                                                                                  | Plasm one-launch/Shuttle invariants external                                  |
| Crashes               | Lost consumption acknowledgement, database rollback and counter fence without result                                                                                        | Plasm launch/dispatch crash boundaries external                               |
| Retry safety          | Counter remains one after outcome-report failure/reinvocation; partial launch uncertain                                                                                     | Plasm whole-engine conflict after effects external                            |
| Execution limit       | Counter FIFO read consumes the single execution window; expiry leaves a fence and no counter effect                                                                         | Plasm queues, pagination, backoff and parallel attempts external              |
| Timing                | Real database lock waits; both skew directions, wall jump, nonce, exact SDK expiry and reads exhausting admission; anchoring I/O crosses expiry                             | Deployed clock health and Plasm scheduling external                           |
| Revocation            | New claim/permit refusal, permanent targeted invalidation, original permit retained                                                                                         | Issued bounded permits cannot be retracted                                    |
| Pending anchor        | No claims before checkpoint; review never gets grants; expired grant cannot revive                                                                                          | Local                                                                         |
| Anchoring             | Outage/conflict/fencing, duplicate/version/retention/hold adapter cases, separate fixture storage                                                                           | Real Azure immutable storage/permissions external                             |
| Notifications         | SMTP after logout, quota/expired-window refusal; TLS persistence, restart dedupe, reordered events, five-minute replay rejection                                            | Deployment delivery path and alert installation unrun                         |
| Fatigue controls      | Stable-principal limits, reminders/supersession, 32 proposals; daily counters survive cleanup/key rotation; upgrade preserves confirmation while creation is paused         | Local                                                                         |
| Retention             | Captured private/audit deadlines, response-copy deletion, consumption after cleanup, migration/recovery                                                                     | Deployed storage/lifecycle enforcement external                               |
| Offline evidence      | JCS/Ed25519, original record verification, identity/purpose/profile/binding/nonce/anchor/timing refusal; historical time indeterminate without evidence                     | Plasm schema-3 prefix/seal/evidence CLI external                              |
| Backup restoration    | Encrypted dump/empty-target restore, wrong key/tamper refusal, newer remote history and matching prefix with missing tail; retirement and credential/private-data clearing  | Real storage account and deployed rehearsal external                          |
| Operations/release    | Metrics, worker failure stamps, alert/service examples, runbook, packages, passing hosted integrity checks and v1 archive                                                   | No installation, publication, independent review or stable release            |

The filesystem safety store is a fault-injection fixture, not production WORM.
Azure adapter tests do not contact Azure. The OIDC fixture is not a Clerk account.
The counter is a bounded demonstration, not Plasm. No external dependency is marked
complete by substituting one of these fixtures.
