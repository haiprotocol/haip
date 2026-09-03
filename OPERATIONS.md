# HAIP 2 draft operations

This runbook covers the HAIP-owned reference service. Production admission requires
independent checkpoint and permanent safety storage. The implementation and isolated
restore tests exist; real Azure/RBAC and external OIDC deployment validation remain release
gates. Never enable admission by editing database fence flags.

Use free services where they fit; no Amazon services are required or supported.
See [provider choices](PROVIDERS.md) before choosing any hosting or identity service.
Azure anchoring is optional for local review and requires separate approval to provision.

## Configuration and provisioning

Use Node 24 and PostgreSQL 17 or a separately validated compatible version. Local
evidence uses PostgreSQL 17; Ubuntu CI installs its distribution version and records
the exact runtime versions in the run log. Set a
restricted database role, TLS at the database boundary and encrypted storage/backups.
The schema migration creates the HAIP tables; the service never consumes a HAIP 1
streaming database. Versioned SQL migrations run under one database lock, verify checksums and refuse
unknown newer migrations. They preserve signed objects and captured deadlines. The
initial unversioned draft schema is adopted by the idempotent first migration. Test
upgrades against an encrypted backup in an empty isolated database before rollout.
Do not edit applied migrations. A binary downgrade must refuse a newer schema.

| Variable                                                               | Meaning                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `HAIP_DATABASE_URL`                                                    | PostgreSQL connection with isolated credentials; production forces verified TLS             |
| `HAIP_DATABASE_CA_FILE`                                                | Optional private CA PEM for database certificate verification                               |
| `HAIP_MODE`                                                            | `development` or `production`; requires independent safety and checkpoint storage           |
| `HAIP_ORIGIN`                                                          | Exact trusted host origin, including port if used                                           |
| `HAIP_SANDBOX_ORIGIN`                                                  | Exact pattern; `{scope}` occupies a whole subdomain of a fixed, separate production site    |
| `HAIP_SIGNING_KEY_FILE`                                                | Readable Ed25519 private PEM, never a database field                                        |
| `HAIP_SIGNING_KEY_ID`                                                  | Key identifier in the independently configured trust manifest                               |
| `HAIP_TRUST_MANIFEST_FILE`                                             | JSON trust manifest; see the draft schema                                                   |
| `HAIP_OIDC_ISSUER`                                                     | Exact trusted issuer URL                                                                    |
| `HAIP_OIDC_CLIENT_ID`, `HAIP_OIDC_CLIENT_SECRET`                       | Confidential client registered with that issuer                                             |
| `HAIP_OIDC_LOCAL_HTTP`                                                 | `true` only for a local development identity fixture                                        |
| `PORT`, `HAIP_SANDBOX_PORT`                                            | Listener ports; default 8080 and 8081                                                       |
| `HAIP_LISTEN_HOST`                                                     | Defaults to `127.0.0.1`; explicit wildcard binding is available for isolated containers     |
| `HAIP_SMTP_HOST`, `HAIP_SMTP_PORT`, `HAIP_SMTP_FROM`                   | Optional delivery configuration                                                             |
| `HAIP_SMTP_USER`, `HAIP_SMTP_PASSWORD`                                 | Optional SMTP authentication                                                                |
| `HAIP_SMTP_TLS`                                                        | Implicit TLS by default; `false` is intended for a local test sink                          |
| `HAIP_WEBHOOK_HOSTS`                                                   | Comma-separated exact HTTPS destination host allowlist                                      |
| `HAIP_AZURE_ACCOUNT_URL`, `HAIP_AZURE_CONTAINER`, `HAIP_ANCHOR_PREFIX` | Azure Blob locked WORM; account/container required in production, prefix defaults to `haip` |
| `HAIP_ANCHOR_INDEPENDENT_ADMIN`                                        | Must be `true` in production; an assertion, not proof of independence                       |

Production checks origin separation, explicit anchoring configuration and trust before
database migrations or listeners, including during bootstrap. Trusted and sandbox
origins require HTTPS and different registrable sites, including private public-suffix entries;
sibling subdomains do not suffice. The scope placeholder cannot change the registrable
site. These origin checks also apply to development unless both hosts are loopback;
setting development mode does not make a remote or shared site safe.
The trust manifest must match the issuer and protocol revision, contain unique
public key IDs and match the active Ed25519 private key within its validity window.
Historical public keys can remain for verification after their signing windows close.

