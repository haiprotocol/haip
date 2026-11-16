# Vercel and Neon

Status: planned, 3 November 2026. Use the existing Vercel Pro and Neon accounts. This replaces the proposed Azure VM as the hosting target. The current `2.0.0-draft.3` reference service is not compatible with this target without implementation changes. This plan creates no provider resources, changes no DNS records and publishes no packages.

HAIP owns this work. Plasm integration, execution enforcement in downstream products and durable agent continuations remain outside its scope. Retain the reviewed protocol, cryptography, native Agent UI and reference-service boundaries.

## Shape

| Component | Target | Separation |
| --- | --- | --- |
| Trusted review and API | Node 24 functions in a dedicated HAIP Vercel project | Server-side identity, signing and authority checks |
| View bootstrap | A separate HAIP Vercel project | Trusted wrapper assets only, with no database, signing or identity credentials |
| Database | A dedicated HAIP Neon project in the existing account | Isolated roles and production data, with separate staging |
| Outbox and retention | Vercel Workflows with bounded reconciliation jobs | Durable delivery claims and retries, with no permanent polling loop |
| Human identity | Existing San Digital Entra tenant | Exact issuer, subject and callback, with HAIP-controlled roles |
| Audit and recovery | Separate locked Azure checkpoint and safety containers | Restricted federated runtime identity and separate administration |
| Backups | Encrypted exports in private storage with bounded retention | Encryption key held separately, restoration into an empty isolated target |
| Notifications | A verified existing relay or a reviewed delivery adapter | Real recipient and incident route selected before acceptance |

