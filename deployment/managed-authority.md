# Managed authority

This design replaces process ownership with a durable database incarnation only after the hosted implementation passes review. [`CommitWitness`](../haip-server/src/commit-witness.ts) can protect the reference store's read and write transactions. The normal runtime still uses one process per activated generation. The managed transaction wiring is exercised in local fixtures.

## Binding

An offline operator selects a new random epoch and an exact deployment and database binding. The deployment binding must include the [Vercel deployment ID](https://vercel.com/docs/environment-variables/system-environment-variables#vercel_deployment_id). The database binding must identify the approved Neon project, branch and endpoint without retaining a connection secret. The runtime must carry the expected incarnation in its configuration. A database row alone does not establish authority.

The database contains one sequence and random commit nonce. Independent safety storage contains a signed record for each sequence and a separate permanent retirement record for the epoch. Each record binds the configured issuer, epoch and deployment and database identities through their digests. Records contain no review data or credentials. The evidence store must provide strongly consistent reads and creation that returns an existing value on conflict. The live adapter must verify exact versions and inherited retention and legal hold.

## Transactions

Before reading private state, compare the database stamp with its independent record and require that the next record and retirement record are absent. Repeat the check against the same database snapshot before returning the result. On mismatch, refuse the result. Apply this boundary to authentication, private data, authority and scheduled work before providing any managed access.

A write locks the database stamp row and validates it against the independent record. It then changes application state, creates a unique successor in independent storage and commits the successor stamp in the same PostgreSQL transaction as the state change. The successor is written before PostgreSQL commit. Two copies of a database can prepare a write from the same sequence, but only the copy that reserved the next independent record can commit it. Return authority, private material or an outbox dispatch only after the database commit succeeds.

This depends on PostgreSQL committing state and stamp together. Only reviewed code and controlled offline jobs may mutate guarded records. Selective table restoration or direct database edits that keep the stamp intact defeat that assumption. Restrict the runtime and maintenance roles, verify the backup includes the stamp and cover every state-changing method before activation. Runtime identities need no ability to provision or retire a deployment.

## Failure rules

A clean function replacement uses the current stamp. An outage, unsigned or conflicting record, missing stamp, old deployment binding, or independently recorded successor ahead of the database causes a refusal. A lost response between witness creation and database commit may leave the incarnation unavailable. There is no automatic repair of that case because the available evidence does not tell the runtime which business writes survived.

Quiesce callers, queued delivery and executors before explicit database restoration or deployment retirement. Wait for outstanding bounded permits if needed. Retire the affected epoch independently, fence the affected tenant authority generations and use the existing conservative recovery rules for deletion, revocation, credentials and uncertain execution. A new release uses a fresh binding and an offline activation, after those records have been checked. Code rollback alone does not reactivate the previous deployment.

## Evidence

The [local PostgreSQL test](../tests/managed-witness.test.ts) uses three database copies and a separate filesystem store. It exercises normal replacement, refusal of stale identity and private material after restore, mismatched deployment or database, concurrent forked writes, store outage, lost witness acknowledgement and retirement. It proves neither live storage consistency nor full HAIP coverage. Keep the release hold until authenticated reads, grants and permits, delivery, encrypted restoration and overlapping old and new functions pass through this boundary on the deployed system.

The [HTTP fixture](../tests/managed-http.test.ts) uses two real handler instances with separate pools. They share review state, issue a verifiable receipt and settle a scheduled outbox job. An ambiguous witness commit makes both instances refuse sessions, private material, ledger reads and scheduled work. Live activation, overlapping release recovery and externally enforced execution still require their own evidence.

The proof serialises writes for the managed database and checks independent storage on guarded reads. Measure database contention, function latency and retained-record cost under the intended workload. Reject accesses that exceed the invocation or grant budget. Avoid a cache that can hide a newer witness or retirement record.