Database TLS verifies the certificate chain and configured hostname. An omitted SSL
flag still requires verified TLS in production; explicit `sslmode` must be `verify-full`.
Insecure or ambiguous URL flags are rejected. Put private CA material in
`HAIP_DATABASE_CA_FILE`, not SSL file parameters in the URL. Keep raw listeners behind
the deployment's TLS proxy and network boundary when opting into wildcard binding.

Generate signing keys through the deployment's key-management procedure. Do not use
the public RFC test seed. Protect configuration files and process environment against
other tenants and app frames. Never send keys, raw credentials or HAIP cookies to an
app, webhook body, review payload, routine log or audit export.

For Clerk OAuth metadata use `HAIP_OIDC_DISCOVERY=oauth2` and
`HAIP_OIDC_CLIENT_AUTH=client_secret_basic`; ordinary OIDC discovery and client-secret
POST remain the defaults. Azure storage uses managed identity, workload identity or
explicit environment credentials through DefaultAzureCredential. Never grant runtime
credentials container policy administration or permission to remove legal holds.

Register the OIDC redirect URI as `<HAIP_ORIGIN>/auth/callback`. Provision each human's
issuer and subject through the operator directory; producer assertions do not establish
human ownership. OIDC identity must map to exactly one enabled directory entry.
Sessions use host-only Secure/HttpOnly cookies, state, nonce, PKCE and CSRF protection.
The login cookie remains `SameSite=Lax` for the provider's top-level GET redirect.
Callback state is bound to the authenticated-cookie state at login start. Starting
another login with the same pending browser cookie replaces its generation; a callback
already exchanging a code must still own that generation when creating the session.
Session retirement and replacement are atomic. Failed login preserves the existing
session, and a pending rotation cannot undo a completed logout. The login endpoint
does not log anyone out merely because it is visited.
Production requires HTTPS and requester/reviewer separation. Do not weaken cookie
flags to run on arbitrary development hostnames; localhost fixtures support them.

To initialise a new isolated tenant, also set `HAIP_BOOTSTRAP_TENANT`,
`HAIP_BOOTSTRAP_OPERATOR` and `HAIP_BOOTSTRAP_TOKEN` generated from at least 32 bytes
from a cryptographically secure random source. Encode it as canonical unpadded
base64url (43 characters for 32 bytes) or hexadecimal (64 characters for 32 bytes),
with a maximum of 200 encoded characters. Short inputs and obvious repeated-byte
fixtures are refused; validation cannot prove that a supplied value is random.
Never use a password or template. Then run:

```sh
node haip-server/dist/main.js --bootstrap
```

No public HTTP bootstrap exists. Remove bootstrap credentials from ordinary process
configuration. The operator can use `PUT /v2/admin/principals/{id}` and
`PUT /v2/admin/routes/{id}` to configure publishers, workload-to-owner mappings,
reviewer pools, approved producers, limits and modes. The [test environment](tests/environment.ts)
is an executable isolated provisioning example. Do not reuse its keys or identities.

Configure wildcard DNS/TLS for sandbox origins, route their listener separately and
preserve the requested Host. Each tenant/publisher/bundle combination derives its own
base-36 DNS label from a SHA-256 digest. Keep sandbox cookies unset. CSP, frame
ancestors, exact message sources and the opaque scripts-only inner frame are mandatory.
The trusted confirmation origin must not be frameable. The static host never interprets
producer text as HTML or Markdown. App code belongs only in the isolated frame.
The trusted host uses `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`.
The sandbox also requires the embedder policy, with `Cross-Origin-Resource-Policy:
cross-origin` to permit its intended embedding; CSP still limits its frame ancestor.
Keep these response headers at the proxy, including on error responses.
`/review/:id` deliberately checks authenticated request visibility before rendering,
returning 404 for an unknown or inaccessible request. This database read derives its
exact sandbox frame policy; a generic inbox page does not need a request lookup.

## Decisions, quotas and notifications

Monitor decision, audit, grant and execution states independently. `pending_anchor`
never permits a claim. Grant time starts at confirmation and continues during outages.
The service's PostgreSQL clock is sampled after the tenant lock; equality is expired.
A receipt saying “approve” on a review-only request grants no execution authority.

