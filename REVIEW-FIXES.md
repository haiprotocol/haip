# HAIP 2 draft review follow-up

This follows the review of [draft PR #5](https://github.com/haiprotocol/haip/pull/5)
at `7e58dece5fe4c93afa33fe42cbc062e8be102141`. The protocol and packages remain
unreleased `2.0.0-draft.1`. No Plasm repository, package publication or deployment
is included.

## Confirmed findings and changes

| Finding                                                           | Change and regression evidence                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An app could replace the candidate while confirmation was visible | Reserve the proposal slot before asynchronous work. Freeze candidate, ID and digest together; show every candidate field and proposal provenance. Ignore later proposals until explicit trusted dismissal and a fresh gesture. Browser tests withhold candidate and confirmation traffic while attempting hostile replacements. |
| Large bodies were parsed before authentication                    | Authenticate and check roles/CSRF before route-specific parsing. Creation and bundle quotas run before buffering. Unknown routes never parse bodies; ordinary control routes have small limits. HTTP tests leave bodies unfinished and still receive prompt refusals.                                                           |
| Unconfigured checkpoints could block notifications                | Without an anchor, select only deliverable SMTP/webhook jobs. Leave checkpoints pending and execution fenced. Tests deliver real fixture SMTP and TLS webhooks behind more than 50 pending checkpoints.                                                                                                                         |
| Expensive request preparation held the tenant lock before quotas  | Read-only quota admission precedes canonicalisation and schema compilation outside the lock. Recheck and reserve atomically when accepting. Tests race the final quota slot, hold the tenant lock during refused creates and preserve existing confirmation.                                                                    |
| Production anchoring requirements were checked too late           | The worker already rejected production without an independent anchor. Startup now explicitly requires the Azure account/container and administration acknowledgement before database setup, including bootstrap. This validates configuration, not actual administrator separation.                                             |

Further corrections cover:

- Re-verifying delivered bundle bytes and manifest against the request binding;
  exact per-review sandbox CSP and restrictive headers on sandbox errors.
- Correlated, one-use JSON-RPC responses, separate production registrable sites,
  verified PostgreSQL TLS and startup validation of the active signing key/trust.
- Public schema constraints linking execution purpose, binding and profile, plus
  an explicit receipt purpose checked by the SDK.
- Read-only inbox/status/material/export operations, SQL pagination, indexed
  maintenance and checkpoint batches, tenant-scoped operational records, bounded
  publisher quotas and preserved response reservations.
- Login sessions retained until successful atomic replacement; malformed CSRF
  tokens return 403. Browser assets are minified and may be revalidated by caches.
- Distinct HAIP 2 guides, legacy redirects, archive warnings, research path
  redactions with a before/after hash ledger, and verified upstream source notices.
- Fresh fixture output under ignored `.local/validation/current/`; checks no longer
  delete or replace committed historical evidence. CI checks for tracked changes.
- A development Docker/Compose path with pinned official images, explicit private
  configuration, an unprivileged runtime and a separate packaged-service CI smoke.
  No container image is published and no production deployment is claimed.

## Validation

The [clean-copy run](research/haip2-2026-08-30/validation/review-fixes-bc1feed/local/manifest.json)
and [hosted run](https://github.com/haiprotocol/haip/actions/runs/33339089387) both
passed **68 tests**, **25 cross-language comparisons**, the production dependency
audit (**zero known vulnerabilities at the recorded runs**) and four package dry
runs. New coverage includes actual browser timing attacks, database concurrency,
interrupted request bodies and atomic session insertion failure; these are isolated
fixtures, not deployed provider acceptance. Checks preserved all tracked files.

Hosted CI also built the development image and passed **nine packaged-service
checks** against disposable PostgreSQL and OIDC fixtures. The image ran without
root; its context exclusions, bootstrap, signed confirmation, browser assets and
isolation headers were exercised. Compose configuration was validated separately;
runtime smoke used Linux host networking, not `docker compose up`.

Documentation checks cover 27 distinct live guides, 41 redirects, 292 internal
links and parsing of all 73 MDX pages. All 128 archived HAIP 1 source files remain
unchanged. [Publication edits](research/haip2-2026-08-30/publication-edits.json)
declare redactions and attribution additions without rewriting historical outcomes.
Hosted documentation rendering has not been claimed.

[Retained evidence](research/haip2-2026-08-30/validation/review-fixes-bc1feed/README.md)
records commit `bc1feed4aac1dbe5ea6e47d2c9ad5ce8dd9f9fcd`, exact versions and hashes,
including populated review and frozen-confirmation screenshots captured before
confirmation. These results remain separate from the original 46-test records.
The draft PR's current checks identify which later revision GitHub has tested.

## Remaining release boundary

Keep the PR a draft. Real identity/storage permissions, independent administration,
production DNS/TLS, delivery, restore and restart acceptance remain unrun; see
[deployment acceptance](deployment/acceptance.md). Independent implementation and
security review, and Plasm-maintainer integration, remain release requirements.
Local fixtures and development packaging do not satisfy those gates. No Amazon
service, paid resource, merge or deployment is introduced by this follow-up.
