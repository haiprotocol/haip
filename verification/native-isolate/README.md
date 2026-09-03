# Native verification

This directory contains the standalone Quint model for native Agent UI and the HAIP 2 safety path from approval through effect, prepared for [HAIP PR #6](https://github.com/haiprotocol/haip/pull/6) against the HAIP 2 base from [PR #5](https://github.com/haiprotocol/haip/pull/5).

## Evidence

The implementation evidence is pinned to commit `f3acf381416ff8c77fa63bd2aa69e32dbc1f24c5` and tree `0b60353f5904aeb84713c16d337f6ecfdacd7638`. [`sources/sources.lock.json`](sources/sources.lock.json) pins every reviewed source independently.

This is historical evidence for the modelled approval, authority, admission and effect properties. It predates the complete `2.0.0-draft.3` envelope, exact profile 2 message union and fixed transport budgets, so it does not establish conformance with those wire shapes. The current normative Agent UI contract is [`protocol/draft-2.0.0-3/agent-ui.md`](../../protocol/draft-2.0.0-3/agent-ui.md) and its adjacent JSON Schema.

## Scope

- Native View to Host lifecycle over JSON-RPC 2.0 `postMessage`, including initialisation, one input snapshot, one result snapshot, proposal and teardown.
- HAIP 2 review, confirmation, authorisation, grant, claim, single admission, dispatch and outcome, including purpose separation, grant lifetime and uncertain effect.
- Synthetic counterexamples for unsafe transitions and a separate proposal filtering observation.

## Exclusions

- Exact draft 3 envelope fields, JSON message shapes, text limits, byte budgets and browser implementation conformance.
- MCP core, MCP Apps, MCP Tasks, MRTR and HITL wire formats.
- Full HTTP and OpenAPI surfaces, workers, webhooks, operations, TLS and retention mechanics.

## Commands

```sh
npm ci
npm run check
npm test
npm run simulate
```

`npm run verify:smoke` is an optional Apalache toolchain check through two transitions. That bound cannot reach Host or View state and is not a symbolic proof of the profile. The deterministic traces and seeded simulation are the routine reproducible checks.

Review mapping: [`review/haip-agent-ui-profile.md`](review/haip-agent-ui-profile.md). Model record: [`review/model-check-results.md`](review/model-check-results.md). Protocol review: [`review/protocol-review.md`](review/protocol-review.md).