Creation is limited by stable producer/tenant identity, route, daily totals, outstanding
work and retained bytes. A maximum response slot is reserved at creation so material
quota exhaustion cannot prevent the first response and confirmation. Further frozen
responses count towards retained bytes, including their idempotent copies. This draft
also bounds proposals to 32 revisions and admission checks to 64 per claim. These are
operational ceilings, not renewable authority. Existing confirmation, cancellation and
outcome reporting do not consume creation quotas.

Read-only admission checks run before large HTTP body parsing; schema compilation and
canonicalisation run outside the tenant lock. Final quota reservations remain atomic.
Request metadata and execution provenance references each fit the captured response
byte limit, 256 KiB by default. Bundle registration uses separate publisher limits of
2/minute (burst 5) and 20/day, and tenant limits of 10/minute (burst 20) and 100/day.
Retained bundles are bounded to 1 GiB per publisher and tenant and count towards their
associated producers' retained storage. Retries cannot reset these limits.

Inbox pages return at most 50 entries with an offset ceiling of 100,000. Visibility and
state filters run in SQL. Status, material, export, event and metrics reads do not take
the tenant write lock; expiry is effective at read time without attributing maintenance
to a reader. The worker persists maintenance in indexed batches of at most 50 requests,
releasing the tenant lock between batches. Operational timestamps are tenant-scoped.

Daily counters use UTC dates and survive request/audit cleanup and credential rotation.
Only prior-day counters are pruned. Migration 003 from earlier drafts conservatively
blocks new requests for existing tenants until the next UTC day, because their deleted
request counts cannot be recovered. Existing review, confirmation and outcomes continue.

SMTP is optional; discovery explicitly reports `polling-only` when absent. Directory
email addresses must be verified and enabled. Ten accepted/attempted SMTP notifications
per recipient per hour are allowed; excess stays queued. A reminder is limited to once
per day and its time carries across supersession. Idempotent retries do not enqueue
another notification. Confirmation and anchoring notify the configured owner without
requiring their original session. SMTP acceptance is not proof of delivery or reading.

In development without an anchor, checkpoint jobs stay pending and execution stays
fenced, but they cannot occupy SMTP/webhook delivery slots. Missing independent storage
is therefore visible without silently stopping ordinary review notifications.

Producer-owned signed events and delivery status are available through polling.
Webhooks use registered HTTPS hosts, public DNS results pinned for the connection,
no redirects and retries for at most 24 hours. Expired queued notifications fail before
any send attempt, including after downtime. Checkpoint publication continues retrying
through notification outages; no grant deadline is extended. Receivers verify the envelope and nested event,
reject deliveries older than five minutes, persist event-ID deduplication before
acknowledgement and ignore stale state revisions. Always fetch authoritative status;
notifications must never directly launch an execution or restore authority. Actual
network paths to deployment receivers still require validation. The isolated HTTPS
receiver tests exercise persistence, duplicate/out-of-order events, exact five-minute
replay rejection and no redirect following. `verifyWebhook` and `PostgresWebhookInbox`
in the SDK verify and commit receipts. A separate consumer reads `haip_status_refresh`,
fetches current authenticated status and marks only the fetched revision processed.
There is no execution callback. `GET /v2/events?after=<cursor>` uses a stable increasing
cursor; save `next` after processing the page. Old events may expire during retention,
so reconcile current request status if a consumer has been offline beyond that period.

## Anchoring, trust and outages

Use a separately administered Azure Blob container with versioning and locked WORM
retention, independent audit readers and restricted writer permissions. Prohibit deletion
and retention/hold removal through independently managed controls. Versioning can allow
new versions despite retention on older ones; the verifier therefore rejects every
replacement or deleted version instead of trusting only the latest content.
The writer must be able to read lock/version metadata and conditionally create the
expected objects, but must not administer retention or the bucket's security boundary.
Verify those RBAC and administrative constraints independently before deployment.

