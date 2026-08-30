# HAIP execution extension — 1-draft.1

Status: draft. Select `haip.execution: 1-draft.1` with protocol `2.0.0-draft.1`.
A review-only receipt is ineligible. Execution requires a complete immutable proposal,
context, policy fingerprint, occurrence identity, mode, provenance and captured limits.
A producer may submit generic digests without Plasm references.

An explicit authorising human receipt starts the grant clock at confirmation.
Independent checkpoint acceptance may make the grant available but never extends it.
Pending, expired, revoked, refused and consumed grants cannot create another claim.
Reviewer removal and authorisation-rule changes invalidate unused authority;
re-adding eligibility does not resurrect it. Identity uncertainty temporarily blocks
confirmation and admission without permanently revoking all decisions.

An execution claim consumes one action occurrence and binds one execution identity
permanently. It is not a lease. Timeout, crash, cancellation, abandoned outcomes or
material deletion never refund it. Supersession before consumption retains the same
occurrence; recovery after consumption needs a linked fresh occurrence and review.

After reconstruction and queueing, the executor claims and requests fresh admission.
HAIP takes PostgreSQL time after the relevant transaction lock. Equality with a
review, grant or dispatch deadline is expired. An admission binds nonce, claim digest,
execution identity, original `dispatch_before`, execution bound and checkpoint proof.
Issuance is authoritative admission; subsequent revocation stops new permits but
cannot retract an already issued, bounded permit.

The executor records monotonic time before admission and computes:

`deadline_mono = request_start_mono + (dispatch_before - checked_at)`.

Reject unhealthy clocks, jumps, and possible clock-offset intervals outside 30
seconds. Tolerance is a health check, never extra validity. Verify the signature,
independently trusted issuer, purpose, profile, identities, all review/execution
commitments and independent anchor acceptance. Persist original records and signed
pre-dispatch evidence before one compare-and-set launch fence. A restored process
needs fresh status. Cached signatures do not renew authority.

Check before the launch fence and first protected dispatch. Start one monotonic
execution window at launch, including reads, queues, fanout, pagination and backoff.
No new attempt may start after expiry. Cancellation is local and does not prove
external cancellation. Preserve partial results, record ambiguous attempts and
reconcile them independently. Whole-plan effectful retries are forbidden.

Completion, failure, failed partial execution, pre-dispatch cancellation and uncertainty
are outcomes, not replacement authority. Operators may reconcile with independent
reasons/evidence. Abandonment leaves consumption intact. Unknown remains unknown
when private material expires.

The SDK verifies a receipt-to-checkpoint hash proof and requires a caller-provided
independent anchor verifier. The bounded counter example is a test integration, not
Plasm support or a general execution engine. It retains a durable local launch fence
and never replays after an uncertain crash.
