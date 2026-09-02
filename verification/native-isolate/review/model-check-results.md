# Quint verification results

These results apply to the native isolate messaging cutover at implementation commit
`f3acf381416ff8c77fa63bd2aa69e32dbc1f24c5` (tree
`0b60353f5904aeb84713c16d337f6ecfdacd7638`). The protocol and implementation
evidence is pinned independently in
[`sources/sources.lock.json`](../sources/sources.lock.json).

## Toolchain

- Node.js `24.15.0`
- npm `11.12.1`
- `@informalsystems/quint` / Quint CLI `0.32.0`
- Quint Rust evaluator `0.6.0`
- Apalache `0.56.1`
- OpenJDK `23.0.2`

## Results

Run all commands in this table from `verification/native-isolate`.

| Check                    | Exact command                                              | Result                                                                                                    |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Parse and typecheck      | `npm run check`                                            | Pass                                                                                                      |
| Deterministic traces     | `npm test`                                                 | Pass: 46/46                                                                                               |
| Bounded simulation       | `npm run simulate`                                         | Pass: 500 samples, at most 30 transitions, seed `0x5eed2026`; no `haipSafety` or `boundedState` violation |
| Apalache toolchain smoke | `npm run verify:smoke -- --server-endpoint localhost:8833` | Pass through two transitions; this bound cannot reach Host/View state                                     |
| Evidence role structure  | `node scripts/check-sources.mjs`                           | Pass: 10 unique, commit-pinned source blobs                                                               |

The deterministic suite includes the complete normative review-to-effect path and native
Agent UI traces for:

- envelope/bundle binding and unsupported profile revisions;
- ordered input/result snapshots, including pre-initialisation, result-before-input and
  duplicate data;
- native `haip/ui.propose` success and failure;
- forbidden method, wrong source/origin and replayed proposal requests/IDs;
- invalid messages after an accepted proposal, which must preserve that proposal;
- capability truthfulness (`localProposal` only);
- crash/fallback and correlated `haip/ui.teardown`, including destruction on teardown
  failure and discarding unconfirmed app candidates after View loss;
- wrong candidate digest, ineligible humans, dismissal and duplicate confirmation;
- review-purpose upgrade, claim replay, expiry and revocation;
- cancellation with uncertain effect.

Named positive witness traces demonstrate synthetic unsafe shapes: outcome without
admission, repeated admissions, extra proposal methods, uncontrolled teardown and mutable
envelope/policy. Proposal filtering is a separate observational witness outside the
current `haipSafety` invariant. These are synthetic comparison fixtures rather than
observations of a pinned external implementation or passing HAIP conformance states.

The normative happy path contains only native HAIP Agent UI and approval/effect state.

## Bounds and interpretation

The model has one finite candidate, occurrence, envelope, bundle, Host/View instance and
proposal request. Integer tags abstract protocol enums. Hashes and signatures are modelled
as unforgeable bindings; browser origin/CSP enforcement and durable transactions are
trusted guards. These assumptions must be validated separately against implementations.

The Apalache result is only a toolchain smoke through two transitions. That depth cannot
reach Host/View state and is not a symbolic proof of the profile. The deterministic
traces and reproducible 30-step simulation provide the routine executable checks. The
temporal formulas in
[`quint/temporal.qnt`](../quint/temporal.qnt) are typechecked but are not claimed as
verified liveness proofs; human response cannot be made fair unconditionally.

The normative checker uses `composition.step`. Synthetic comparison behaviour uses named
variant transitions and positive witness tests rather than weakening `haipSafety`.
Reaching an unsafe variant is an expected counterexample; the proposal-filtering witness
records behaviour that the present invariant does not classify.

## Tooling security caveats

The root runtime dependency audit is clean. The isolated verification toolchain reports
two high-severity entries: direct Quint `0.32.0` is affected through
`adm-zip <0.6.0` by
[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85).
npm offers only a downgrade to Quint `0.23.1`, so no automatic dependency mutation was
applied. Apalache also emits a warning that its generated protobuf types predate the fix
for
[GHSA-h4h5-3hr4-j3g2](https://github.com/protocolbuffers/protobuf/security/advisories/GHSA-h4h5-3hr4-j3g2).
Run this verification toolchain only on trusted model and archive inputs until upstream
releases resolve those advisories.

## Implementation binding

At commit `f3acf381416ff8c77fa63bd2aa69e32dbc1f24c5`, the model tests selected
Host/View lifecycle and message-validation invariants implemented by the HAIP server.
They do not establish full profile conformance: the proposed profile's complete envelope
and identity binding is not present on the implementation wire and remains an unresolved
contract issue. Remaining Apps-shaped vocabulary in the Quint modules is comparison-only
provenance, not the live implementation surface.
