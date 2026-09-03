# Protocol review

Review target: [HAIP PR #6](https://github.com/haiprotocol/haip/pull/6), based on [`c02bf33`](https://github.com/haiprotocol/haip/commit/c02bf330324b0ec8385a8438d112c258caec6161). Normative profile: [`agent-ui.md`](../../../protocol/draft-2.0.0-3/agent-ui.md). Review mapping: [`haip-agent-ui-profile.md`](haip-agent-ui-profile.md). Renderer decision record: [`protocol-compatibility.md`](protocol-compatibility.md).

Status: technical review of the native profile selected by [decision #7](https://github.com/haiprotocol/haip/issues/7) for `2.0.0-draft.3`.

## Scope

The profile defines a native HAIP Host/View protocol for rendering untrusted, agent-sourced approval material inside a Host-controlled sandbox. Its messages are not MCP methods and claim no MCP conformance.

The profile is narrower than the full approval contract. The complete request and bundle envelope, human confirmation, authorisation, admission and execution rules remain HAIP responsibilities outside the View. The model covers selected lifecycle and message rules, not the complete HTTP service or Plasm integration.

## Requirements

1. The Host verifies one immutable envelope covering the request, bundle, producer, tenant, requester, origin and frozen snapshots before loading View code.
2. The View runs with an opaque origin, scripts only and a fixed deny-all policy that producer metadata cannot widen.
3. Browser messages match the exact expected `WindowProxy` and, where present, the exact configured origin.
4. Only the messages declared by the selected versioned profile cross the View boundary.
5. `haip/ui.propose` may submit a schema-valid candidate. It confers no confirmation, authorisation or effect.
6. Controlled teardown is correlated. A crash or reload discards unconfirmed View state, and trusted native controls remain available.
7. Accepted requests retain their selected profile and bindings during offline verification and migration.

## Coverage

The Quint package checks proposal, confirmation, authority and effect separation along with selected Host/View lifecycle cases. Browser tests cover message ordering, source and origin checks, limits, reload, fallback and frozen candidates. The [verification record](model-check-results.md) states the model bounds and does not claim full wire conformance.

## Outcome

The immutable `2.0.0-draft.3` and Agent UI profile 2 identities, verified envelope, discriminated JSON-RPC message schema and `@haip/view` client were reviewed in PR #6 and merged into `l/haip-2`. `2.0.0-draft.2` and profile 1 remain unchanged as history. HAIP owns the profile, client and conformance fixtures. The separate renderer acknowledgement was withdrawn. HAIP assigns no external renderer work and does not depend on an external port. Any external integration is independent and carries its own acceptance tests.
