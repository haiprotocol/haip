# Independent HTTP demonstrations

These are bounded local fixtures against the running draft reference service. They
need no Plasm fields, engine or agent framework. Use isolated credentials and effects.

For a free walkthrough, build from the repository root, then run `npm run demo`.
It prints a localhost origin and temporary producer/publisher credentials. Keep it
running in that terminal; the database and keys are disposable test fixtures.
In another terminal set `HAIP_URL`, `HAIP_TOKEN`, `HAIP_PUBLISHER_TOKEN` from that
output and `HAIP_LOCAL_HTTP=true`. Run `npm run example:app`, then
`node examples/http/register-app.mjs`; set `HAIP_BUNDLE_ID` to the returned ID.
Set a new `HAIP_IDEMPOTENCY_KEY` and run the review command below. Sign in as
`reviewer` in the local test provider and confirm through the trusted host.
Never expose this fixture publicly or reuse its credentials for deployment.

`review.json` is a generic review request. Set `HAIP_URL`, `HAIP_TOKEN` and
`HAIP_IDEMPOTENCY_KEY`, then run `node examples/http/review.mjs` to submit it. Configure
the producer, publisher, human owner and review route first. Follow the review link,
sign in through OIDC, propose a structured choice and confirm it in the trusted host.
Poll status and events. The browser test builds an independently authored MCP App,
registers it with its own publisher credential and completes the same workflow.

`counter.ts` exports `runCounter`. It accepts only the fixed `counter.increment` action
with amount one and a generic execution binding. After normal human confirmation it
obtains a claim and fresh admission, verifies purpose, profiles, identities, commitments,
signatures, timing and independent checkpoint acceptance, then durably writes an
exclusive local fence before changing a counter. Reinvocation returns the saved result
and retries outcome reporting without repeating the effect. The HTTP test runs this
flow with the explicitly non-production filesystem anchor fixture.

Use one durable private directory per request. Do not share its counter with other
occurrences or delete its fence. If a fence exists without a result, treat the launch
as uncertain and reconcile manually; do not rerun it. A filesystem or external-effect
failure after launch is not proof that nothing happened. This demonstration does not
implement general execution, credential management, scheduling or production recovery.
Never replace the supplied independent anchor-verification callback with a no-op.

The reusable review fixture in `conformance/review.mjs` targets only public HTTP
operations and accepts a real-host confirmation callback. See `conformance/README.md`
for running it against another isolated implementation.
