# HAIP 2 research collection — 30 August 2026

This collection separates historical feasibility evidence from actual implementation
checks. None of it is a claim of a completed production, live-window or delayed Plasm
release. HAIP is independently MIT-licensed; third-party attribution remains intact.

## Provenance

| Source | Pinned revision / identifier | Use |
|---|---|---|
| HAIP baseline | `f04a2f362ee02e09fd23819a5409e78b82a7be8b` | Fetched default branch before implementation |
| Plasm canonical core | `c030523b8c93aa7e22d60dd4050a3626043c18b7` | Local external upstream proposal only |
| Plasm parent | `835d276a4652e1505c29467018ba61dcf87b3ce2` | Isolated MCP manifest/lock proposal |
| [HITL Protocol](https://github.com/rotorstar/hitl-protocol/tree/655eba84932669af057e3cd9cacb1c94ae51ae65) | `655eba84932669af057e3cd9cacb1c94ae51ae65`, v0.8 | Browser review/poll mapping; no blanket conformance claim |
| CHAP | `5cc294bdf828a653cb20f997801907bcc99a6978` | Historical review/security-signed design sources; see historical provenance |
| awaithumans | `bc05b8e7121be50f59cadf18a86b9e626e79c6b3` | Static inbox comparison only |
| Impri | `a665dbcb263272a87d350032f1810a17f7821893` | Static inbox comparison only |
| [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) | JSON Canonicalization Scheme | Canonicalisation and number expectations |
| [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032#section-7.1) | Section 7.1, test vector 1 | Authoritative empty-message Ed25519 vector |

Neither inbox candidate was deployed or integrated during the comparison. Neither is
a runtime dependency. See [the static comparison](historical/inbox-comparison.md).
CHAP's workspace JSON-RPC and decide.override are not adopted; its historical integer-only
canonicalisation restriction is not used for HAIP decimal responses.

Historical evidence was found under
`/Users/leecrossley/plasm/research/haip2-experiments-2026-08-30` and copied to `historical/`.
The original aggregate runner was not retained. Compiled probe binaries and generated
Plasm renderer bundles were excluded; original screenshots, DOM, vectors, source probes,
inputs and results were retained. Their own index records original paths/versions.
Historical browser results establish feasibility at those inputs, not today's conformance.

## Reproducible current checks

- `npm run check`: builds all four packages and the browser, checks exact dependency pins
  and integrity declarations, then runs the local public HTTP/browser and lifecycle suite.
  The running service uses throwaway PostgreSQL, a local OIDC issuer, independently
  credentialled producers/publishers and mock effects. Retention and restore checks
  additionally inspect or restore their isolated database fixture.
- `npm run test:cross-language`: `runners/run.mjs` compares Node, Python and Rust JCS
  responses including 0.1, Unicode ordering, arrays and the safe-integer boundary, then
  checks RFC 8032 test vector 1 in all three languages. Its 25 checks preserve exact
  input, expectation and actual output in `runners/results.json`.
- Browser tests use ext-apps **1.7.4** and MCP SDK **1.29.0** from the root lockfile.
  They prove one stored input/result delivery for the fixture, proposal without automatic
  confirmation, escaped text, blocked tools/storage/network/popups/navigation and full
  review of a near-10-MiB payload containing 1,000 steps. They do not prove every possible
  handshake/source-window attack. A screenshot is retained under `../../output/playwright`.
- SMTP uses a local sink with verified test.invalid recipients, notification after
  sign-out, quotas and expired-window refusal. A real isolated TLS receiver exercises
  persistence before acknowledgement, restart deduplication, reordered events and
  five-minute replay rejection. Deployment-specific delivery paths remain unrun.
- Recovery uses real PostgreSQL dump/restore with separate checkpoint/safety storage,
  both newer history and a matching prefix with a lost unanchored tail. It exercises
  permanent retirement, removal of restored private data/credentials and refusal of
  old occurrences. Encrypted backups additionally test authentication, empty targets
  and pruning. Azure transport fixtures validate adapter decisions, not real WORM/RBAC.
- Provider choices follow the owner's free-first/no-Amazon preference. Official
  Cloudflare, Clerk, Vercel and Azure sources are linked in `../../PROVIDERS.md`.
  No cloud resource, subscription or real identity application was created.

Python dependency versions are exact in `runners/requirements.txt`. Rust dependencies
and transitive resolution are retained in `runners/rust/Cargo.lock`; the runner builds
with `--locked`. Actual language versions and timestamps are in the results. These
primitive checks are separate from signed protocol object validation and runtime safety.

## Ownership and licences

HAIP code is in `/Users/leecrossley/pro/haip`. The original Plasm checkout was preserved.
Local proposals are in `/Users/leecrossley/pro/haip2-plasm/upstream-proposal`, with separate
`core-safety.patch` and `mcp-pins.patch` files and exact test results. No PR, commit or push
has been made. Maintainer acceptance and full integration tests remain external work.
The proposed core changes do not implement contexts, continuations or schema-3 evidence.

MCP licences are retained under `../../third-party`; historical CHAP sources retain their
Apache-2.0 notice. Plasm's renderer is not vendored/relicensed in HAIP. Its distribution
requires the applicable upstream licence and source obligations; bundle registration
cannot change authorship or licence. The new review app fixture is independently authored.

Actual logs and the validation manifest are in `validation/`. Unrun work is recorded in
`../../IMPLEMENTATION.md` and `../../RELEASE.md`, not represented by fabricated results.
The latest local run passes 46 tests; the earlier 25- and 40-test records are retained
separately. New regressions cover OIDC callback/identity aliases, exact expiry and lock
waits, counter reads exhausting validity, and daily quotas surviving audit deletion and
credential rotation. These checks do not validate a deployed identity or storage account.
