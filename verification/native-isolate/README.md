# HAIP Agent UI + approval spine verification

Standalone Quint model for the **native HAIP Agent UI** extension and the HAIP 2
approval→effect safety spine reviewed against
[HAIP PR #5](https://github.com/haiprotocol/haip/pull/5).

This is a **new HAIP protocol extension**. It is not an MCP adapter, MCP Apps
profile, or compatibility layer. There is no MCP↔HAIP bridge to preserve.

## Scope

- Native View↔Host methods over JSON-RPC 2.0 `postMessage`:
  `haip/ui.initialize`, `haip/ui.initialized`, `haip/ui.input`, `haip/ui.result`,
  `haip/ui.propose`, `haip/ui.teardown`, with fixed `localProposal: true`
- HAIP 2 review → confirmation → authorisation → grant → claim → single admission →
  dispatch → outcome (purpose separation, grant lifetime, cancel/uncertain effect)
- Implementation discrepancy witnesses (outcome without admission, etc.) as
  *counterexamples*, not allowed behaviours

## Out of scope

- MCP core, MCP Apps, MCP Tasks, MRTR, or HITL wire formats
- Full HTTP/OpenAPI surface, Plasm/workers/webhooks, ops/TLS/retention mechanics

## Commands

```sh
npm install
npm run check
npm test
npm run simulate
npm run verify
```

Normative UI contract: [`review/haip-agent-ui-profile.md`](review/haip-agent-ui-profile.md).
Model-check record: [`review/model-check-results.md`](review/model-check-results.md).
Protocol review: [`review/protocol-review.md`](review/protocol-review.md).
