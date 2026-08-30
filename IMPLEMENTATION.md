# HAIP 2 implementation ledger

Status: **HAIP-owned draft implementation with local and hosted CI evidence; full HAIP 2
release remains incomplete**. Protocol/package version is `2.0.0-draft.1`.
Available for review in [HAIP draft PR #5](https://github.com/haiprotocol/haip/pull/5).
Package publication and deployment remain unauthorised and have not been performed.

## Ownership and baseline

HAIP development is on `l/haip-2`, based on fetched main
`f04a2f362ee02e09fd23819a5409e78b82a7be8b`. Existing packages were repurposed in place.
HAIP 1 source and guidance remain in `archive/v1` and `docs/archive/v1`. The HAIP name,
independent protocol, MIT attribution, website and `@haip` scope are retained.

**Plasm is externally owned.** The earlier separate local safety/pin proposal is not
an upstream PR or accepted integration. Its recorded core baseline is
`c030523b8c93aa7e22d60dd4050a3626043c18b7`, parent
`835d276a4652e1505c29467018ba61dcf87b3ce2`. No further Plasm implementation was made
while completing the HAIP-owned work. HAIP does not vendor its engine or renderer.

## Implemented HAIP responsibilities

- Independent review/execution drafts, evolution/trust rules, JSON Schema, generated
  types and OpenAPI 3.1. Public response-schema checks and reusable review fixtures
  need no Plasm. Unsupported profiles fail without downgrade.
- Node 24/Express 5/PostgreSQL service; immutable bindings; scoped credentials,
  publisher registrations, directory identities and operator routes. OIDC
  state/nonce/PKCE, server sessions, CSRF and separate trusted confirmation. OAuth
  metadata discovery and Basic client authentication support Clerk-style setup.
- Native inbox, assignments, deadlines, delivery failures, searchable escaped host
  views, response form and isolated MCP App bridge. Exact renderer pins, source
  validation, handshake replay rejection and one stored input/result delivery.
- Signed candidates/receipts, separate purpose/state dimensions, captured quotas,
  targeted invalidation, idempotency, cancellation, supersession and permanent
  occurrence consumption. Reviewer removal clears assignments without resetting quotas.
- Exclusive claims, fresh admission, original deadlines, SDK verification, outcomes
  and reconciliation. The independent counter fixture persists one launch fence and
  never repeats an uncertain effect or replays to retry outcome reporting. Its single
  execution window includes initial reads; fixed action/context/policy checks precede claims.
- Transactional events/outbox, SMTP, owner notifications after sign-out, bounded
  delivery windows and restricted HTTPS webhooks. SDK receiver verification and
  durable deduplication handle duplicate/out-of-order delivery before acknowledgement.
- Optional Azure locked-WORM checkpoint adapter with conditional writes and exact
  version checks. Separate permanent records bind ledger/process generation, retire
  old generations and fence occurrences/identities. No Amazon runtime dependency or service.
- Offline recovery: retire independently before changing the database, conservatively
  reapply missing deletion/revocation, disable restored credentials, preserve original
  signatures and require new provisioning/review. Every restart of an activated
  production generation requires recovery; there is no transparent failover.
- Checksum-verified migrations, AES-256-GCM backups, empty-target restore, admission
  fencing and 30-day pruning. Private retention clears response copies; audit cleanup
  preserves commitments and permanent execution fences. Daily quotas use separate
  counters, surviving cleanup, retries and credential rotation. Older drafts pause
  new creation until the next UTC day when upgrading; existing review continues.
- Scoped JSON/Prometheus metrics, worker success/failure stamps, incidents and
  uninstalled deployment/alert examples. SDK, CLI, generic HTTP/App examples, HITL
  v0.8 mapping, research runners, evaluation-integrity checks, licences and v1 archive.

## Validation and limits

Original commands, results and source hashes are in
[the validation manifest](research/haip2-2026-08-30/validation/manifest.json).
[The acceptance matrix](ACCEPTANCE.md) maps each plan area to evidence and ownership.
That original local suite passed **46 tests**, with **25 cross-language comparisons** and
**zero known dependency vulnerabilities** at the recorded audit. Four draft package
tarballs are prepared under `output/packages`; nothing is published.
The [review follow-up](REVIEW-FIXES.md) adds the confirmation, request-admission,
startup, quota, isolation, documentation and publication corrections. The expanded
local suite passes **68 tests** with 25 comparisons and a clean production audit;
new run evidence is kept separately from those historical snapshots.

[The first hosted CI run](https://github.com/haiprotocol/haip/actions/runs/33334308802)
also passed 46 tests, 25 comparisons, the production dependency audit and all four
package dry runs. It tested `5f70557e7d8a0f29a1e0ea87170689d452375d31` through GitHub's
PR merge checkout, whose tree matches that commit.
[Remote evidence](research/haip2-2026-08-30/validation/remote-ci-33334308802/manifest.json)
preserves its actual versions, results and artefacts separately from local snapshots.

Local tests use throwaway PostgreSQL, a local OIDC provider, browser/TLS/SMTP fixtures
and fixed mock effects. Recovery performs real dump/restore, including a matching
checkpoint prefix with a lost unanchored consumption/deletion tail. Fault injection
loses acknowledgement after independent consumption and verifies refusal of identity
substitution and restart admission. Historical signatures are never rewritten.

Additional regression checks cover state/nonce/PKCE and concurrent callbacks, same-OIDC
identity aliases in separation of duties, unknown required execution profiles, exact
admission expiry, real database lock waits and initial counter reads consuming either
admission or execution time. Checkpoint acceptance crossing expiry is checked against
stored state before a status read can refresh it. Cross-producer/tenant refusal covers
claims, admission, outcomes, reconciliation and the other mutation endpoints.

Azure test transports check conditional writes, exact versions, retention conflicts
and legal holds; they do **not** establish actual permissions or independent
administration. Generic OAuth is tested; a real Clerk/Entra application is not
configured. No R2 uploader or Vercel deployment is claimed. Local HTTPS/persistence
tests do not validate a future deployment's network path. The validation manifest is
a local run snapshot; the draft PR's checks are authoritative for remote CI status.
GitHub Actions was disabled during pre-push review and is now enabled for this HAIP
repository. The workflow has read-only repository permissions and uses standard
public-repository runners. The PR remains a draft; no merge or deployment is triggered.

The Node/Python/Rust runner retains 25 exact comparisons, including decimal responses
and RFC 8032 vector 1. Dependency audit and four package contents are recorded
separately. Passing fixtures is bounded evidence, not exhaustive security proof.

## Remaining release dependencies

1. Validate an approved deployment's external identity, TLS/DNS, independent Azure
   administration, writer restrictions, real immutable storage and restore procedure.
   No paid account/resource exists; free options come first.
2. Obtain independent implementation/security review and keep remote CI passing before
   calling the reference service production-ready.
3. Plasm maintainers own live/durable contexts, execution enforcement, credentials,
   dispatch accounting, continuations and schema-3 evidence. Hosted Plasm owns its
   control-plane integration. Those milestones and acceptance tests are absent.
4. Keep contracts draft until full release gates pass. The owner has authorised the
   HAIP commit, push and draft PR; merging, publication and deployment remain separate.

See [provider policy](PROVIDERS.md), [operations](OPERATIONS.md) and [release gates](RELEASE.md).
