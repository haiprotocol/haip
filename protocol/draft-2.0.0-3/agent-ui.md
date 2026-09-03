# Agent UI

Status: normative for `2.0.0-draft.3`. This immutable profile has the wire identity `org.haiprotocol.agent-ui/2`, the required profile selection `haip.agent-ui: "2"`, and bundle compatibility `agent_ui: "2"`.

The capitalised words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY state requirements for this profile.

## Boundary

Agent UI renders untrusted approval material supplied by an agent system. JSON-RPC 2.0 supplies the `postMessage` envelope only. The methods, capabilities, identity, trust, authority, lifecycle and effect semantics in this document are native HAIP.

The Host is trusted HAIP code. It authenticates the human, verifies the approval envelope, controls the sandbox and native controls, validates proposals, and is the only component that may offer confirmation. The View is untrusted producer code inside an opaque origin frame that permits scripts only. The View has no authority.

The profile defines no MCP surface or MCP compatibility requirement.

## Envelope

Before creating a View, the Host MUST obtain and verify an `AgentUiEnvelope` with this exact identity shape:

```json
{
  "profile": "org.haiprotocol.agent-ui/2",
  "protocol_revision": "2.0.0-draft.3",
  "request": {
    "id": "native HAIP request identifier",
    "digest": "digest of the complete approval request",
    "purpose": "review or authorise_execution",
    "authorisation_revision": 0,
    "supersedes": null
  },
  "bundle": {
    "id": "registered immutable bundle identifier",
    "publisher": "authenticated publisher identifier",
    "digest": "digest of the exact rendered bundle bytes",
    "created_at": "immutable registration time captured by the request"
  },
  "source": {
    "tenant": "HAIP tenant",
    "producer": "authenticated producer and agent system machine identity",
    "requester": {
      "subject": "human owner resolved by the operator",
      "source": "identity resolution source"
    },
    "origin": "configured outer sandbox origin"
  },
  "snapshots": {
    "input_digest": "digest of the complete input snapshot",
    "result_digest": "digest of the complete result snapshot"
  },
  "binding_digest": "digest of the identity fields above"
}
```

The server MUST derive the envelope only after it has authenticated the owner, verified the persisted request, verified the exact bound bundle bytes, and checked every request, bundle, source and snapshot field. The Host MUST recompute `binding_digest` before it creates a View. This SHA-256 value is a consistency check over the RFC 8785 canonical form of `profile`, `protocol_revision`, `request`, `bundle`, `source` and `snapshots`. Authentication and server verification establish trust in the envelope.

A missing or mismatched value, mutable lookup result, unsupported revision or unsupported profile MUST select trusted native rendering without creating a View. Re-registration MUST create a new immutable bundle record and recompute its digest from the exact bytes. It MUST NOT alter a bundle or envelope already offered for approval.

The Host MUST deliver the complete input and result snapshots committed by the envelope. A View client MUST recursively freeze both values before passing them to application callbacks. It MUST NOT expose a mutable reference to either snapshot.

## Sandbox

The View MUST run in an inner frame with an opaque origin and `allow-scripts` as its only sandbox permission. It MUST have no same-origin privilege, network, storage, forms, top navigation, downloads, popups, credentials or direct HAIP API. The Host MUST apply a fixed deny-all content policy. Producer metadata MUST NOT widen it. The outer sandbox origin MUST be a separate site from the trusted HAIP application origin unless both origins are loopback in development.

Every inbound browser message MUST match the exact expected `WindowProxy`. Every boundary with an origin MUST also match the exact configured origin. A textual `"null"` origin does not establish identity. Checks based on suffixes, substrings, registrable domains, inherited origins or the last observed origin are forbidden.

The opaque View does not know its parent origin until the correlated successful `haip/ui.initialize` response carries the verified envelope. The View MAY target its exact `window.parent` with `*` for that first request only. It MUST accept the response only from the same `WindowProxy`, require `event.origin` to equal `envelope.source.origin`, and pin that origin for every later inbound and outbound message.

