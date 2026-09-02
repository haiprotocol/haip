# HAIP Agent UI profile

Status: normative profile for the reviewed HAIP 2 architecture.

## 1. Identity and boundary

The HAIP Agent UI profile is a native HAIP protocol for rendering untrusted,
agent-system-sourced approval material. It is a **new HAIP protocol extension**. It is not an MCP surface and defines no MCP
compatibility requirements.

The profile uses JSON-RPC 2.0 only as a generic `postMessage` envelope. All View↔Host
method names, capabilities, identity, trust, authority, lifecycle, and effect semantics
in this document are native HAIP.

The **Host** is trusted HAIP code. It authenticates the human, obtains and verifies the
approval envelope, controls the sandbox and native controls, validates proposals, and
is the only party that may offer confirmation. The **View** is untrusted producer code
inside an opaque-origin, scripts-only sandbox. The View is never an authority.

## 2. Native approval envelope

Before creating a View, the Host MUST obtain a complete immutable envelope equivalent
to:

```json
{
  "profile": "org.haiprotocol.agent-ui/1",
  "requestId": "native HAIP request identifier",
  "requestRevision": "immutable revision identifier",
  "requestDigest": "digest of the complete approval request",
  "bundleId": "registered immutable bundle identifier",
  "bundleRevision": "immutable bundle revision",
  "bundleDigest": "digest of the exact rendered bundle bytes",
  "source": {
    "producerId": "authenticated producer identity",
    "agentSystemId": "authenticated agent-system identity",
    "tenantId": "HAIP tenant",
    "origin": "configured outer sandbox origin"
  },
  "inputSnapshot": {},
  "resultSnapshot": {}
}
```

The concrete HAIP schema MAY use different field names, but it MUST carry and
cryptographically bind all equivalent values. `inputSnapshot` and `resultSnapshot`
MUST be complete frozen values, not mutable references.

The Host MUST verify the request digest, request revision, bundle digest, bundle
revision, producer, agent system, tenant, and configured origin as one binding before
execution. A mismatch, missing value, mutable lookup result, or unsupported profile
MUST fail closed to the native renderer. Re-registration MUST create a new bundle
revision and digest; it MUST NOT alter an envelope already offered for approval.

## 3. Sandbox and channel

The View MUST run in an inner frame with an opaque origin and scripts only. It MUST
have no same-origin privilege, network, storage, forms, top navigation, downloads,
popups, credentials, or direct HAIP APIs. The Host MUST apply a fixed deny-all policy;
producer CSP metadata MUST NOT widen it. The outer sandbox origin MUST be separate from
the trusted HAIP application origin.

Every inbound browser message MUST match both the exact expected `WindowProxy` and the
exact configured origin at the boundary where an origin exists. The inner opaque frame
MUST be correlated through its exact `WindowProxy`; a textual `"null"` origin is never
an identity. Wildcard targets and suffix, substring, registrable-domain, inherited, or
last-seen-origin checks are forbidden. Unexpected sources, origins, methods, IDs, and
oversized or malformed messages MUST be rejected without changing approval state.

## 4. Native message set

All View↔Host messages use JSON-RPC 2.0 as a generic envelope. The Host and View MUST
accept only this native subset:

| Direction | Method | Kind | HAIP use |
|---|---|---|---|
| View → Host | `haip/ui.initialize` | request | Offer the fixed View profile and request Host initialization. |
| View → Host | `haip/ui.initialized` | notification | Declare that initialization completed. |
| Host → View | `haip/ui.input` | notification | Deliver the complete immutable input snapshot exactly once. |
| Host → View | `haip/ui.result` | notification | Deliver the complete immutable result snapshot exactly once, after input. |
| View → Host | `haip/ui.propose` | request | Submit a schema-valid candidate bound to the immutable envelope. |
| Host → View | `haip/ui.teardown` | request | Request graceful controlled teardown. |

