# Release gates

Version: **2.0.0-draft.3**. The Agent UI changes were reviewed in [PR #6](https://github.com/haiprotocol/haip/pull/6) and merged into the HAIP 2 draft assembled in [PR #5](https://github.com/haiprotocol/haip/pull/5). Merging reviewed draft source into `main` retains the prerelease contract. Stable package publication and production deployment remain separate, incomplete decisions. The packages are unpublished and the service is undeployed.

## Draft evidence

Draft contracts, schemas, generated types, OpenAPI, reference service, native host and inbox, SDK and CLI, independent HTTP review and Agent UI View demonstrations, fixed-counter demonstrations, HITL mapping, delivery, quotas, retention, recovery, backups, migrations and operations are implemented. Exact results are in the research manifest. [ACCEPTANCE.md](ACCEPTANCE.md) maps coverage. The [review follow-up](REVIEW-FIXES.md) records the later fixes and expanded coverage from a clean checkout and hosted CI without treating historical run records as evidence for the current source. The subsequent [worker and boundary follow-up](WORKER-FOLLOW-UP.md) records bounded cleanup and checkpoint continuation, draft pagination and remaining boundary fixes. Its [hosted run](https://github.com/haiprotocol/haip/actions/runs/33342151204) passed 85 tests, 25 comparisons, four package dry runs, the production dependency audit and nine container checks on `7daeefa`, with [separate evidence](research/haip2-2026-08-30/validation/worker-follow-up-7daeefa/README.md).

The [Agent UI run](https://github.com/haiprotocol/haip/actions/runs/33811067004) tested `c39eb20ac8707e0b3ddafabfb3edc201a992a80c`. [The implementation ledger](IMPLEMENTATION.md) records its results and scope. Later commits require a current passing PR check.

This assurance work adds an internally authored Python 3.9 client using only the standard library, with six frozen draft-3 vectors, five tamper rejections, live review and durable execution replay after one counter effect. It also binds the current contract before Quint, adds CodeQL analysis and targeted service hardening, and supplies a provider-neutral acceptance runner with Caddy and Azure Bicep examples. The review PR's required checks govern its final revision. Independent implementation, independent security review and real deployment acceptance remain required.

[Hosted CI](https://github.com/haiprotocol/haip/actions/runs/33334308802) passed on `5f70557e7d8a0f29a1e0ea87170689d452375d31`: 46 tests, 25 cross-language comparisons, zero known production dependency vulnerabilities and four package dry runs. [Retained remote evidence](research/haip2-2026-08-30/validation/remote-ci-33334308802/manifest.json) is separate from historical local records. Required exact-head checks govern later revisions.

The [review-regression run](https://github.com/haiprotocol/haip/actions/runs/33339089387) passed 68 tests, 25 comparisons, the production dependency audit, four package dry runs and nine development-container checks on `bc1feed4aac1dbe5ea6e47d2c9ad5ce8dd9f9fcd`. [Separate evidence](research/haip2-2026-08-30/validation/review-fixes-bc1feed/README.md) retains the results from a clean checkout, publication checks and hosted artefacts. The image was built and exercised with local fixtures. It has not been published or deployed.

Optional Azure Blob locked WORM and permanent safety records support deployments that need external retention. The prepared template separates checkpoint and safety containers from the runtime role that can only add and read records. It has not been provisioned. Free local development needs no cloud account. R2, Clerk and Vercel suitability and limitations are in [PROVIDERS.md](PROVIDERS.md).

## Deployment

- Run the provider-neutral acceptance plan against independently administered storage: versioning, locked 90-day retention, permanent safety holds, exact reads, conflicts, writer restrictions and denial of deletion, hold removal or policy administration. Rehearse real restoration with storage independent of database backups. Adapter fixtures and a generated report cannot prove administrator separation by themselves.
- Chosen external identity application, exact callback, directory mappings, session rotation, TLS reverse proxy, sandbox DNS/TLS and delivery endpoints. Generic OAuth metadata, Basic auth and local HTTPS replay persistence pass locally. A Clerk or Entra account is not integrated.
- Key custody, independent trust distribution, backup deletion, incident routing, worker and retention alerts, and recovery on every restart. The Caddy and Bicep files are reviewed examples rather than an installed deployment.
- Obtain independent implementation and security review with passing CI for the exact release revision. Stabilise schemas only after the standalone HAIP release scenarios pass.

## Downstream

Plasm is externally owned. Local safety patches are proposals only, with no upstream PR. Plasm acceptance is required for a claim that Plasm implements a HAIP profile. A draft source merge, the HAIP packages and the HAIP reference service follow the HAIP gates above.

Any Plasm integration still needs policy and identity enforcement, frozen live contexts, private permits, credential and destination checks, one launch fence, one execution window, partial or uncertain outcomes and protection from effectful whole-engine replay.

Plasm claims for approval-bound evidence need schema-3 records, pre-dispatch signing and offline verification. Durable Plasm claims also need encrypted capsules, retained catalogues and overlays, exact symbols, managed credential generations and deterministic reconstruction. Hosted claims need tenant, identity, control plane and renderer integration under accepted upstream licences. Those requirements stay with the Plasm release that makes each claim.

## Release checks

Run `npm run check`, `npm run test:cross-language`, `npm audit` and `npm run pack:check`. Install the locked native-isolate dependencies, then run its contract binding, Quint checks and simulation. Record source hashes, dependency locks, licences and results. The pack check validates the contents of five draft packages (`@haip/protocol`, `@haip/view`, `@haip/sdk`, `@haip/server`, `@haip/cli`) without writing tarballs. Local tarballs can be prepared with `npm pack --workspaces --pack-destination output/packages`. Generated packages, View bundles and contract archives are ignored by Git and can be rebuilt locally. This does not publish anything.

Recheck baselines before proposing changes. Pin accepted upstream revisions when they exist. Published drafts remain immutable, and old records retain their original signatures and defaults. Rollback must block protected execution when guarantees are unavailable. It must refuse automatic approval and unsafe replay. Merge draft source only after review and the required exact-head checks. Marking packages stable, publishing them and deploying the service each require the remaining evidence and separate explicit authorisation.