The configured sandbox origin MUST use the canonical lowercase HTTP or HTTPS grammar in `AgentUiOrigin`: `localhost`, an IPv4 address or a DNS name, with no default or invalid port. The standalone `StoredApp.origin` MUST exactly equal `AgentUiEnvelope.source.origin`.

The trusted outer Proxy MAY target the opaque inner frame with `*` because that frame has no targetable origin. It MUST correlate every reply through the exact inner `WindowProxy`. No other wildcard target is permitted.

Unexpected sources, origins, methods, IDs, oversized messages, excessive JSON depth and malformed messages MUST be rejected without changing approval state.

## Messages

The Host and View MUST accept only this public message set. Every message is an exact object. Extra properties are invalid.

| Direction    | Method                | Kind         | Use                                                               |
| ------------ | --------------------- | ------------ | ----------------------------------------------------------------- |
| View to Host | `haip/ui.initialize`  | request      | Offer the fixed profile and request Host initialisation.          |
| View to Host | `haip/ui.initialized` | notification | Declare that initialisation completed.                            |
| Host to View | `haip/ui.input`       | notification | Deliver the complete immutable input snapshot once.               |
| Host to View | `haip/ui.result`      | notification | Deliver the complete immutable result snapshot once, after input. |
| View to Host | `haip/ui.propose`     | request      | Submit a schema-valid candidate bound to the envelope.            |
| Host to View | `haip/ui.teardown`    | request      | Request controlled terminal teardown.                             |

`haip/ui.initialize` MUST identify `org.haiprotocol.agent-ui/2` and the fixed capability `{ "localProposal": true }`. It MAY include `viewInfo` with a non-empty display name and version within the limits below. These strings confer no identity or authority.

The correlated successful response MUST carry the same profile and capability, `hostInfo`, the verified envelope, every fixed limit and the fixed lifecycle strings. After validating it, the View MUST send `haip/ui.initialized` with exact empty parameters. The Host MUST send no snapshot before that notification. It MUST then send input once and result once. Streaming deltas, refreshes, subscriptions and mutation messages are outside this profile.

Each request MUST have a non-null JSON-RPC ID that is unique among requests from the same sender in its View instance. String IDs MUST be non-empty and bounded by the limits below. Numeric IDs MUST be safe integers. A response MUST carry the identical ID. The receiver MUST reject responses with unknown or completed IDs and requests with duplicate or replayed IDs in the issuing peer's namespace. IDs from an earlier View instance MUST NOT be accepted by a replacement.

A success response MUST contain exactly `jsonrpc`, `id` and `result`. An error response MUST contain exactly `jsonrpc`, `id` and `error`. The exact error object has a bounded `message` and one of these codes: `-32600`, `-32601`, `-32602` or `-32000`.

The trusted outer Proxy MAY use private `haip/ui.proxyReady`, `haip/ui.resourceReady` and `haip/ui.viewFailed` notifications to bootstrap the opaque frame and report failure. These messages do not cross the public View boundary and confer no capability.

## Lifecycle

The lifecycle strings returned during initialisation are fixed:

| Field            | Value                                       |
| ---------------- | ------------------------------------------- |
| `initialise`     | `haip/ui.initialize -> haip/ui.initialized` |
| `snapshots`      | `haip/ui.input -> haip/ui.result`           |
| `proposal_after` | `haip/ui.result`                            |
| `teardown`       | `terminal`                                  |

A View MUST NOT propose before it has received the complete result snapshot. The Host MUST reject lifecycle violations without changing approval state. A View that needs different data MUST be destroyed and recreated from a newly verified envelope.

For controlled replacement, navigation or close after snapshot delivery, the Host MUST send `haip/ui.teardown` with exact empty parameters, correlate its response and allow the fixed grace period before destroying the View. The only valid success result is `{ "closed": true }`. The View SHOULD stop work and acknowledge promptly. Timeout, malformed acknowledgement and rejection end with destruction and MUST NOT alter approval state. Teardown is terminal for that View instance.

