# Quint results

## Evidence

These results apply to the historical native isolate model at implementation commit `f3acf381416ff8c77fa63bd2aa69e32dbc1f24c5` and tree `0b60353f5904aeb84713c16d337f6ecfdacd7638`. [`sources/sources.lock.json`](../sources/sources.lock.json) pins the reviewed protocol and implementation evidence independently.

The model provides evidence for the state and authority properties recorded below. It predates the complete `2.0.0-draft.3` envelope, exact Agent UI profile 2 message union and fixed transport budgets. It has not been rebound to those wire shapes and does not prove their conformance.

## Toolchain

- Node.js `24.15.0`
- npm `11.12.1`
- `@informalsystems/quint` and Quint CLI `0.32.0`
- Quint Rust evaluator `0.6.0`
- Apalache `0.56.1`
- OpenJDK `23.0.2`

## Results

Run each command from `verification/native-isolate`.

| Check                    | Exact command                                              | Result                                                                                                         |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Parse and typecheck      | `npm run check`                                            | Pass                                                                                                           |
| Deterministic traces     | `npm test`                                                 | Pass, 46 of 46                                                                                                 |
| Bounded simulation       | `npm run simulate`                                         | Pass, 500 samples, at most 30 transitions, seed `0x5eed2026`, with no `haipSafety` or `boundedState` violation |
| Apalache toolchain check | `npm run verify:smoke -- --server-endpoint localhost:8833` | Pass through two transitions, a bound that cannot reach Host or View state                                     |
| Evidence structure       | `node scripts/check-sources.mjs`                           | Pass, 10 unique commit-pinned source blobs                                                                     |

## Coverage

The deterministic suite includes the historical path from review through effect and native Agent UI traces for:

- envelope and bundle binding with unsupported profile revisions
- ordered input and result snapshots, including pre-initialisation, result before input and duplicate data
- native `haip/ui.propose` success and failure
- forbidden methods, wrong source or origin, and replayed proposal requests or IDs
- invalid messages after an accepted proposal, which preserve that proposal
- fixed `localProposal` capability advertisement
- crash, fallback and correlated `haip/ui.teardown`, including destruction after teardown failure and discarding unconfirmed candidates after View loss
- wrong candidate digest, ineligible humans, dismissal and duplicate confirmation
- attempted purpose upgrade, claim replay, expiry and revocation
- cancellation with uncertain effect

Named positive witness traces exercise synthetic cases: outcome without admission, repeated admissions, extra proposal methods, uncontrolled teardown and mutable envelope or policy. Proposal filtering is a separate observational witness outside the current `haipSafety` invariant. These cases are comparison fixtures. They do not record an external implementation or passing HAIP conformance states.

The normative model path contains only native Agent UI state and the path from approval through effect.

## Bounds

The model has one finite candidate, occurrence, envelope, bundle, Host instance, View instance and proposal request. Integer tags abstract protocol enums. Hashes and signatures are modelled as unforgeable bindings. Browser origin and CSP enforcement, exact wire validation, and durable transactions are trusted guards that require separate implementation tests.

The Apalache result checks its toolchain through two transitions. That depth cannot reach Host or View state and is not a symbolic proof of the profile. The deterministic traces and reproducible 30-step simulation provide routine executable checks. [`quint/temporal.qnt`](../quint/temporal.qnt) is typechecked, but its temporal formulas are not claimed as verified liveness proofs because an unconditional fairness assumption cannot force human response.

The normative checker uses `composition.step`. Synthetic comparison behaviour uses named variant transitions and positive witness tests without weakening `haipSafety`. Reaching an unsafe variant is an expected counterexample. The proposal-filtering witness records behaviour that the present invariant does not classify.

## Tool security

The current isolated npm graph overrides `adm-zip` to `0.6.0`, which resolves [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85), and `npm audit` reports zero vulnerabilities. This replaces the earlier record of two high-severity entries through Quint's transitive `adm-zip` dependency.

Apalache still emits a warning that its generated protobuf types predate the fix for [GHSA-h4h5-3hr4-j3g2](https://github.com/protocolbuffers/protobuf/security/advisories/GHSA-h4h5-3hr4-j3g2). Run that optional toolchain only on trusted local model inputs until its distribution updates those generated types.

## Implementation

At commit `f3acf381416ff8c77fa63bd2aa69e32dbc1f24c5`, the model tests covered selected Host and View lifecycle cases, proposal correlation, authority separation, admission and effect invariants. The pinned implementation did not yet carry the complete final envelope or exact profile 2 wire contract.

Draft 3 defines and tests those current shapes in [`protocol/draft-2.0.0-3/agent-ui.md`](../../../protocol/draft-2.0.0-3/agent-ui.md), its adjacent schema, the browser tests and the View client tests. That later evidence resolves the old implementation gap without changing the scope of this historical model result. Names left from the Apps comparison in the Quint modules record provenance only.
