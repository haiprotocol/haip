# Python conformance

This package is internally authored second-language evidence for HAIP `2.0.0-draft.3`. It does not satisfy the release gate for an independently accountable implementation or security review.

The client uses Python 3.9 or later and only the standard library. It imports no HAIP package and communicates with a service through the published HTTP contract. Its cryptographic path implements the signed-record subset of RFC 8785, SHA-256 and strict Ed25519 verification from the protocol text and frozen data.

## Vectors

[`draft-3-vectors.json`](draft-3-vectors.json) freezes a coherent execution chain containing a decision request, candidate, signed receipt, signed change event, signed execution claim and signed admission. Each entry carries exact canonical bytes and a SHA-256 digest. The signed records use RFC 8032 test key 1, and five changes to committed fields must be rejected.

The filename and `status` field identify the vector set as frozen for draft 3. Preserve it through Git history, and add a new file for a later protocol revision rather than editing this one.

Run the local checks with:

```sh
python3 conformance/python/haip_conformance.py vectors
```

## HTTP flow

The `review-start` and `review-finish` commands run a plain review through public endpoints. Start checks discovery, unsupported-profile refusal and idempotency before returning a review link. A separate authenticated human must create and confirm the candidate through the trusted host. Finish verifies the receipt, request and response commitments, signed producer event, export and refusal of execution authority for review purpose.

Configuration is read from standard input so bearer credentials do not appear in process arguments or evidence files. The repository integration test provisions an isolated tenant and passes short-lived local values to the client.

The live fixture creates retained request data. Run it only against an isolated test tenant, preserve its original input and signed outputs when recording evidence, and keep credentials out of logs.

## Execution flow

The separate `execution-start` and `execution-finish` commands exercise one fixed counter increment with the draft execution profile. A human must confirm the request between them, and the service must complete anchoring before finish runs.

Before the first effect, finish verifies the exported request, material, candidate, receipt, claim, admission, profiles, identities, digest links, time bounds and checkpoint proof. The command also compares the checkpoint with an independently obtained record path. The integration test permits the loopback-only filesystem anchor and reads its stored record directly.

The counter and its request fence share one SQLite transaction with full synchronous writes. A committed result therefore includes both the effect and its unique request fence. Re-running finish verifies the persisted signed request, receipt, claim, admission and checkpoint, then retries the same idempotent outcome report without incrementing the counter or depending on retained private review material.

This counter is a bounded local execution fixture rather than a general executor. For a deployed service, pass `anchor_record_path` for a separately retrieved checkpoint record. Validating a provider's retention controls remains deployment acceptance work outside this client.
