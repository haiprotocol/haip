# @haip/view

Dependency-free client for producer Views on the HAIP Agent UI wire (`haip/ui.*`, profile `org.haiprotocol.agent-ui/2`). Version **2.0.0-draft.3** is under development.

A View runs inside HAIP's opaque sandbox frame with scripts only. It can present the stored input and result snapshots and **propose** a response. Trusted HAIP controls handle confirmation and authorisation, while execution remains external.

```js
import { connectView } from '@haip/view';

const view = await connectView({
  name: 'Choice review',
  version: '1.0.0',
  onResult: (result) => render(result.structuredContent?.payload),
});
await view.propose({ decision: 'answer', response: { choice: 'accept' } });
```

The client performs the `haip/ui.initialize` -> `haip/ui.initialized` handshake, validates the exact `2.0.0-draft.3` envelope, correlates request IDs, delivers `haip/ui.input` and `haip/ui.result` once and in order, and exposes the recursively frozen host-verified identity as `view.envelope`. A teardown acknowledgement closes the client, rejects pending proposals and removes its message listener. The message and envelope shapes are defined in the protocol schema (`StoredApp`, `AgentUi*`). Bundle the client into the self-contained HTML registered with HAIP because the sandbox has no network access.