Vercel [supports Express as a function](https://vercel.com/docs/frameworks/backend/express), so keep the existing HTTP application and native browser UI where possible. A framework rewrite is outside this plan. Extract the existing sandbox wrapper from its `ReviewService` dependency because its route uses only the configured trusted origin, scope mapping and built assets. Producer HTML remains inside the opaque inner frame under the current handshake and confinement checks.

Suggested production names remain `review.haiprotocol.com` and `*.haip-view.over.show`. They require different registrable sites. Confirm ownership and the DNS administration surface before configuring them. Vercel documents [delegating the scoped certificate challenge](https://vercel.com/docs/domains/working-with-domains/add-a-domain#use-wildcard-domains-with-an-external-dns-provider), allowing the current DNS provider to retain the rest of the zone. Review the effect on other certificate issuers before making that delegation. Use the exact routing values supplied for the HAIP projects.

## Budget

Keep additional HAIP spending within the existing £20 monthly ceiling and target the lowest practical incremental cost. The existing Vercel Pro subscription is already paid. Its [platform fee and usage credit](https://vercel.com/docs/plans/pro-plan) apply to the team, and partner resources have separate charges. Use the existing deploying seat if appropriate. Do not add another paid team or seat as a deployment shortcut.

Inspect the actual Neon organisation plan before choosing a project. [Free and paid Neon plans](https://neon.com/pricing) have different billing rules. Paid-plan usage starts billing without the Free plan allowance. Record compute size, idle suspension, storage, transfer, branch retention and the HAIP project estimate. Set a conservative compute ceiling and use synthetic staging data. Do not attach HAIP to another application's database or change its roles, size or availability settings.

Avoid one-second polling and frequent empty scheduled runs. Each database query can keep Neon compute active. Send work promptly when a committed outbox entry is created, then use sparse reconciliation to recover missed dispatch. Measure whether that schedule permits Neon to sleep. [Workflow events, written data, retained data and function execution](https://vercel.com/docs/workflows/pricing) must all be included in the estimate using the actual Pro allocation.

Track the HAIP projects separately. Shared team spend controls can affect other applications, so do not change them to enforce HAIP's budget. Use HAIP-specific alerts and admission limits, record retained evidence costs and suspend new HAIP work before the forecast reaches the ceiling. Document any cost control that only alerts rather than stopping charges. A free allowance is not a completed cost acceptance exercise.

## Compatibility

Resolve these decisions before building a production deployment adapter. Record the chosen design, its security assumptions, the affected contract and evidence from failure exercises.

| Decision | Current constraint | Required result |
| --- | --- | --- |
| Authority | `RecoveryGuard` permanently binds a generation to one process owner | Durable coordination that tolerates function suspension, concurrency and replacement while refusing stale generations and restored authority |
| Payloads | HAIP supports 5 MiB bundles and 10 MiB payloads | A verified transport for valid maximum-size inputs and outputs, including generic HTTP clients |
| Storage access | The Azure template denies traffic outside approved network sources | A costed, approved route from Vercel with restrictive identity and network controls |
| Request handling | The service needs raw JSON, worker isolation and shared admission limits | Verified Node 24 execution with byte-preserving parsing, bounded schema work and atomic admission across instances |
| Origins | Trusted and sandbox listeners have separate browser policies | Exact Host routing, distinct sites, wildcard TLS and the intended headers on success and failure paths |

Changing the process owner to a fixed shared value or disabling recovery checks would remove a safety property. The [managed authority design](managed-authority.md) uses an independent commit witness to distinguish a clean function replacement from a database restore or a failed commit. Its local PostgreSQL proof exercises stale and competing copies. The application must use the witness for all protected state and operations before it can replace process ownership. Routine function replacement must not recreate grants, extend deadlines or repeat an uncertain effect.

Vercel's [function request and response limit is 4.5 MB](https://vercel.com/docs/functions/limitations#request-body-size). A larger function bundle or longer timeout does not increase that limit. Review a private staged-upload transport and streamed output, or another compatible ingress path, then prove authentication, ownership, size, digest, expiry and cleanup. Do not accept arbitrary fetch URLs or expose staging objects publicly. A new transport that changes the HTTP contract needs a labelled protocol revision, SDK and CLI support, independent-client vectors and updated acceptance. Lowering HAIP's documented limits does not preserve draft-3 compatibility.

For storage, [Vercel OIDC federation with Azure](https://vercel.com/docs/oidc/azure) provides a route to short-lived credentials. Bind federation to the exact HAIP project and environment, inject the credential into the Azure adapter and keep administrator credentials outside Vercel. Authentication and network access require separate checks. The current storage firewall denies unlisted sources, while Vercel lists [static egress IPs at US$100 per project per month](https://vercel.com/pricing), beyond this budget. Resolve this access decision without purchasing that addon or silently opening the storage firewall.

The network candidate is a narrow Azure Flex Consumption function in UK South. Vercel would authenticate to its API using a federated Entra workload identity. The function would reach the storage account through [regional virtual network integration](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options#regional-virtual-network-integration-outbound) and use an Azure managed identity with the existing add and read role. Limit the relay to exact evidence operations, independently configured containers, verified signed objects and bounded input. The function endpoint needs its own ingress authentication and request limits. Do not relax the storage firewall. UK South appears in the subscription's Flex region list. The [on-demand free grant](https://azure.microsoft.com/en-us/pricing/details/functions/) is shared by the subscription, so cost the host storage, evidence operations and network separately and check available quota before provisioning.

Keep raw request bytes available for strict JSON, duplicate-key and UTF-8 checks. Verify worker-thread packaging, memory and termination limits against the deployed Node runtime. Move security-relevant process-local rate limits to shared atomic admission. Cache only disposable clients and immutable configuration in function instances. Bind signing and verification to the configured issuer, independent of instance reuse.

## Delivery

Deliver the work in this order, with each change reviewed and tested before its dependent work proceeds.

| Step | Work | Completion evidence |
| --- | --- | --- |
| 1. Prove compatibility | Resolve the five decisions above, including the authority and large-payload designs | Reviewed design, failure exercises, provider feasibility and a cost estimate within scope |
| 2. Split entrypoints | Separate handler creation, bootstrap, migration, recovery and worker startup | Importing a handler performs no migration, generation activation or background loop |
| 3. Add database adapter | Configure Neon pooling, direct administrative jobs and restricted roles | Real Neon transaction, TLS, connection reuse, timeout and quota checks |
| 4. Add scheduled work | Dispatch committed outbox jobs through Workflows and bound retention and reconciliation | Durable retry, duplicate delivery, crash and missed-dispatch evidence |
| 5. Package environments | Configure the two Vercel projects, identity, storage access, domains and staging | Reviewed configuration and exercised browser, secret and environment boundaries |
| 6. Run acceptance | Complete provider tests, independent assurance and the versioned release record | All applicable deployment checks pass against the final source and deployed artefact |

Steps 2 to 5 depend on the decisions in step 1. Keep the existing standalone runtime available for local conformance and comparison. If wire semantics or normative guarantees change, add a new immutable draft and update schema, types, OpenAPI, clients, formal models and labelled documentation. Preserve `draft-2.0.0-3` and its historical evidence. This planning change leaves package versions untouched.

## Database

Retain `pg` and transaction-scoped advisory locks unless the compatibility exercise identifies a reason to change them. Neon recommends [pooled runtime connections and direct administrative connections](https://neon.com/docs/connect/connection-pooling). Verify `SET LOCAL`, database time after lock acquisition, conditional claims and read-only transactions through the selected pool. Session locks and process-local coordination are unsuitable substitutes.

The local Neon adapter selects these endpoints with `HAIP_DATABASE_PROVIDER=neon` and `HAIP_MODE=production`. Set `HAIP_DATABASE_URL` to the pooled runtime URL or the direct operator URL for offline commands. Use `sslmode=verify-full` without extra URL flags. The adapter verifies the public certificate and exact hostname. It caps each runtime pool at three connections with an eight-second connection timeout. The shared admission option keeps its counters in PostgreSQL by atomic bucket and principal key. A failed counter write rejects the request. The existing standalone runtime still uses its in-process request limiter. Review an edge traffic limit before enabling shared counters on a public host, since unauthenticated traffic reaches the shared database counter.

Replace the fixed per-instance pool size with reviewed limits that account for function concurrency. Release checked-out clients on success, timeout and cancellation. Use a separate migration role and a direct connection in a controlled job, then exercise the runtime role's refusal of schema administration. Use direct connections for encrypted dump and restore tooling. Neon branches and provider point-in-time recovery do not replace HAIP's independent records or its authority recovery procedure.

Choose matching Vercel and Neon regions where available, with London as the first candidate. Record actual residency, failover behaviour and any cross-region path. Staging and production need separate credentials, trust manifests, issuers, callback URLs and evidence namespaces. Preview code receives neither production secrets nor access to production evidence, and previews use synthetic data rather than branches containing production review material.

Run migration, encrypted export and offline recovery tools in controlled jobs with the required PostgreSQL binaries. Protected GitHub Actions jobs are the first candidate. Scheduled backup jobs receive a restricted database reader and access only to the mutable private backup store. Keep recovery and administrator authority in a separate manual procedure. Resolve each runner's storage network path through the compatibility decision above, and avoid storing database exports in public build artefacts.

## Background work

Keep the database outbox as the durable record. Commit the outbox entry before attempting external dispatch. Use a stable job identity and the stored delivery generation when scheduling a Workflow. If dispatch acknowledgement is lost, reconciliation may dispatch the same job again. A Workflow retry must re-check the live destination, claim, generation, consent and original deadline before delivery.

The local worker can now run a single job identified by its UUID and report its persisted retry time. A reconciliation page covers five tenants and returns at most ten ready IDs per tenant, using the existing tenant index. The optional dispatch callback receives up to 64 IDs after a confirmed database commit and waits at most two seconds for acknowledgement. A missed callback, failed dispatch or remaining IDs stay in the outbox. This interface has local database coverage. The Vercel Workflows binding and hosted failure exercise remain outstanding.

Refactor worker entrypoints to process bounded tenant/job batches within an invocation deadline. Schedule stored backoff and continuation rather than sleeping inside a function. Keep network waits outside database locks and preserve the absolute SMTP and webhook deadlines, DNS pinning, redirect refusal and signed envelopes. A `waitUntil()` callback alone does not establish durable delivery. Workflow retries do not establish exactly-once effects.

Use Workflow arguments containing opaque identifiers and configuration revisions. Keep review content, response bodies, credentials, signed grants and tokens out of job arguments and provider logs. Step results contain only safe job status. Enforce retention on Workflow state and logs separately from HAIP's database cleanup. A retry performs current authorisation checks and does not replay a cached permission decision.

Checkpoint dispatch must be prompt after confirmation because the grant clock keeps running while storage acceptance is pending. Reconciliation recovers missing work but does not pause or renew authority. Expiry remains enforced on every relevant API path even when a scheduled cleanup is late. Record stalled work, delivery failures and missed reconciliation in tenant-scoped metrics and test the incident route.

## Browser and identity

Preserve the native trusted confirmation, frozen candidate, complete digest display, sandbox handshake, exact message source and origin checks, confinement preflight and renderer-loss refusal. Test CSP, connection allowlist, COOP, COEP, CORP, host-only cookies and error responses through Vercel's actual routing. Unexpected Hosts and public deployment aliases must not expose authenticated review data. Custom HTML remains unavailable when browser confinement is unproven, with the native review path available according to the current contract.

Keep Entra's server-side OIDC flow, state, nonce, PKCE and CSRF protections. Configure the exact HAIP callback and bind roles to verified issuer and subject. Test sign-out, session rotation, concurrent login and refusal of self-review using distinct real identities. Vercel dashboard access and preview protection do not replace HAIP's own authentication. Selecting Vercel does not require a Clerk migration.

## Acceptance

Keep [deployment and recovery acceptance](https://github.com/haiprotocol/haip/issues/10) and [independently accountable assurance](https://github.com/haiprotocol/haip/issues/11) open until their evidence is supplied. Update the [acceptance runner and adapters](acceptance.md) to bind the selected runtime profile, actual Vercel deployment IDs, Neon project and branch revisions, configuration, trust and source artefact digests. A new protocol revision also requires the runner's current draft-3 check to be updated through review.

Exercise simultaneous function instances, cold starts, termination during a claim, lost database and storage acknowledgements, duplicate Workflow delivery, Neon suspension and reconnection, restored snapshots, unanchored deletion and revocation, and overlapping old and new deployments. Prove refusal of stale authority, cross-tenant access, cross-environment credentials and repeated uncertain effects. Repeat maximum-payload and hostile-browser cases through the deployed network path.

Exercise encrypted export and restore into an empty isolated Neon target, then the reviewed authority recovery procedure before enabling mutations. Vercel code rollback and Neon snapshot restore are separate operations. Neither may silently roll back authority, revive credentials or enable an older execution namespace. Test schema compatibility and version refusal before documenting a release rollback procedure.

The deployment record still needs the Vercel team and project IDs, Neon organisation and new project details, selected regions, controlled domains, OIDC application, test identities, storage administrator path, evidence network route, notification recipient and incident destination. These are deployment inputs. Their absence does not prevent reviewing this implementation plan.