Each audit entry has a signed original, record digest, previous head and next head.
Every event currently queues a checkpoint, which is stricter than five minutes or 100
events. Public checkpoints contain only opaque ledger/generation IDs, sequence, head
and signing metadata. The adapter conditionally creates the object, verifies its exact
version/content and compliance retention for 90 days from the signed checkpoint time.
Conflicting versions or deleted versions fence admission. Identical retries are safe.
If a checkpoint covers more than 50 pending decisions, each transaction processes
one page and persists a 30-second delay before continuing that job. The next page
re-verifies independent storage; a stored acceptance receipt is diagnostic, not
authority. This delay survives worker restart and never renews a grant deadline.

At startup the worker reconciles retained independent checkpoints against local chain
heads. A mismatch blocks execution. A matching retained prefix does not prove that a
lost unanchored tail was complete. Independently retained safety records therefore
bind a tenant to its original ledger, activate each generation for exactly one process,
retire generations permanently, reserve occurrences and fence execution identities.
Safety records contain opaque hashes, use conditional creation and require indefinite
Azure Blob legal holds as well as initial compliance retention. The writer must never
remove holds, delete versions or change container policy/lifecycle.
Do not configure expiration on the safety prefix. Keep these minimal records indefinitely.
A storage outage blocks fresh authority; it never becomes permission to skip checks.

The reference service deliberately supports one active process per generation. Every
restart, second replica or database restoration requires offline recovery before that
generation can be replaced. There is no transparent failover or rolling restart that
preserves old grants. Check the namespace independently for creation, confirmation,
claims and fresh admission; database flags alone cannot reopen it. Existing bounded
permits cannot be retracted, so stop executors before recovery. A test filesystem store
never advertises production suitability or independent administration.

Trust manifests are discovery information, not self-authenticating trust roots.
Distribute trust through a separately authenticated mechanism. Add a new key before
use; preserve old public keys and validity intervals throughout audit retention.
Keys needed to verify permanent safety records must remain available indefinitely,
including their original validity and revocation history. Never
re-sign historical decisions under a new key or profile. Revocation has an explicit
effective time. A compromised key and absent independent historical evidence may make
historical validity indeterminate; a storage timestamp alone does not solve that.

## Retention, reconciliation and restoration

Captured defaults: review 24 hours, grant 24 hours, execution one hour, private
reconciliation seven days and audit 90 days. Execution private material has an absolute
nine-day-and-one-hour cap from acceptance. Its terminal/uncertain outcome can shorten
retention to seven further days but reconciliation can never extend it. Review-only
private material expires at its captured review maximum. Request schema and response
copies are removed with private material; signed commitments survive to audit expiry.

Cleanup performs one bounded pass before opening listeners, then continues after
one second while that pass has unvisited work. Once caught up, it runs every
15 minutes. Retention runs do not overlap. Each call examines at most 500 due
requests per tenant in pages of 50, releasing the tenant lock between pages.
Each of seven housekeeping collections runs once per tenant and changes at most
500 rows; expired sessions are collected once globally in a batch of at most 500.
These limits are per tenant, not a service-wide startup time guarantee.

An unchanged due page cannot loop forever or hide later requests: a cursor skips
inspected rows during the bounded pass. A wholly stalled set ends that pass and is
retried at the ordinary interval, with a deduplicated `retention_stalled` incident.
Investigate the captured record and import provenance; never rewrite signed
deadlines to silence an incident. Reads reject expired private material immediately.
Unused bundles are cleared after 15 minutes when no retained request refers to them.
Early discard invalidates unused grants and prevents fresh permits, including on an
already consumed claim. Already issued permits keep only their original bounded
validity. Audit removal retains chain commitments and permanent occurrence fences,
not expired signed records or response content. Never delete fences to “retry”.

A crash after the local launch fence is potentially effectful. Report `uncertain`
unless independently established evidence supports a stronger outcome. Operator
reconciliation requires a reason and evidence; abandonment never refunds an occurrence.
Further work needs a new linked occurrence and fresh human review. The bounded counter
fixture's local directory must remain durable; do not delete its fence to resume it.

Backups use authenticated AES-256-GCM encryption with a fresh nonce. Keep the raw
32-byte backup key in a separate secret store and set `HAIP_BACKUP_KEY_FILE`. Never
store it with backup files. Rotate backup keys by retaining each required key only for
its remaining backup retention, and record the key version outside the encrypted file.
Set `HAIP_DATABASE_URL` to the source or **empty isolated target**, and optionally set
`HAIP_PG_BIN` to the matching PostgreSQL binary directory:

