# @haip/server

Node 24, Express 5 and PostgreSQL reference review service with OIDC and a native inbox.

Version **2.0.0-draft.3** is under development. It breaks HAIP 1 compatibility and is not a production or Plasm release. The protocol is independent of this runtime.

Build and test from the repository root with `npm ci` and `npm run check`. See the root README, operations runbook, implementation ledger and release gates at [haiprotocol/haip](https://github.com/haiprotocol/haip). Do not trust a manifest solely because a server returned it. Historical signature verification never renews authority.

Scripted Views require browser-enforced network confinement. The trusted sandbox checks an empty connection allowlist before accepting producer HTML. Browsers that cannot demonstrate enforcement use the native review form.

Untrusted response schemas run in bounded workers before the tenant write transaction. Worker saturation returns `schema_validation_busy`. A process heap flag that enlarges the permitted worker heap returns `schema_worker_configuration`. See the root operations runbook for the limits and deployment requirements.

MIT. Original attribution retained in LICENSE.
