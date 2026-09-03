# Public HTTP fixtures — draft 2.0.0-draft.2

`exerciseReviewFixture` in `review.mjs` talks only to documented HTTP interfaces.
It imports protocol primitives and no reference-service internals, database tables,
Plasm code or agent framework. Another service can run the same fixture after
provisioning an isolated tenant, route, producer, authorised publisher, another
producer and a foreign-tenant producer. This is a reusable draft fixture, not a
complete certification programme.

Pass the exact service origin, independently trusted manifest, scoped credentials,
tenant/producer/route IDs and HTML for your independently authored Agent UI View. The
`confirm(reviewLink, requestId)` callback must wait for a human to use the real trusted
host and choose a valid response. It must not mint a receipt or call a privileged
confirmation shortcut. Credentials are never written by the runner.

The fixture checks advertised revision, bundle ownership, generic review creation,
idempotency/conflicts, unsupported-profile refusal, scope isolation, signed structured
response commitments, signed events and refusal of execution for review purpose.
`tests/conformance.test.ts` runs it against a local service using the ordinary OIDC
login, candidate and confirmation endpoints. Browser sandbox acceptance is separately
in `tests/browser.test.ts`; fixed execution and refusals are in `tests/http.test.ts`
and `tests/counter-refusals.test.ts`.

Run fixtures only against explicitly isolated test tenants. They create retained
requests and bundles. Do not use production credentials. Archive original inputs,
signed outputs, dependency pins and the exact tested service revision when assessing
another implementation. Passing these cases alone is not a production release claim.
