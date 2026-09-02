# Changelog

## Unreleased

- Cut the review Host/View wire over to the native `haip/ui.*` Agent UI profile.
  MCP Apps `ext-apps` / SDK are removed from the browser path; bundle compatibility is
  `agent_ui: "1"` and the request profile is `haip.agent-ui: "1"`.


## 2.0.0-draft.1 — unreleased

HAIP is being repurposed as an independent human-review and execution-authorisation
protocol. This is a breaking major with no HAIP 1 compatibility. Existing streaming,
chat, audio and transport APIs are archived under `archive/v1` and `docs/archive/v1`.

The active `@haip` packages now expose immutable review requests, explicit trusted
human confirmation, signed receipts, producer isolation, exclusive claims, fresh
admission, outcomes and audit exports. The reference server uses Node 24, Express 5
and PostgreSQL with OIDC and a native browser inbox. The MCP App can propose only.

Response JSON rejects duplicates, malformed Unicode and precision loss while supporting
ordinary decimals through RFC 8785. Exact renderer pairing is ext-apps 1.7.4/MCP SDK
1.29.0. Included keys are not implicit trust roots. No notification can approve or run.

Development and production limits are explicit. Production execution admission is
fenced pending safe restore recovery. The filesystem anchor and counter are test
fixtures, not a production runtime. Plasm support is a separate unaccepted integration;
no live-window or delayed approval release is claimed.

Daily creation quotas persist independently of retained requests. Migration 003 pauses
new creation for existing tenants until the next UTC day rather than guessing counts
from incomplete audit retention; existing reviews and outcomes remain usable. Historical
public trust keys for permanent recovery fences must be retained indefinitely.

OIDC identity aliases cannot bypass self-review restrictions. The SDK refuses unknown
required profiles. The fixed-counter demonstration binds its action, context and policy,
counts reads within its one execution window, and checks admission at the counter update.

Proposed Plasm compatibility changes are described separately: configured policy
failures block execution; approval-required plans no longer receive automatic receipts;
unknown/effectful work cannot retry the whole engine after a write conflict. Users of
such behaviour would need fresh review and explicit reconciliation, never a permissive
compatibility switch. These proposals have not been merged or released by Plasm.
