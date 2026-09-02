# HAIP — Human-Agent Interaction Protocol

HAIP 2 is an independent protocol for authenticated human review and verifiable
execution authorisation. A producer submits immutable material, an optional MCP App
and a response schema. A human reviews it in the trusted host and explicitly confirms
an exact response. Execution requests additionally require an exclusive claim and
fresh, signed admission.

**Status: `2.0.0-draft.1`, under development. Not a production or Plasm release.**
The standalone review service and bounded HTTP counter fixture run locally. Plasm
live-window approval, durable continuations and approval-bound evidence are not
implemented here. Safe namespace recovery, encrypted backups and independent storage
checks are implemented and exercised locally; real deployment acceptance is still
required. See [the implementation ledger](IMPLEMENTATION.md), [acceptance matrix](ACCEPTANCE.md)
and [release gates](RELEASE.md). The [review follow-up](REVIEW-FIXES.md) records the
subsequent fixes and expanded validation without overwriting historical evidence.

HAIP retains its MIT licence, `@haip` package scope and
[haiprotocol.com](https://haiprotocol.com) identity. It does not depend on Plasm,
awaithumans, Impri or an agent framework. Plasm is externally maintained; any changes
to it are separate proposals subject to its maintainers' acceptance.

## Contents

| Path                           | Responsibility                                                          |
| ------------------------------ | ----------------------------------------------------------------------- |
| `protocol/draft-2.0.0-1`       | Draft review contract, execution extension, JSON Schema and OpenAPI 3.1 |
| `@types` / `@haip/protocol`    | Generated TypeScript types, strict JSON and signature primitives        |
| `haip-server` / `@haip/server` | Node 24, Express 5, PostgreSQL, OIDC, inbox and isolated app host       |
| `haip-sdk` / `@haip/sdk`       | Producer client and authority verification; no machine confirmation     |
| `haip-cli` / `@haip/cli`       | Create, inspect, cancel and export requests; verify signed records      |
| `examples/http`                | Independent structured review and one fixed counter operation           |
| `tests`                        | Running HTTP, OIDC, browser, retention and delivery fixtures            |
| `research/haip2-2026-08-30`    | Historical evidence and locked cross-language runners                   |

## Local checks

Use Node 24 and a local PostgreSQL installation providing `initdb`, `pg_ctl` and
`pg_config`. Tests create isolated databases, identities, local delivery sinks and
mock effects. They do not use an existing database or production credentials.

```sh
npm ci
npx playwright install chromium
npm run check
```

Set `HAIP_TEST_PG_BIN` if the PostgreSQL binaries are not found by `pg_config`.
The browser test uses headless Chromium; `HAIP_TEST_CHROMIUM` optionally selects a
local executable. It exercises an independently authored MCP App against exactly
native Agent UI and no MCP SDK, including forbidden operations and a near-10-MiB
payload containing 1,000 steps.

Cross-language primitive checks also require Rust and Python:

```sh
python3 -m venv .local/primitive-python
.local/primitive-python/bin/pip install -r research/haip2-2026-08-30/runners/requirements.txt
npm run test:cross-language
npm run pack:check
```

`pack:check` inspects package contents without publication. Primitives and mock
anchoring tests are not production conformance certification.

## Running the reference service

For a free local demonstration, run `npm run demo` after building. It creates a
temporary isolated database, local sign-in fixture and random test credentials;
never expose it publicly. `npm run example:app` builds the independent choice App.
See [the HTTP walkthrough](examples/http/README.md). No cloud account is required.
The [development container guide](deployment/development.md) covers the current
Docker/Compose files, explicit local settings and their deployment limitations.

Build with `npm run build`, provide explicit database, signing, trust, OIDC and
separate sandbox-origin configuration, then run `npm run start -w @haip/server`.
There are no default identities or approval credentials. The local bootstrap command
creates an operator, who configures humans, producers, publishers and routes through
the administration API. See [operations](OPERATIONS.md) for the exact configuration.

The trusted inbox uses OIDC sessions. Producer credentials cannot confirm decisions.
An app can propose a response but cannot confirm, execute, navigate externally, access
storage or call arbitrary tools. The host view and response form remain available if
the app fails. Review-only decisions never grant execution authority.

Production startup requires separate HTTPS sites, verified database TLS, matching
signing trust, independently administered anchoring and permanent recovery fences.
The Azure Blob adapter checks locked retention and exact versions;
real Azure permissions and external identity interoperability remain unverified.
Development without an anchor permits review and polling; execution stays fenced.
Filesystem anchoring exists only in the test fixtures.

Provider policy: **free tiers first, no Amazon services**. Cloudflare/R2 and Clerk
are candidates where suitable; Azure is preferred if a paid service is necessary.
Nothing is provisioned automatically. See [provider choices and limitations](PROVIDERS.md).

## HAIP 1 archive

HAIP 2 deliberately breaks HAIP 1 compatibility. Previous streaming/chat sources,
tests and guidance are retained in [archive/v1](archive/v1) and
[the documentation archive](docs/archive/v1). They are not HAIP 2 commands or contracts.

[MIT licence](LICENSE) · [Third-party notices](third-party/README.md)
