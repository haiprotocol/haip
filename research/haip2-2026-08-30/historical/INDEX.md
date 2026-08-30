# HAIP 2 research collection — 30 August 2026

Supporting evidence for the HAIP 2 implementation plan. These artefacts establish
feasibility, not release conformance: repackage and rerun them as locked runners
before relying on them in release gates (plan §5).

## Contents

### `browser-replay/`

MCP App renderer replay experiment. Drives Plasm's existing plan-review bundle in an
isolated browser host from a frozen payload, with no MCP server access and an opaque
inner frame. Both payload layouts passed focused rendering and isolation checks using
a two-node read-only fixture (`browser-results.json`, `manifest.json`; screenshots and
DOM dumps for current and legacy flows included). Feasibility evidence only — not
production-host conformance.

### `protocol-checks/`

Cross-language cryptographic primitive checks: 36/36 assertions passed
(33 in `check-details.json` + 3 decimal-response checks in
`decimal-response-fixture.json`). Tooling per `check-results.json`: Node 24.15.0,
Python 3, Rust `jcs-canonicalize` 0.2.1 / `ed25519-dalek` 2.2.0. CHAP pinned at
`BrightbeamAI/chap@5cc294bdf828a653cb20f997801907bcc99a6978`.

Notable result: CHAP's published prose examples are inconsistent — its "RFC 8032
test vector 1" signature does not match the RFC (independently confirmed against
the RFC text and an OpenSSL computation on 2026-08-30), and its sample canonical
hash does not match its published bytes. Validate against authoritative RFC 8785 /
RFC 8032 vectors only; never copy CHAP's prose examples as test vectors.

### `inbox-comparison.md`

Static source inspection of awaithumans and Impri at pinned revisions, supporting the
decision to build HAIP's native inbox. See the note for method, links and limitations.

## Caveats

- These directories were copied from macOS temporary storage on 2026-08-30; reports
  originally referenced machine-specific temporary workspaces. Published copies now
  replace those roots with labelled placeholders; see `../publication-edits.json`.
- The combined check runner and standalone locked build were not retained — only the
  probes and results. Milestone 1 packages reproducible, locked runners.

## Publication copies

Machine-specific checkout and temporary-directory roots have been redacted, and the
two copied MCP sandbox files have provenance headers. These retained bytes are not
claimed to be untouched raw captures. [The publication record](../publication-edits.json)
contains original and retained SHA-256 values; original copies are kept in ignored local
storage, outside the published evidence. Original experiment hashes and test outcomes have not been relabelled
as a later run.
