# Agent UI proposal review

Review target: [HAIP PR #6](https://github.com/haiprotocol/haip/pull/6), based on [`c02bf33`](https://github.com/haiprotocol/haip/commit/c02bf330324b0ec8385a8438d112c258caec6161). Proposed UI contract: [`haip-agent-ui-profile.md`](haip-agent-ui-profile.md). Renderer options: [`protocol-compatibility.md`](protocol-compatibility.md).

Status: technical review of a draft proposal. This record does not approve a renderer
architecture or amend the published HAIP draft.

## Scope

The proposal defines a native HAIP Host/View protocol for rendering untrusted, agent-sourced approval material inside a Host-controlled sandbox. The proposed messages are not MCP methods and claim no MCP conformance.

The proposal is narrower than the full approval contract. The complete request and bundle envelope, human confirmation, authorisation, admission and execution rules remain HAIP responsibilities outside the View. The model covers selected lifecycle and message rules, not the complete HTTP service or Plasm integration.

## Requirements

1. The Host verifies one immutable envelope covering the request, bundle, producer, agent
   system, tenant, origin and frozen snapshots before loading View code.
2. The View runs with an opaque origin, scripts only and a fixed deny-all policy that
   producer metadata cannot widen.
3. Browser messages match the exact expected `WindowProxy` and, where present, the exact
   configured origin.
4. Only the messages declared by the selected versioned profile cross the View boundary.
5. `haip/ui.propose` may submit a schema-valid candidate. It confers no confirmation,
   authorisation or effect.
6. Controlled teardown is correlated. A crash or reload discards unconfirmed View state,
   and trusted native controls remain available.
7. Accepted requests retain their selected profile and bindings during offline
   verification and migration.

## Coverage

The Quint package checks proposal, confirmation, authority and effect separation along with selected Host/View lifecycle cases. Browser tests cover message ordering, source and origin checks, limits, reload, fallback and frozen candidates. The [verification record](model-check-results.md) states the model bounds and does not claim full wire conformance.

## Open work

PR #6 replaces the base Portable MCP App path with the native proposal. The renderer choice and new immutable prerelease/profile identity require maintainer decisions. The missing complete envelope and JSON-RPC message schema is a demonstrated contract gap if the native option proceeds.
