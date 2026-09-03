# Renderer decision

Status: decided and non-normative. [Decision #7](https://github.com/haiprotocol/haip/issues/7) selected native Agent UI.

## History

The agreed HAIP 2 base is [`c02bf33`](https://github.com/haiprotocol/haip/commit/c02bf330324b0ec8385a8438d112c258caec6161). It accepted an optional Portable MCP App and hosted it without a live producer connection. That route could reuse an existing renderer while HAIP retained authentication, candidate validation, confirmation, authorisation and execution in trusted components.

The native Agent UI implementation starts at [`aed0493`](https://github.com/haiprotocol/haip/commit/aed0493229445f007ae67dc433080b13d0910c57). It introduced the immutable repository draft `2.0.0-draft.2` with required profile `haip.agent-ui: "1"`, bundle compatibility `agent_ui: "1"` and wire profile `org.haiprotocol.agent-ui/1`.

Review after that commit tightened required envelope fields, exact message shapes, lifecycle ordering and fixed budgets. Those changes alter accepted wire messages, so they use new immutable identities: `2.0.0-draft.3`, `haip.agent-ui: "2"`, `agent_ui: "2"` and `org.haiprotocol.agent-ui/2`.

## Options

| Option               | Shape                                                                                                         | Cost                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Portable MCP App     | Retain exact external runtime pins, one stored input and result exchange, and a proposal-only host operation. | HAIP would need to specify and test a restricted offline subset while carrying more trusted runtime code.                       |
| Native Agent UI      | Define the six public `haip/ui.*` messages and the private Proxy lifecycle in HAIP.                           | HAIP owns the profile, client, conformance fixtures and compatibility programme. Existing renderers need a port or replacement. |
| Versioned transition | Advertise both profiles for a bounded period or place an adapter in the trusted Host.                         | Two active paths increase security, conformance and maintenance work. Removal still requires a new immutable version.           |

Decision #7 selected native Agent UI. JSON-RPC 2.0 supplies its message envelope, while HAIP defines the methods and semantics. A View may render bound material and propose a response. It cannot confirm, create authority or cause an external effect.

## Invariants

- The Host verifies immutable request, bundle, source and snapshot bindings before it creates a View.
- Producer code runs in an opaque inner frame with scripts only and no network, credentials, storage, forms, popups, parent navigation or direct HAIP access.
- Both browser boundaries validate the exact expected `WindowProxy`, and every boundary with an origin validates that origin exactly.
- Trusted rendering and response controls remain available when a View is absent, unsupported or broken.
- Message sizes, JSON depth, request IDs, lifecycle, proposals and replay behaviour have fixed bounds.
- Accepted requests retain their original protocol and profile meaning.

## Migration

Draft 2 and profile 1 remain immutable historical contracts. Draft 3 does not reinterpret their messages or authority. The current SDK refuses their required profile selection. The reference server permits historical status and safe cancellation. It refuses operations that could progress review, export a bundle, issue authority or execute from stored draft 2 state. Private draft 2 test requests must be recreated under draft 3.

## Ownership

Lee Crossley (`@leecrossley`) owns the HAIP Agent UI profile, `@haip/view` client, HAIP conformance fixtures and release cadence.

Renderer integration and its acceptance test need an external owner. Ryan Roberts (`@ryan-s-roberts`) has been asked to own that work and has not yet acknowledged it. PR #6 remains draft pending that acknowledgement.
