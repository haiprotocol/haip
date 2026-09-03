# Review contract

Status: `2.0.0-draft.3`. This immutable identifier names the adjacent JSON Schema and OpenAPI 3.1 contract. HAIP is independent of Node, PostgreSQL, Plasm and agent frameworks. Protocol identity comes from these contracts rather than the reference service implementation.

A producer authenticates with a separately provisioned bearer credential. A human uses OIDC through the trusted host. Resource links locate requests. Possession does not authorise access, confirmation or execution. Every lookup is scoped to the tenant and owner. Publishers can register their own immutable bundles but cannot read review payloads. Operators bind producers to publishers, verified owners, routes and delivery destinations.

Requests select an exact protocol revision, immutable purpose and required profile versions. Unsupported selections fail without downgrade. Producers cannot edit reviewer pools, lower separation requirements or nominate identities as verified. The accepted request binds the route's authorisation revision, directory-resolved requester, digests, captured limits and absolute deadlines. Producer metadata is preserved in the signed request commitment and has no authorising meaning.

`review` obtains an authenticated response. `authorise_execution` also requires the execution extension. No answer, approval text, View message or review receipt can upgrade purpose. Execution needs a new execution request and explicit human authorisation.

The producer retains artefact digest format provenance. Review payloads and schemas use SHA-256 over RFC 8785 JCS. The plain static review document and View HTML use SHA-256 over their exact UTF-8 bytes. The static review document is a canonical representation of reviewed material rather than a record of exact pixels or human understanding. Plasm retains its native semantic and catalogue digests.

The host validates the stored response schema and freezes a candidate. It displays that exact candidate, including the execution authorise/refuse choice, before human confirmation. Confirmation rechecks identity, eligibility, requester separation, current candidate and time, then records one signed receipt atomically. Candidate changes invalidate old confirmation. Review claims are assignment leases only.

The JSON boundary rejects duplicate keys, invalid UTF-8/Unicode, non-finite numbers, unsafe integer values and decimals that lose their declared precision when converted to binary64. Valid decimals such as 0.1 are canonicalised independently. Higher precision uses schema-defined strings. Remote schema references, executable producer HTML/Markdown in trusted surfaces, and prototype-dependent parsing are forbidden. The initial reference schema profile also excludes regular expressions and formats in producer schemas to bound untrusted validator behaviour.

Signed records cover a protected header and payload using Ed25519 over RFC 8785. The header protects record type, protocol revision, purpose, profile selection, issuer, audience, tenant, key identifier and issuance time. The signature field is excluded from its own preimage. Preserve original signed objects and exact canonical response bytes. Trust keys are configured independently. Discovery supplies metadata without establishing trust.

The decision, audit anchoring, grant and execution states are separate. Review-only responses are readable while anchoring is pending, with grant and execution always `not_applicable`. Notifications and at-least-once events are advisory: recipients persist, deduplicate and fetch authoritative status. No email, View or webhook can confirm or execute. SMTP acceptance says nothing about delivery or reading.

Idempotency is scoped to tenant, stable principal and operation. Identical retries with the same key return the recorded result. Changed input conflicts. Supersession creates a new request atomically, invalidates candidates and unused authority, and preserves history. It cannot retract an issued permit or reuse a consumed occurrence.

See `security.md`, `evolution.md`, `execution.md` and the executable HTTP fixtures. The implementation ledger records which release gates are complete.

## Agent UI

A request may reference a registered bundle whose compatibility is `agent_ui: "2"`. The authenticated reviewer's host then serves `StoredApp` with the exact bundle bytes, sandbox origin and scope, complete `input` and `result` snapshots, and an `AgentUiEnvelope`. The envelope binds the request identity, bundle identity, authenticated producer acting as the agent system, operator-resolved human requester, configured origin and snapshot digests. `binding_digest` provides a SHA-256 consistency check over the RFC 8785 canonical identity. The server verifies the persisted request material and exact bound bundle before constructing this transient envelope. The browser host recomputes the digest before creating a View and returns the envelope in the `haip/ui.initialize` result. The View may only send a `DecisionProposal` through `haip/ui.propose`. Confirmation remains with the trusted host. A confirmed response has only the authority allowed by the request purpose, and execution remains external. The `AgentUi*` definitions specify each message shape, while [`agent-ui.md`](agent-ui.md) specifies profile behaviour.