The View's `haip/ui.initialize` parameters MUST identify only this profile and its fixed
View capabilities. The correlated Host response MUST identify the same profile,
advertise only `localProposal: true`, and carry the envelope identity needed by the View
to label the material. The Host MUST send no snapshot before the successful response and
subsequent `haip/ui.initialized` notification. It MUST send input once, then result
once. There are no streaming deltas, refreshes, subscriptions, or later mutation
messages. A View that needs different data MUST be destroyed and recreated from a newly
verified envelope.

Each request MUST have a non-null JSON-RPC request ID unique for that View instance.
The response MUST carry the identical ID. The Host MUST maintain outstanding and
completed ID sets, reject responses for unknown IDs, reject duplicate requests where
the method does not permit them, and reject every replay of a completed ID. IDs and
messages from an earlier View instance MUST never be accepted by a replacement.

## 5. Local proposal

`haip/ui.propose` is the sole View→Host proposal channel. Its parameters MUST be a
schema-valid candidate object bound to the immutable envelope. There is no tool name
field. The Host MUST validate and size-bound the parameters, associate them with the
envelope request ID, revision, and digest, and return either a proposal record or a
JSON-RPC error.

Capability advertisement is profile-fixed: the Host advertises `localProposal: true`
only. `haip/ui.propose` is not a tool call, is not forwarded to an MCP server, HAIP
producer, executor, or external system, and confers no delegated authority.

The following separation is absolute:

```text
proposal != confirmation != authorization != effect
```

A proposal only pre-fills trusted native controls. Confirmation requires a separate,
explicit human action in Host-owned UI after the Host displays the exact frozen
candidate and bindings. Confirmation creates only the HAIP decision defined by the
request purpose. Authorization requires the separate native HAIP grant/claim/admission
rules. An effect occurs only in an external executor after authorization and is not
proved by any UI message, proposal, confirmation, receipt, or cancellation signal.
No transition may infer a later state from an earlier one.

## 6. Lifecycle, failure, and fallback

For controlled replacement, navigation, or close, the Host MUST send
`haip/ui.teardown`, correlate its response, and allow a short bounded grace period
before destroying the View. The View SHOULD stop work and acknowledge promptly. Timeout,
malformed acknowledgement, or rejection MUST end with destruction and MUST NOT alter
approval state.

Abrupt frame, renderer, process, or page failure has no graceful-message requirement.
The Host MUST treat it as a crash, discard outstanding IDs and all unconfirmed
proposals, and retain no authority from the View. A later View is a new instance and
must repeat envelope verification and initialization.

Trusted native rendering and Host-owned response controls MUST remain available without
the View. Initialization failure, policy violation, crash, unsupported content, or
teardown failure MUST select that native fallback. View failure MUST never block denial,
cancellation where natively legal, or safe inspection of the bound material.

## 7. Native feature classification

### Native wire contract

- JSON-RPC 2.0 request, response, error, notification, and request-ID correlation as a
  generic `postMessage` envelope;
- `haip/ui.initialize` followed by `haip/ui.initialized`;
- one complete `haip/ui.input`, then one complete `haip/ui.result`;
- `haip/ui.propose` for the sole local proposal operation;
- `haip/ui.teardown` for controlled teardown;
- profile-fixed `localProposal: true` capability advertisement only.

These methods and ordering rules are native HAIP. They are not an adopted Apps subset.

### Fixed and forbidden

- capability advertisement is fixed to this named HAIP profile and `localProposal: true`;
  it is not MCP connection or per-request negotiation;
- sandbox and content policy are fixed deny-all and cannot be widened by resource
  metadata;
- lifecycle covers one immutable envelope and one-shot snapshots, not a reusable external
  resource session;
- Foreign tool-call shapes, server-tool advertisements, and external UI-extension
  capability negotiation are outside this profile.

Anything not explicitly listed in the native message set is forbidden. Adding a method
or capability requires a new HAIP profile revision and a fresh immutable envelope
binding; implementation package versions do not change or negotiate this wire profile.
