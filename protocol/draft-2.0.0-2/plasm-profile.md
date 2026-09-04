# Plasm execution profile — draft requirements

The Plasm profile is not advertised as supported by the HAIP reference service until
its live-window integration passes the required gates. Current implementation status
is recorded in the ledger. This document preserves the integration requirements;
it is not a claim of completed delayed execution.

Plasm owns enforcement, frozen context, retained catalogues, continuation storage,
dispatch accounting and evidence. The hosted product owns tenant configuration and
existing identity/control-plane boundaries. HAIP does not copy the engine to avoid
integration. Preserve native semantic composition version 1, review reflection 3
and flow reflection 2, native semantic/catalogue hashes and original references.

Live-window capture must own the typed plan, exact symbols, effective catalogues and
overlays, copied inputs/bindings, destinations, policy fingerprint, ownership and
already-issued credentials. Never clone locks over mutable credentials. Resolve or
refresh before capture, then disable refresh. Public access has explicit empty
credentials. Static and issued OAuth/session tokens are frozen, with known expiry
honoured and unknown expiry disclosed. Preserve a random process identity; commit,
session, credential and route deadlines cap authority. Lost context, restart, eviction
and another replica cannot reconstruct a live approval from Redis or ordinary commits.

Durable mode is preferred for supported public or managed static connections, with
stable identities, increasing generations and private HMAC fingerprints. A route
requiring durable mode cannot fall back to live. Store one AES-256-GCM capsule per
continuation, fresh nonces and associated data binding tenant, producer, identity and
format. Versioned encryption keys stay outside PostgreSQL. Never serialise full
sessions or raw credentials. Capsules retain exact catalogue bytes, owners, base and
effective hashes, overlay scope, symbols, normalisation anchors, compiler formats,
policy and route bindings. Reconstruct without discovery, current catalogue lookup,
symbol allocation or an LLM; repeated reconstruction must yield identical material,
native semantic digest and versioned context digest.

Preserve `plasm(logical_session_ref, program)` and
`plasm_run(logical_session_ref, run_ref)`. Add an opaque owned durable run reference,
resolved before ordinary session expiry rejection. Return typed pending HTTP 202 with
review link, mode and deadline. Reinvocation returns status or recorded results and
never launches consumed work again. Webhooks only notify and never call `plasm_run`.

At both plan and parsed-line entry points, missing policy/principal state blocks.
Configured failures never mean inactive policy. Bind policy content as well as its
numeric revision. Deny cannot be overridden. Approval requires a privately constructed
permit backed by verified HAIP records. One effect classifier covers nested plans,
HTTP, MCP, CLI, workflows, resolved plans and force/wait paths. Freeze credential and
destination selection through all nested execution; validate compiled absolute URLs,
pagination and redirects without credential forwarding to unapproved destinations.

After queueing, obtain a permanent exclusive claim and fresh admission. Check clocks,
persist original records and signed evidence before one launch fence, then track each
attempt under one monotonic execution window. Stop scheduling at expiry and reconcile
ambiguous attempts, including dropped parallel futures. Effectful/unknown whole-engine
write-conflict retries are forbidden even outside HAIP. Reads may consume admission
validity; cancellation does not prove no external effect.

Evidence schema 3 adds `ApprovalBound` between `CompCommitted` and `StepExecuted`.
Bind request, receipt, claim, admission, identity and semantic/context digests. Protected
runs require signing and durable prefixes before dispatch. Offline `--require-approval`
verification must reject wrong purpose/profile, untrusted/missing signatures, changed
bindings and approval after execution. Legacy unsigned schema-2 evidence is never
execution approval. A signed prefix does not prove completion.

Capsule limit: 64 MiB including catalogues; active retained material 5 GiB per producer.
Review/grant defaults 24 hours each, execution one hour, reconciliation seven days,
unpublished capture fifteen minutes, audit ninety days, encrypted backups thirty days.
The private hard cap is maximum review + grant + execution + reconciliation: nine days
and one hour by default. Reads, retries and reconciliation never extend it. Cleanup is
every fifteen minutes, with immediate expiry rejection and durable consumed fences.

Restoration disables claims/dispatch, reconciles independent checkpoints, retires the
old namespace and reapplies deletion/revocation before admission. Rollback must block
protected execution if its guarantees are unavailable. Sticky routing is required for
live-window approvals; transparent failover cannot recover lost memory safely.
