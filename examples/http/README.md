# Independent HTTP demonstrations

These examples exercise the draft reference service over HTTP. Use isolated credentials and effects.

Build from the repository root, then run `npm run demo` and leave it running. The demo prints a localhost origin and disposable credentials.

In a second terminal at the repository root, export `HAIP_URL` from the demo's `origin`, `HAIP_TOKEN` from `producer_token` and `HAIP_PUBLISHER_TOKEN` from `publisher_token`. Build and register the example View.

```sh
export HAIP_LOCAL_HTTP=true
npm run example:app
export HAIP_IDEMPOTENCY_KEY="$(node -p 'crypto.randomUUID()')"
node examples/http/register-app.mjs
```

Export `HAIP_BUNDLE_ID` with the `id` returned by registration, then start the review with its own key. Reuse the original key if you retry either operation.

```sh
export HAIP_IDEMPOTENCY_KEY="$(node -p 'crypto.randomUUID()')"
node examples/http/review.mjs
```

Open `review_link` from the response and sign in as `reviewer`. Open the isolated View, propose a choice and confirm it in the trusted host. Keep the demo on loopback and use its credentials only for this run.

`review.json` is a generic review request. To submit it against a separate test installation, configure the producer, publisher, human owner and review route first. Set `HAIP_URL`, `HAIP_TOKEN` and `HAIP_IDEMPOTENCY_KEY`, then run `node examples/http/review.mjs`. Follow the review link, sign in through OIDC, propose a structured choice and confirm it in the trusted host. Poll status and events. The browser test builds the example Agent UI View, registers it with a publisher credential and completes the same workflow.

`counter.ts` exports `runCounter`. It accepts only the fixed `counter.increment` action with amount one and a generic execution binding. After normal human confirmation it obtains a claim and fresh admission, verifies purpose, profiles, identities, commitments, signatures, timing and independent checkpoint acceptance, then durably writes an exclusive local fence before changing a counter. Reinvocation returns the saved result and retries outcome reporting without repeating the effect. The HTTP test runs this flow with the filesystem anchor fixture.

Use one durable private directory per request. Keep each occurrence's counter and fence intact. Leave a fence without a result in place for manual reconciliation. A filesystem or external-effect failure after launch leaves the effect uncertain. The fixture covers the fixed counter action. Keep the supplied independent anchor-verification callback enabled.

The reusable review fixture in [`conformance/review.mjs`](conformance/review.mjs) targets public HTTP operations and accepts a host confirmation callback. See [`conformance/README.md`](conformance/README.md) for running it against another isolated implementation.
