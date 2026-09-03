# @haip/view

Dependency-free client for producer Views on the HAIP Agent UI wire (`haip/ui.*`,
profile `org.haiprotocol.agent-ui/1`). Version **2.0.0-draft.2** — under development.

A View runs inside HAIP's opaque, scripts-only sandbox frame. It can present the stored
input and result snapshots and **propose** a response; only the trusted HAIP host can
confirm, authorise or execute.

```js
import { connectView } from '@haip/view';

const view = await connectView({
  name: 'Choice review',
  version: '1.0.0',
  onResult: (result) => render(result.structuredContent?.payload),
});
await view.propose({ decision: 'answer', response: { choice: 'accept' } });
```

The client performs the `haip/ui.initialize` → `haip/ui.initialized` handshake,
correlates request ids, delivers `haip/ui.input` and `haip/ui.result` exactly once and
in order, acknowledges `haip/ui.teardown`, and exposes the host-verified envelope
identity as `view.envelope`. The message and envelope shapes are defined in the
protocol schema (`StoredApp`, `AgentUi*`). Bundle it into the self-contained HTML you
register with HAIP; the sandbox has no network access.
