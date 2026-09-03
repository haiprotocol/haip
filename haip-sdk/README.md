# @haip/sdk

Producer HTTP client and offline authority verification. No machine confirmation API.

Version **2.0.0-draft.2** is under development. It breaks HAIP 1 compatibility and
is not a production or Plasm release. The protocol is independent of this runtime.

Build and test from the repository root with `npm ci` and `npm run check`. See the
root README, operations runbook, implementation ledger and release gates at
[haiprotocol/haip](https://github.com/haiprotocol/haip). Do not trust a manifest solely
because a server returned it. Historical signature verification never renews authority.

MIT; original attribution retained in LICENSE.
