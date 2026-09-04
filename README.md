# HAIP 2

HAIP 2 is an independent protocol for authenticated human review and verifiable execution authorisation. A producer submits immutable material, an optional Agent UI View and a response schema. A human reviews it in the trusted host and explicitly confirms an exact response. Execution requests also require an exclusive claim and fresh, signed admission.

**Status: `2.0.0-draft.3`, under development. Stable HAIP 2 package publication and production deployment remain incomplete.**

The standalone review service and bounded HTTP counter fixture run locally. An internally authored Python 3.9 client using only the standard library verifies six frozen draft-3 wire vectors, rejects five tamper cases and exercises live review and execution with durable replay after one counter effect. Namespace recovery, encrypted backups and independent storage checks are implemented and exercised locally. Independent implementation and security review, followed by real deployment and recovery acceptance, remain open. See [the implementation ledger](IMPLEMENTATION.md), [acceptance matrix](ACCEPTANCE.md) and [release gates](RELEASE.md). The [review follow-up](REVIEW-FIXES.md) records the subsequent fixes and expanded validation without overwriting historical evidence.

HAIP retains its MIT licence, `@haip` package scope and [haiprotocol.com](https://haiprotocol.com) identity. It does not depend on Plasm, awaithumans, Impri or an agent framework. Plasm is externally maintained as a possible downstream integration. Its acceptance is required for claims about Plasm support, while HAIP's protocol, packages and reference service have their own release gates.

## Contents

| Path                           | Responsibility                                                          |
| ------------------------------ | ----------------------------------------------------------------------- |
| `protocol/draft-2.0.0-3`       | Draft review contract, execution extension, JSON Schema and OpenAPI 3.1 |
| `@types` / `@haip/protocol`    | Generated TypeScript types, strict JSON and signature primitives        |
| `haip-view` / `@haip/view`     | Dependency-free View client for the Agent UI wire (`haip/ui.*`)         |
| `haip-server` / `@haip/server` | Node 24, Express 5, PostgreSQL, OIDC, inbox and isolated View host      |
| `haip-sdk` / `@haip/sdk`       | Producer client and authority verification. No machine confirmation     |
| `haip-cli` / `@haip/cli`       | Create, inspect, cancel and export requests. Verify signed records      |
| `examples/http`                | Independent structured review and one fixed counter operation           |
| `conformance/python`           | Internally authored vectors and HTTP client in a second language        |
| `verification/native-isolate`  | Current contract binding and Quint lifecycle model                      |
| `deployment`                   | Local, proxy, infrastructure and acceptance examples                    |
| `tests`                        | Running HTTP, OIDC, browser, retention and delivery fixtures            |
| `research/haip2-2026-08-30`    | Historical evidence and locked cross-language runners                   |

## Local checks

Use Node 24 and a local PostgreSQL installation providing `initdb`, `pg_ctl` and `pg_config`. Tests create isolated databases, identities, local delivery sinks and mock effects. They do not use an existing database or production credentials.

```sh
npm ci
npx playwright install chromium
npm run check
```

Set `HAIP_TEST_PG_BIN` if the PostgreSQL binaries are not found by `pg_config`. The browser test uses headless Chromium. `HAIP_TEST_CHROMIUM` optionally selects a local executable. It exercises an independently authored Agent UI View against exactly the native Agent UI profile with no MCP SDK, including forbidden operations and a payload just under 10 MiB containing 1,000 steps.

Cross-language primitive checks also require Rust and Python:

```sh
python3 -m venv .local/primitive-python
.local/primitive-python/bin/pip install -r research/haip2-2026-08-30/runners/requirements.txt
npm run test:cross-language
npm run pack:check
```

`pack:check` inspects package contents without publication. Primitive and mock anchoring tests do not provide production conformance certification.

The native-isolate checks first bind the model to the current draft contract, then typecheck, test and simulate it:

```sh
npm ci --prefix verification/native-isolate --ignore-scripts
npm run check --prefix verification/native-isolate
npm test --prefix verification/native-isolate
npm run simulate --prefix verification/native-isolate
```

## Assurance

The [internal security review](SECURITY-REVIEW.md) records CodeQL analysis, rate limits for the service and each authenticated principal, and a backup path that keeps the database password out of arguments visible on a child process. This is internally authored evidence. Independent security review remains required before a production release.

The provider-neutral acceptance runner validates a strict operator plan and collects bounded command evidence for identity, TLS, isolation, storage permissions, delivery, monitoring and recovery checks. The Caddy and Azure Bicep files describe one deployment shape. Live DNS, provisioned resources and acceptance evidence remain external.

## Reference service

For a free local demonstration, run `npm run demo` after building. It creates a temporary isolated database, local sign-in fixture and random test credentials for local use. `npm run example:app` builds the independent choice View. See [the HTTP walkthrough](examples/http/README.md). No cloud account is required. The [development container guide](deployment/development.md) covers the current Docker/Compose files, explicit local settings and their deployment limitations.

Build with `npm run build`, provide explicit database, signing, trust, OIDC and separate sandbox-origin configuration, then run `npm run start -w @haip/server`. There are no default identities or approval credentials. The local bootstrap command creates an operator, who configures humans, producers, publishers and routes through the administration API. See [operations](OPERATIONS.md) for the exact configuration.

The trusted inbox uses OIDC sessions. Producer credentials cannot confirm decisions. An Agent UI View can propose a response but cannot confirm, trigger external execution, navigate outside its frame, access storage or call arbitrary tools. The host view and response form remain available if the View fails. Review-only decisions never grant execution authority.

Production startup requires separate HTTPS sites, verified database TLS, matching signing trust, configured checkpoint and safety storage, an assertion of independent administration and permanent recovery fences. The Azure Blob adapter checks locked retention and exact versions across separate checkpoint and safety containers, while the prepared runtime role permits only add and read operations. The template leaves policy locking, the safety legal hold and effective-permission inspection to an independent administrator. Real permissions and external identity interoperability remain unverified. Development without an anchor permits review and polling. Execution stays fenced. Filesystem anchoring exists only in the test fixtures.

Provider policy: **use free tiers first**. Cloudflare R2 and Clerk are candidates where suitable. Azure is preferred when a paid service is necessary. Nothing is provisioned automatically. See [provider choices and limitations](PROVIDERS.md).

Merging reviewed `2.0.0-draft.3` source into `main` keeps it a draft. Marking packages stable, publishing them and deploying the service are later decisions that require the remaining evidence and separate authorisation.

## HAIP 1 archive

HAIP 2 deliberately breaks HAIP 1 compatibility. Previous streaming/chat sources, tests and guidance are retained in [archive/v1](archive/v1) and [the documentation archive](docs/archive/v1). They are not HAIP 2 commands or contracts.

[MIT licence](LICENSE) | [Third-party notices](third-party/README.md)
