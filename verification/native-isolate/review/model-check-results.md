# Quint model-check results

These results apply to the native isolate messaging cutover on verifier commit
`6f8ad4b`. The protocol evidence is pinned independently in
[`sources/sources.lock.json`](../sources/sources.lock.json).

## Toolchain

- Node.js `22.14.0`
- npm `10.9.7`
- `@informalsystems/quint` / Quint CLI `0.32.0`
- Quint Rust evaluator `0.6.0`
- Apalache `0.56.1`
- OpenJDK `21.0.10`

## Results

| Check | Exact command | Result |
|---|---|---|
| Parse and typecheck | `npm run check` | Pass |
| Deterministic traces | `npm test` | Pass: 38/38 |
| Bounded simulation | `npm run simulate` | Pass: 500 samples, at most 30 transitions, seed `0x5eed2026`; no `haipSafety` or `boundedState` violation |
| Symbolic safety | `npm run verify` | Pass: no `haipSafety` violation through two transitions |
| Evidence role structure | `node -e` JSON parse, source-array, role, and unique-ID assertions | Pass: 9 unique sources |

The deterministic suite includes the complete normative review-to-effect path and native
agent-UI traces for:

- envelope/bundle binding and unsupported profile revisions;
- pre-initialization data and duplicate snapshots;
- native `haip/ui.propose` success and failure;
- forbidden method, wrong source/origin, and replayed proposal IDs;
- wrong-source/origin rejection after an accepted proposal (regression for a previously
  reachable `haipSafety` violation);
- capability truthfulness (`localProposal` only);
- crash/fallback and controlled `haip/ui.teardown`;
- wrong candidate digest, ineligible humans, duplicate confirmation;
- review-purpose upgrade, claim replay, expiry, revocation;
- cancellation with uncertain effect.

It also proves reachability of each preserved reference-implementation discrepancy:
outcome without admission, repeated admissions, proposal filtering, extra proposal
methods, uncontrolled teardown and mutable envelope/policy.

The normative happy path contains only native HAIP Agent UI and approval/effect state.

## Bounds and interpretation

The model has one finite candidate, occurrence, envelope, bundle, Host/View instance,
and proposal request. Integer tags abstract protocol enums. Hashes and signatures are
modeled as unforgeable bindings; browser origin/CSP enforcement and durable transactions
are trusted guards. These assumptions must be validated separately against
implementations.

The symbolic result is deliberately bounded and is not a proof for arbitrary trace
length. The depth-two bound is selected because the composed finite-map model has a
large branching product; long behavior is covered by named deterministic traces and
reproducible 30-step simulation. The temporal formulas in
[`quint/temporal.qnt`](../quint/temporal.qnt) are typechecked but are not claimed as
verified liveness proofs; human response cannot be made fair unconditionally.

The normative checker uses `composition.step`. Reference behavior uses named
implementation transitions and positive witness tests rather than weakening
`haipSafety`; reaching those states is an expected counterexample, not a passing
conformance result.

## Tooling security caveats

`npm audit` reports two high-severity entries: direct Quint `0.32.0` is affected
through `adm-zip <0.6.0` by
[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85).
npm offers only a downgrade to Quint `0.23.1`, so no automatic dependency mutation
was applied. Apalache also emits a warning that its generated protobuf types predate
the fix for
[GHSA-h4h5-3hr4-j3g2](https://github.com/protocolbuffers/protobuf/security/advisories/GHSA-h4h5-3hr4-j3g2).
Run this verification toolchain only on trusted model and archive inputs until upstream
releases resolve those advisories.


## Implementation binding

As of branch `cursor/native-haip-ui-cutover-d4be`, the HAIP server Host/View wire matches
the native `haip/ui.*` profile modelled here. Remaining Apps-shaped vocabulary in the
Quint modules is comparison-only provenance, not the live implementation surface.
