# HAIP Agent UI + approval spine verification

Standalone Quint model for the proposed **native HAIP Agent UI** extension and the HAIP 2
approval→effect safety spine proposed in
[HAIP PR #6](https://github.com/haiprotocol/haip/pull/6), against the HAIP 2 base from
[PR #5](https://github.com/haiprotocol/haip/pull/5).

This models a **proposed HAIP protocol extension**. It is not an MCP adapter, MCP Apps
profile, or compatibility layer. There is no MCP↔HAIP bridge to preserve.

## Scope

- Native View↔Host methods over JSON-RPC 2.0 `postMessage`:
  `haip/ui.initialize`, `haip/ui.initialized`, `haip/ui.input`, `haip/ui.result`,
  `haip/ui.propose`, `haip/ui.teardown`, with fixed `localProposal: true`
- HAIP 2 review → confirmation → authorisation → grant → claim → single admission →
  dispatch → outcome (purpose separation, grant lifetime, cancel/uncertain effect)
- Synthetic unsafe-shape counterexamples plus a separate proposal-filtering observation

## Out of scope

- MCP core, MCP Apps, MCP Tasks, MRTR, or HITL wire formats
- Full HTTP/OpenAPI surface, Plasm/workers/webhooks, ops/TLS/retention mechanics

## Commands

```sh
npm ci
npm run check
npm test
npm run simulate
```

`npm run verify:smoke` is an optional, slow Apalache toolchain smoke through two
transitions. That depth cannot reach Host/View state and is not a symbolic proof of the
profile. The deterministic traces and seeded simulation are the routine reproducible
checks.

Proposed UI contract: [`review/haip-agent-ui-profile.md`](review/haip-agent-ui-profile.md).
Model-check record: [`review/model-check-results.md`](review/model-check-results.md).
Protocol review: [`review/protocol-review.md`](review/protocol-review.md).