```sh
node scripts/backup.mjs create /private/backups/snapshot.haipbak
node scripts/backup.mjs prune /private/backups
node scripts/backup.mjs restore /private/backups/snapshot.haipbak
```

Run creation and pruning through your approved operations scheduler; prune at least
daily and alert on failure. `.haipbak` files expire after 30 days. Restore authenticates
the complete encrypted file before passing any bytes to PostgreSQL, refuses non-empty
databases, restores in one transaction and fences every tenant. A temporary plaintext
dump exists only inside a private local directory during authentication/restore and is
removed on exit; use encrypted local storage. Test evidence includes wrong-key and
modified-ciphertext rejection and a real PostgreSQL restore without renewed deadlines.

For **every restart or restoration** of a previously activated production namespace:

1. Stop producers, listeners and all covered executor dispatch. Preserve executor launch
   fences; wait out already issued permits if dispatch cannot be stopped reliably.
2. Restore, if needed, into an isolated empty database. Leave it inaccessible and fenced.
3. Set `HAIP_RECOVERY_TENANT`, `HAIP_RECOVERY_OPERATOR` and a newly generated
   `HAIP_RECOVERY_TOKEN` that is not an old credential. With normal signing, database
   and independent Azure Blob configuration present, run `node haip-server/dist/main.js --recover`.
4. Recovery permanently retires the old generation **before** the database transaction,
   reconciles independent checkpoints, deletes all restored private material and cached
   response copies, disables every old identity/credential, empties route membership and
   records a fresh generation. This conservatively reapplies all possible missing
   deletions/revocations. Retained original signatures remain historical; missing outcomes
   remain uncertain. Failures leave admission blocked, and recovery may be retried.
5. Start the service, which independently activates the unused new generation. Use the
   fresh operator credential to reprovision identities, machine credentials and routes.
   Further execution needs a new occurrence, new material and new human confirmation.
   Old occurrences, execution identities, generations and grants never become reusable.

Repeat recovery for each previously activated tenant before opening listeners. New
tenants should be bootstrapped before the first start. Do not switch the independent
bucket/prefix or issuer to bypass a retirement. A genuinely conflicting or tampered
independent history requires incident investigation; a matching prefix is reported as
such, never as proof of a complete history. Database restoration while a process is
serving traffic is unsupported and unsafe; stop it first.

Production startup refuses to open either listener while any tenant remains fenced
after reconciliation. This also prevents restored credentials from reading private
material before the required recovery and reprovisioning procedure has run.

## Plasm boundary and incident response

HAIP does not implement Plasm contexts, credentials, continuations, runtime scheduling
or execution evidence. The [draft Plasm profile](protocol/draft-2.0.0-2/plasm-profile.md)
is a set of integration requirements, not an advertised capability. Changes require
upstream acceptance and hosted-product coordination. No renderer licence is changed by
bundle registration; this distribution does not vendor external agent UI renderers.

A future live-window deployment must route to the originating process. Restart,
context loss or another replica must refuse resumption. A future durable integration
must reconstruct retained catalogues and symbols without discovery or an LLM, and
check credential generations, destinations, policy content and catalogue withdrawal.
These guarantees are not supplied by HAIP signatures alone.

Monitor request volume, per-reviewer pressure, pending age, notification failures,
claim conflicts, uncertain outcomes, identity/policy failures and stalled checkpoints.
Use `GET /v2/admin/ledger` for scoped audit investigation and request status for delivery
failure codes. `GET /v2/admin/metrics` supplies scoped JSON and
`GET /v2/admin/metrics.prom` supplies Prometheus text. Both require the tenant operator
credential. HTTP counters reset on process restart; queue and incident gauges are
persisted. Alert immediately on admission fencing, any delivery failure or unresolved
anchor incident; alert when pending checkpoint age exceeds five minutes, retention
success is older than 30 minutes, or unresolved execution exceeds its captured window.
Monitor reviewer pressure against local staffing expectations. Policy and executor
signing/storage failures belong to the external executor's monitoring, not HAIP's
process counters. The checked-in alert examples need deployment routing. Never
include response contents or credentials in alerts. On an anchoring or evidence
incident stop admission/dispatch; rollback must preserve refusal, not restore automatic
approval or whole-plan replay.
