# Deployment acceptance record — not run

Local evidence is in `ACCEPTANCE.md`. The following work needs an explicitly approved
isolated deployment, independently administered storage and a real identity application.
No cloud account, subscription, deployment or external mutation is authorised by this
document. Prefer existing/free infrastructure; obtain approval before any paid service.

Record exact service/package hashes, provider region, configuration revision, test
identity roles, independent administrator, UTC times and original signed outputs.
Do not put secrets, tokens or private review material in the evidence collection.

| Check | Required evidence | Current result |
|---|---|---|
| Origins and TLS | Trusted host and wildcard App domains resolve separately; secure sessions remain host-only; framing and unexpected Host/source refusals | Unrun |
| External identity | Exact issuer/subject mapping, callback, PKCE/state/nonce, Basic or POST client authentication, session rotation/logout and prohibited self-review | Unrun; local OIDC cases pass |
| Writer permissions | Read/list/version properties and conditional creation work; writer cannot delete retained/safety data, remove holds or administer retention/account policy | Unrun |
| Immutable storage | Exact returned version has Locked retention at least 90 days; safety record additionally has legal hold; no automatic expiry on safety prefix | Unrun |
| Duplicate/conflict | Identical checkpoint retry recovers original version; changed content at one sequence refuses; extra/deleted versions fence admission rather than hiding older versions | Unrun; adapter fixtures pass |
| Outage and expiry | Storage outage blocks new claims/permits; retries cannot move grant deadline; recovery after expiry never revives authority | Unrun on Azure; local cases pass |
| Backup recovery | Encrypted dump of isolated tenant restored to empty database; independent records remain outside backup; retire generation and reapply deletion/revocation before opening listeners | Unrun on deployed storage; local restore passes |
| Notifications | Test recipient receives ordinary link after session ends; receiver persists/deduplicates and fetches authoritative status; expired delivery and redirects refuse | Unrun on deployment paths; local SMTP/TLS cases pass |
| Operations | Independent keys/trust, encrypted disk, private backup storage, pruning at most 30 days, worker/retention alerts and incident routing | Uninstalled examples |
| Restart/rollback | Previously activated generation cannot open production listeners; recovery needs fresh provisioning/review; rollback never enables automatic execution | Local implementation; deployed rehearsal unrun |

Azure permits some creation of newer blob versions while older versions remain locked.
Do not treat retention alone as preventing replacement. The adapter deliberately fails
on multiple/deleted versions; confirm this behaviour using a disposable isolated test
namespace and an independently supervised conflict injector. Never weaken runtime
permissions or production retention to make a test pass.

R2 backup integration and a Vercel deployment are not implemented. R2 remains a
candidate for private, client-encrypted backup objects with bounded deletion. Its
removable bucket locks are not an irreversible audit substitute. Clerk compatibility
is through standard OAuth/OIDC, not an embedded browser SDK or a provisioned account.
