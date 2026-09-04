# Evaluation integrity version 1

`integrity-v1.json` records the rules checked by CI. Protocol, language, policy and
execution invariants use development fixtures, not held-out answers or production
catalogues. Keep deterministic symbol allocation separate from prompt/reflection edits.
Do not tune a prompt against withheld answers or copy them into examples.

No model evaluation was run for this implementation. The model, prompt, catalogue and
cost fields are therefore null rather than fabricated values. Future model-evaluation
runs must separately record those versions, harness revision, cost, all failures and
fixture classification. Human approval is oversight, not proof of correctness.

The static guard checks declarations and obvious fixture boundary violations; it is
not proof against deliberate contamination. Review changes to these rules separately.
