# HAIP 2 protocol review (native Agent UI extension)

Review target: [HAIP PR #5](https://github.com/haiprotocol/haip/pull/5).
Normative UI contract: [`haip-agent-ui-profile.md`](haip-agent-ui-profile.md).

## Verdict

HAIP 2 is an independent approval and execution protocol. The Agent UI profile is a
**new native HAIP extension** for rendering untrusted, agent-sourced approval material
inside a Host-controlled sandbox. It is not derived from MCP Apps, does not implement
MCP, and does not require MCP compatibility shims.

## Architecture requirements

1. The Host verifies one immutable envelope (request, bundle, producer, agent system,
   tenant, origin) before loading View code.
2. The View is untrusted: opaque origin, scripts only, deny-all policy that producer
   metadata cannot widen.
3. Bridge messages require the exact expected `WindowProxy` and configured origin.
4. Allowed View↔Host methods are only the native set in the Agent UI profile.
5. `haip/ui.propose` submits a schema-valid candidate. It confers no confirmation,
   authorisation, or effect.
6. Absolute separation: `proposal ≠ confirmation ≠ authorisation ≠ effect`.
7. Controlled teardown uses correlated `haip/ui.teardown`; crashes discard unconfirmed
   state; trusted native Host controls remain available.

## Model coverage

The Quint model checks the native UI lifecycle and the HAIP approval/authority/effect
spine (purpose gating, grant lifetime, single admission, cancel/uncertain effect).
It does not model the full HTTP API, Plasm execution workers, or operational controls.

## Cutover

The reviewed PR #5 browser host historically spoke Apps-shaped methods. This fork cuts
over to native `haip/ui.*` with no residual MCP client, tool-name field, or
`serverTools` advertisement. Foreign methods are rejected.
