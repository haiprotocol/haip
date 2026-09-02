# Renderer protocol decision

Status: open and non-normative.

This record compares the renderer choices raised by [HAIP PR #6](https://github.com/haiprotocol/haip/pull/6). The agreed HAIP 2 base is [`c02bf33`](https://github.com/haiprotocol/haip/commit/c02bf330324b0ec8385a8438d112c258caec6161). The native Agent UI proposal and its reviewed fixes are represented by [`83bb7de`](https://github.com/haiprotocol/haip/commit/83bb7dee44b54aeb0690eebb8ab2b67b7cad1d22). No renderer architecture decision is recorded here.

## Context

The HAIP 2 base accepts an optional Portable MCP App and hosts it without a live producer connection. The original implementation plan uses that route to reuse Plasm's existing renderer unchanged. Plasm is maintained outside this repository, so HAIP cannot assume or require a Plasm code change.

PR #6 proposes a native `haip/ui.*` Host/View protocol instead. It removes the MCP Apps runtime packages from the trusted host, rejects MCP Apps methods at the browser boundary and requires an `agent_ui: "1"` bundle. New unchanged MCP App bundles and requests are rejected before View creation. An earlier accepted bundle that still reaches the View can only fall back to trusted native controls after its renderer is rejected. Continued renderer use therefore needs a port or a versioned transition.

Both approaches can preserve HAIP's authority boundary. The Portable MCP App option treats the renderer wire as an external presentation profile, while the native option makes HAIP responsible for defining and maintaining that wire. A View may present material and propose a response. Authentication, candidate validation, human confirmation, authorisation and execution remain in trusted HAIP and executor components.

## Shared rules

Any accepted option must retain these properties:

- the Host verifies immutable request, bundle, source and snapshot bindings before it
  creates a View.
- producer code runs in an opaque, scripts-only frame with no network, credentials, storage, forms, popups, parent navigation or direct HAIP access. Any inner self-navigation or reload destroys the View.
- both browser boundaries validate the exact expected `WindowProxy`, and every boundary
  with an origin validates that origin exactly.
- the View may propose a response but cannot confirm it, create authority or cause an
  external effect.
- trusted rendering and response controls remain available when a View is absent,
  unsupported or broken.
- message sizes, request IDs, lifecycle and replay behaviour are bounded and tested.
- accepted requests retain their original protocol and profile meaning.

## Options

| Option                | Shape                                                                                                                                                  | Useful properties                                                                                                                                                                          | Work and risk                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable MCP App host | Retain the base profile, exact `ext-apps` 1.7.4 and MCP SDK 1.29.0 resolutions, one stored input/result exchange and the proposal-only host operation. | Reuses existing renderer packages, including the Plasm renderer assumed by the implementation plan. Producers can use an established View SDK. HAIP still owns confirmation and authority. | The offline subset and its security restrictions need explicit conformance tests. The trusted host carries more dependency code and licence material. Unsupported Apps features must remain unavailable.                          |
| Native Agent UI       | Adopt the six public `haip/ui.*` messages and the private proxy lifecycle messages proposed in PR #6.                                                  | The browser wire can be limited to HAIP's exact use, with a smaller trusted bundle and no MCP runtime dependency.                                                                          | HAIP owns another protocol, schema, client library and compatibility programme. Existing MCP App renderers need a migration or replacement. The current proposal lacks a complete machine-readable envelope and message contract. |
| Versioned transition  | Advertise both profiles for a bounded period, or place a narrow adapter inside the trusted host while keeping confirmation native.                     | Allows measured migration and comparison against the unchanged external renderer. Existing accepted requests can retain their original profile.                                            | Two paths increase test and maintenance work. The adapter must not widen View authority or hide unsupported behaviour. Removal still requires a new profile or protocol revision.                                                 |

A hand-written bridge using MCP Apps message names can have a small trusted bundle, so bundle size alone does not decide the wire protocol. Equally, package availability does not establish that the whole Apps protocol belongs inside HAIP. The relevant comparison is the restricted offline host needed here, including its tests and maintenance cost.

## Decision tests

| Question                                  | Evidence required before merge                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can the external renderer be reused?      | Run the unchanged Plasm renderer against the proposed host, or obtain a Plasm-maintainer-owned migration plan and acceptance test.                |
| Is the wire contract complete?            | Publish schemas and generated types for every public message, the full immutable envelope, error responses, limits and lifecycle ordering.        |
| Is authority preserved?                   | Show that neither profile can confirm, authorise or execute, and that candidate and authority bindings survive restart and offline verification.  |
| Is migration safe?                        | Assign a new immutable prerelease/profile identity and define the treatment of requests and unused authority accepted under the previous profile. |
| Is the security boundary equivalent?      | Run the same source/origin, CSP, navigation, reload, replay, quota and fallback cases against each supported path.                                |
| Is the maintenance cost accepted?         | Name the owners of the profile, client library, conformance fixtures, release cadence and renderer integration.                                   |
| Are dependencies and licences controlled? | Pin every shipped runtime dependency, retain required notices and compare the actual trusted bundle contents.                                     |

## Current position

The Portable MCP App route remains the agreed baseline until repository and Plasm maintainers explicitly accept a replacement or transition. PR #6 is useful evidence for the native option, but its implementation does not settle external renderer compatibility, version migration or the complete envelope contract. The pull request should remain draft while those decisions are open.