Abrupt frame, renderer, process or page failure MAY end without a graceful message. Destruction MUST discard outstanding IDs and every local confirmation target for an unconfirmed View proposal. A later View is a new instance and repeats envelope verification and initialisation.

Trusted native rendering and response controls MUST remain available without the View. Initialisation failure, policy violation, crash, unsupported content and teardown failure select that path. View failure MUST NOT block denial, cancellation where the protocol permits it, or safe inspection of the bound material.

## Limits

These fixed values are part of profile version 2. Byte limits apply to UTF-8 encoded JSON. JSON depth counts the message root as depth zero. Text limits count Unicode code points.

| Field                       |     Value | Meaning                                                    |
| --------------------------- | --------: | ---------------------------------------------------------- |
| `view_message_bytes`        | 1,048,576 | Maximum View to Host message size.                         |
| `host_message_bytes`        | 6,291,456 | Maximum Host to View message size.                         |
| `tracked_view_request_ids`  |       512 | Maximum completed and outstanding View-issued request IDs. |
| `proposals_per_view`        |        32 | Maximum proposal requests in one View instance.            |
| `initialise_timeout_ms`     |     5,000 | Maximum initialisation period.                             |
| `teardown_grace_ms`         |       250 | Grace period before forced destruction.                    |
| `json_depth`                |        64 | Maximum nested JSON depth.                                 |
| `request_id_codepoints`     |       200 | Maximum string request ID length.                          |
| `error_message_codepoints`  |       400 | Maximum JSON-RPC error message length.                     |
| `view_name_codepoints`      |       120 | Maximum View display name length.                          |
| `view_version_codepoints`   |        40 | Maximum View display version length.                       |
| `failure_reason_codepoints` |       160 | Maximum private View failure reason length.                |

Exceeding either message byte limit or JSON depth, exhausting the tracked ID or proposal budget, or violating channel policy MUST destroy the affected View and select trusted native rendering. A schema-invalid proposal MAY receive an error without destruction when the channel and lifecycle remain valid.

## Proposals

`haip/ui.propose` is the sole View to Host proposal channel. Its parameters MUST be an exact `DecisionProposal` containing `decision` and `response`. The Host MUST validate the candidate, enforce its size limit, associate it with the envelope request ID, revision and digest, and return either an `AgentUiProposeResult` or an allowed JSON-RPC error.

The only advertised capability is `localProposal: true`. A proposal is not a tool call and MUST NOT be forwarded to a producer, executor or external system. It confers no delegated authority.

```text
proposal != confirmation != authorisation != effect
```

A proposal may fill trusted native controls. Confirmation requires a separate explicit human action after the Host displays the exact frozen candidate and its bindings. Confirmation creates only the decision allowed by the request purpose. Execution authorisation follows the separate HAIP grant, claim and admission rules. An external executor records any effect after authorisation. A UI message, proposal, confirmation, receipt or cancellation signal does not prove that effect.

## Schema

[`schema.json`](schema.json) defines `AgentUiEnvelope`, the input and result snapshots, each exact request, notification, success and error object, `AgentUiLimits`, `AgentUiLifecycle`, the directional public `AgentUiViewToHostMessage` and `AgentUiHostToViewMessage` unions, and separate private Proxy notification unions. `AgentUiMessage` contains only the two public directions. The adjacent schema and this document jointly define profile version 2. If they disagree, an implementation MUST reject the affected message or envelope until a new immutable protocol revision resolves the conflict.

Adding a method, capability, field or accepted shape requires a new Agent UI profile version and a fresh immutable envelope binding. A package release does not change or negotiate this wire profile.

## Ownership

Lee Crossley (`@leecrossley`) owns the HAIP Agent UI profile, `@haip/view` client, HAIP conformance fixtures and release cadence. External renderer integrations remain separate projects with their own maintainers and acceptance tests.
