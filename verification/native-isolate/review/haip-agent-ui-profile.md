# Agent UI review

Status: non-normative review record for [HAIP PR #6](https://github.com/haiprotocol/haip/pull/6). The sole normative prose profile is [`protocol/draft-2.0.0-3/agent-ui.md`](../../../protocol/draft-2.0.0-3/agent-ui.md), paired with its adjacent JSON Schema.

## Lineage

[Decision #7](https://github.com/haiprotocol/haip/issues/7) selected native Agent UI. Commit [`aed0493`](https://github.com/haiprotocol/haip/commit/aed0493229445f007ae67dc433080b13d0910c57) introduced the immutable repository draft `2.0.0-draft.2` with `haip.agent-ui: "1"`. Later review found that the required envelope fields, exact message union, fixed budgets and lifecycle ordering changed which messages an implementation accepts. Those corrections therefore use the new immutable identities `2.0.0-draft.3`, `haip.agent-ui: "2"` and `org.haiprotocol.agent-ui/2`.

Draft 3 does not reinterpret draft 2. The compatibility and stored-state treatment is recorded in [`protocol-compatibility.md`](protocol-compatibility.md) and the release history.

## Mapping

- [`agent-ui.md`](../../../protocol/draft-2.0.0-3/agent-ui.md) defines the trust boundary, exact lifecycle, fixed limits, bootstrap origin exception, immutable snapshots, proposal ordering and ownership.
- [`schema.json`](../../../protocol/draft-2.0.0-3/schema.json) defines the envelope and closed message union.
- [`haip-view`](../../../haip-view) implements the producer View client against profile version 2.
- [`browser`](../../../haip-server/src/browser) implements the trusted Host and outer Proxy boundaries.
- [`tests`](../../../tests) and [`conformance`](../../../conformance) cover contract and browser rejection cases.
- [`native-isolate`](..) supplies historical formal evidence for the approval and effect state model, with its exact limits recorded separately.

## Ownership

Lee Crossley (`@leecrossley`) owns the HAIP Agent UI profile, `@haip/view` client, HAIP conformance fixtures and release cadence.

The separate renderer acknowledgement was withdrawn. HAIP assigns no external renderer work and does not depend on an external port. Any external integration is independent and carries its own acceptance tests.
