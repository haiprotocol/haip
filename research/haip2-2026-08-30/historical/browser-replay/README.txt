This is a temporary, retained feasibility experiment, not a checked-in HAIP implementation.
Start with: node reproduce.mjs <Plasm workspace root>
Requires existing workspace dependencies ext-apps 1.7.4, MCP SDK 1.29.0 and esbuild.
Use the printed local host URL in the browser. Both ?mode=legacy and ?mode=current replay one input plus one result.
The copied two-node read-only fixture and HTML contain no credentials. No external API or MCP server is used.
The upstream sandbox is pinned v1.7.4 and adapted for an opaque, scripts-only inner iframe; original and adapted sources are retained.
Browser checks and results are retained alongside this runner after the experiment completes.
Temporary storage is not a repository record; import reviewed artefacts with licences and source pins before release.

Replay recorded on 30 August 2026: legacy and current layouts each passed 18 focused rendering/isolation checks.
Open each layout, capture the Plan tab, click Flow using a fresh browser snapshot, and run the retained browser-checks.js function through playwright-cli run-code.
The intentional network-denial probe produces expected CSP console errors; it makes no successful external request.
Initial harness/collector corrections are recorded in manifest.json; no production source was modified.

Publication note: this is a historical probe, not a standalone runner.
reproduce.mjs expects plasm-plan.html, the generated Plasm renderer omitted from
this collection. Obtain/build the pinned renderer in its owning repository under
its original licence before attempting reproduction. HAIP does not vendor it.
Use npm run test:browser for the current independent HAIP host checks.

Publication provenance
The original upstream sandbox body was compared byte-for-byte with MCP ext-apps
v1.7.4, commit ca1d29894fabbd1558885a9ec8620dcb01d7457e, at
examples/basic-host/src/sandbox.ts. The adapted copy retains the three changes listed
in manifest.json. Both files now carry a provenance header; the original experiment
hashes are preserved and the publication object records their new retained hashes.
LicenseRef-MCP-1.7.4-Transition denotes the unmodified upstream licence text at
../../../../third-party/ext-apps-1.7.4-LICENSE. Its Apache-2.0/MIT transition is
contribution-specific, not a choice of licence or permission to relicense the code.
The independent HAIP host and fixture code are not attributed to this upstream copy.
See ../../publication-edits.json for the original and retained evidence hashes.
