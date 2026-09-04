# HAIP review contract — 2.0.0-draft.2

Status: draft. This immutable identifier names the adjacent JSON Schema and OpenAPI
3.1 contract. HAIP is independent of Node, PostgreSQL, Plasm and agent frameworks.
The reference service is an implementation, not part of protocol identity.

A producer authenticates with a separately provisioned bearer credential. A human
uses OIDC through the trusted host. Resource links locate requests; possession never
authorises access, confirmation or execution. Every lookup is tenant- and owner-scoped.
Publishers can register their own immutable bundles but cannot read review payloads.
Operators bind producers to publishers, verified owners, routes and delivery destinations.

Requests select an exact protocol revision, immutable purpose and required profile
versions. Unsupported selections fail without downgrade. Producers cannot edit
reviewer pools, lower separation requirements or nominate identities as verified.
The accepted request binds the route's authorisation revision, directory-resolved
requester, digests, captured limits and absolute deadlines. Producer metadata is
preserved in the signed request commitment and has no authorising meaning.

`review` obtains an authenticated response. `authorise_execution` additionally requires
the execution extension. No answer, approval text, app message or review receipt can
upgrade purpose. Execution needs a new execution request and explicit human authorisation.

The producer retains artefact digest format provenance. Review payloads and schemas
use SHA-256 over RFC 8785 JCS; the plain static review document and app HTML use
SHA-256 over their exact UTF-8 bytes. This document is a canonical representation
of reviewed material, not a record of exact pixels or human understanding. Plasm's
native semantic and catalogue digests are never replaced with JCS digests.

The host validates the stored response schema and freezes a candidate. It displays
that exact candidate, including the execution authorise/refuse choice, before human
confirmation. Confirmation rechecks identity, eligibility, requester separation,
current candidate and time, then records one signed receipt atomically. Candidate
changes invalidate old confirmation. Review claims are assignment leases only.

The JSON boundary rejects duplicate keys, invalid UTF-8/Unicode, non-finite numbers,
unsafe integer values and decimals that lose their declared precision when converted
to binary64. Valid decimals such as 0.1 are canonicalised independently. Higher
precision uses schema-defined strings. Remote schema references, executable producer
HTML/Markdown in trusted surfaces, and prototype-dependent parsing are forbidden.
The initial reference schema profile also excludes regular expressions and formats
in producer schemas to bound untrusted validator behaviour.

Signed records cover a protected header and payload using Ed25519 over RFC 8785.
The header protects record type, protocol revision, purpose, profile selection,
issuer, audience, tenant, key identifier and issuance time. The signature field is
excluded from its own preimage. Preserve original signed objects and exact canonical
response bytes. Trust keys are configured independently; discovery is not trust.

The decision, audit anchoring, grant and execution states are separate. Review-only
responses are readable while anchoring is pending, with grant and execution always
`not_applicable`. Notifications and at-least-once events are advisory: recipients
persist, deduplicate and fetch authoritative status. No email, app or webhook can
confirm or execute. SMTP acceptance says nothing about delivery or reading.

Idempotency is scoped to tenant, stable principal and operation. Identical retries
with the same key return the recorded result; changed input conflicts. Supersession
creates a new request atomically, invalidates candidates and unused authority, and
preserves history. It cannot retract an issued permit or reuse a consumed occurrence.

See `security.md`, `evolution.md`, `execution.md` and the executable HTTP fixtures.
The implementation ledger, not this draft's existence, determines completed release gates.

## Agent UI profile (`haip.agent-ui: "1"`)

A request may reference a registered bundle whose compatibility is `agent_ui: "1"`. The
authenticated reviewer's host then serves `StoredApp`: the exact bundle bytes, the
sandbox origin and scope, the complete `input` and `result` snapshots, and an
`AgentUiEnvelope` identity — request id, digest, purpose, authorisation revision and
supersession; bundle id, publisher, digest and registration time; tenant, producer,
verified requester and configured origin; snapshot digests — committed by
`binding_digest` (SHA-256 over the RFC 8785 canonical identity). The host verifies the
binding before creating a View and returns the envelope in the `haip/ui.initialize`
result. The View may only `haip/ui.propose` a `DecisionProposal`; confirmation,
authority and execution remain with the trusted host. Message shapes are the
`AgentUi*` definitions; the normative behaviour is the Agent UI profile document.

