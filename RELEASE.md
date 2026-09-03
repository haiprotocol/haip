# Release gates

Version: **2.0.0-draft.3**. The current changes and isolated checks are under review in [HAIP draft PR #6](https://github.com/haiprotocol/haip/pull/6), based on the implementation in PR #5. Full HAIP 2 and a Plasm live-window release are **not ready**. Package publication and deployment have not been performed.

## Draft evidence

Draft contracts, schemas, generated types, OpenAPI, reference service, native host and inbox, SDK and CLI, independent HTTP review and Agent UI View demonstrations, fixed-counter demonstrations, HITL mapping, delivery, quotas, retention, recovery, backups, migrations and operations are implemented. Exact results are in the research manifest. [ACCEPTANCE.md](ACCEPTANCE.md) maps coverage. The [review follow-up](REVIEW-FIXES.md) records the later fixes and expanded coverage from a clean checkout and hosted CI without treating historical run records as evidence for the current source. The subsequent [worker and boundary follow-up](WORKER-FOLLOW-UP.md) records bounded cleanup and checkpoint continuation, draft pagination and remaining boundary fixes. Its [hosted run](https://github.com/haiprotocol/haip/actions/runs/33342151204) passed 85 tests, 25 comparisons, four package dry runs, the production dependency audit and nine container checks on `7daeefa`, with [separate evidence](research/haip2-2026-08-30/validation/worker-follow-up-7daeefa/README.md).

[Hosted CI](https://github.com/haiprotocol/haip/actions/runs/33334308802) passed on `5f70557e7d8a0f29a1e0ea87170689d452375d31`: 46 tests, 25 cross-language comparisons, zero known production dependency vulnerabilities and four package dry runs. [Retained remote evidence](research/haip2-2026-08-30/validation/remote-ci-33334308802/manifest.json) is separate from historical local records. Current PR checks govern later revisions.

The [review-regression run](https://github.com/haiprotocol/haip/actions/runs/33339089387) passed 68 tests, 25 comparisons, the production dependency audit, four package dry runs and nine development-container checks on `bc1feed4aac1dbe5ea6e47d2c9ad5ce8dd9f9fcd`. [Separate evidence](research/haip2-2026-08-30/validation/review-fixes-bc1feed/README.md) retains the results from a clean checkout, publication checks and hosted artefacts. The image was built and exercised with local fixtures. It has not been published or deployed.

Optional Azure Blob locked WORM and permanent safety records support deployments that need external retention. Free local development needs no cloud account. R2, Clerk and Vercel suitability and limitations are in [PROVIDERS.md](PROVIDERS.md).

## Deployment

- Independently administered Azure test storage: versioning, locked 90-day retention, permanent safety holds, exact reads, conflicts, writer restrictions and denial of deletion, hold removal or policy administration. Rehearse real restoration with storage independent of database backups. Adapter fixtures cannot prove administrator separation.
- Chosen external identity application, exact callback, directory mappings, session rotation, TLS reverse proxy, sandbox DNS/TLS and delivery endpoints. Generic OAuth metadata, Basic auth and local HTTPS replay persistence pass locally. A Clerk or Entra account is not integrated.
- Key custody, independent trust distribution, backup deletion, incident routing, worker and retention alerts, and recovery on every restart. Deployment files are examples.
- Independent review and passing CI for the release revision. Stabilise schemas only after the full release scenarios, including external executor integration, pass.

## External dependencies

Plasm is externally owned. Local safety patches are proposals only, with no upstream PR.

1. Accept policy and identity handling that blocks execution on failure, removal of automatic approval and prevention of effectful whole-engine replay. Test every entry.
2. Implement frozen live contexts, private permits, credential and destination enforcement, one launch fence, one execution window and partial or uncertain outcomes.
3. Add schema-3 `ApprovalBound` evidence, pre-dispatch signing and storage, and offline `--require-approval` verification without weakening legacy verification.
4. Add encrypted durable capsules, retained catalogues and overlays, exact symbols, managed credential generations and deterministic reconstruction after restart.
5. Integrate hosted tenant, identity, control plane and renderer with upstream licences. Test delayed approval beyond TTLs and without Redis, actual conflict after effects, destination enforcement and partial dispatch.

Milestone 3 can release only as explicitly live-window-only after its gates pass. Milestone 5 also requires delayed Plasm approval, both independent demonstrations, the complete matrix and stable contracts. A mock executor cannot replace these gates.

## Release checks

Run `npm run check`, `npm run test:cross-language`, `npm audit` and `npm run pack:check`. Record source hashes, dependency locks, licences and results. The pack check validates the contents of five draft packages (`@haip/protocol`, `@haip/view`, `@haip/sdk`, `@haip/server`, `@haip/cli`) without writing tarballs. Local tarballs can be prepared with `npm pack --workspaces --pack-destination output/packages`. Generated packages, View bundles and contract archives are ignored by Git and can be rebuilt locally. This does not publish anything.

Recheck baselines before proposing changes. Pin accepted upstream revisions when they exist. Published drafts remain immutable, and old records retain their original signatures and defaults. Rollback must block protected execution when guarantees are unavailable. It must refuse automatic approval and unsafe replay. Publication and deployment remain subject to separate explicit authorisation.
