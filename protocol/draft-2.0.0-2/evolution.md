# Evolution and trust — 2.0.0-draft.2

Status: draft. Protocol and document revision: `2.0.0-draft.2`. This document
belongs to the same labelled revision as `review.md`, `schema.json` and `openapi.json`.
Published draft revisions are immutable; later changes require a newly labelled revision.

Before full milestone 5 validation, publish only immutable labelled draft revisions
and prerelease packages. Do not relabel these documents stable because a scaffold,
primitive probe or subset of tests passes.

Accepted requests retain their original revisions, profiles, limits, schema identities
and signed objects. An upgrade must support them or cancel unused authority and
require fresh review. Historical verification never renews authority. Consumption,
revocation, bounded issued permits and retired namespaces survive migration.

Stable major 2 may add optional, non-authorising metadata at declared extension
points. Preserve unknown metadata inside signed commitments without assigning it
meaning. Optional capabilities require explicitly advertised and selected profile
versions. Renaming/removing fields, changing types/meanings, adding required fields,
or changing authorisation, bindings, digests, canonicalisation or signatures breaks
compatibility: core changes need a new protocol major; optional-profile changes need
a distinct profile version. Never reinterpret or re-sign an old decision under new defaults.

Trust manifests advertise Ed25519 key identifiers, issuer, validity and revocation
for discovery/historical verification. Inclusion does not confer trust. Configure
trusted issuers/keys through an independent operator channel. Retain original keys
and revocation history for audit; rotate signing keys without changing old objects.
Public verification keys and their validity/revocation history must remain available
indefinitely when permanent recovery records still depend on them.
When independent historical-time evidence is absent, report validity as indeterminate.
