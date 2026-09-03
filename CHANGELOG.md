# Changelog

## 2.0.0-draft.3 (unreleased)

- New immutable draft revision. `protocol/draft-2.0.0-2` and `haip.agent-ui: "1"` remain unchanged as history. The current contract lives under `protocol/draft-2.0.0-3` and does not reinterpret draft 2.
- Agent UI now uses required profile `haip.agent-ui: "2"`, bundle compatibility `agent_ui: "2"` and wire profile `org.haiprotocol.agent-ui/2`.
- The normative Agent UI profile, JSON Schema and generated types define an exact message union, complete request and bundle binding, source identities, immutable snapshots, lifecycle ordering, origin bootstrap rule and fixed transport budgets.
- `@haip/view`, the trusted browser Host and the outer Proxy enforce the profile 2 message shapes, origin checks, frozen snapshots, proposal ordering, request limits and terminal teardown.
- The reference server refuses operations that produce authority or export bundles for stored requests from an earlier protocol revision. Draft 2 private test requests must be recreated under draft 3. Historical status and safe cancellation remain available.
- The draft 3 SDK refuses draft 2 profile selections and authority. The pinned Quint evidence records its historical state and authority properties. It does not prove the draft 3 wire shapes.

## 2.0.0-draft.2 (unreleased)

- New immutable draft revision under `protocol/draft-2.0.0-2`, with `protocol/draft-2.0.0-1` retained unchanged as history.
- The review Host/View wire is the native `haip/ui.*` Agent UI profile (`haip.agent-ui: "1"`, bundle compatibility `agent_ui: "1"`). MCP Apps `ext-apps` / SDK are not used in the browser path.
- `haip.mcp-app: "1-draft.1"` is retired. No deployment ever accepted a `draft.1` request, so there is no earlier authority to retain, migrate or cancel.
- The draft 2 Agent UI envelope and its message definitions were added to `schema.json` with generated types (`StoredApp`, `AgentUi*`). The host verifies the envelope's binding digest before creating a View.
- New `@haip/view` package: a dependency-free View client for the Agent UI wire.

## 2.0.0-draft.1 (unreleased)

HAIP is being repurposed as an independent human-review and execution-authorisation protocol. This is a breaking major with no HAIP 1 compatibility. Existing streaming, chat, audio and transport APIs are archived under `archive/v1` and `docs/archive/v1`.

The original `draft.1` baseline exposed immutable review requests, explicit trusted human confirmation, signed receipts, producer isolation, exclusive claims, fresh admission, outcomes and audit exports. The reference server uses Node 24, Express 5 and PostgreSQL with OIDC and a native browser inbox. Its MCP App could propose only.

Response JSON rejects duplicates, malformed Unicode and precision loss while supporting ordinary decimals through RFC 8785. The original renderer pairing was ext-apps 1.7.4/MCP SDK 1.29.0. Included keys are not implicit trust roots. No notification can approve or run.

Development and production limits are explicit. Production execution admission is fenced pending safe restore recovery. The filesystem anchor and counter are limited to test fixtures. Plasm support is a separate unaccepted integration. No live-window or delayed approval release is claimed.

Daily creation quotas persist independently of retained requests. Migration 003 pauses new creation for existing tenants until the next UTC day rather than guessing counts from incomplete audit retention. Existing reviews and outcomes remain usable. Historical public trust keys for permanent recovery fences must be retained indefinitely.

OIDC identity aliases cannot bypass self-review restrictions. The SDK refuses unknown required profiles. The fixed-counter demonstration binds its action, context and policy, counts reads within its one execution window, and checks admission at the counter update.

Proposed Plasm compatibility changes are described separately: configured policy failures block execution. Approval-required plans no longer receive automatic receipts. Unknown or effectful work cannot retry the whole engine after a write conflict. Users of such behaviour would need fresh review and explicit reconciliation, without a permissive compatibility switch. These proposals have not been merged or released by Plasm.
