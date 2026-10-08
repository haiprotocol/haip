# Release readiness

Reviewed on 8 October 2026. Stable release remains on hold. This internal review covers the maintained HAIP protocol, reference service, browser host and sandbox, View client, SDK, CLI, migrations, delivery, audit and recovery, demonstrations, conformance tooling, formal models, packaging, CI and deployment assets. Archived HAIP 1 and historical research remain retained evidence. Plasm is outside this repository's release scope.

The reviewed baseline is `a2c308e7e76599e802c8016d0a4580e87521272f`. The changes were validated before commit on `l/haip-release-readiness`. Local results below cover the recorded source. Hosted checks on the published commit remain required. Package publication and production deployment are outside this review.

## Findings

| Finding | Risk | Correction |
| --- | --- | --- |
| Small response schemas can multiply validation work through repeated local references and block Node while holding a tenant transaction. | High availability risk | Bound expanded reference work and isolate compilation and validation in workers with deadlines, heap limits and bounded admission. Validate before the write transaction, then recheck ownership, eligibility, pending state and schema binding during commit. |
| CSP blocks fetch but permits WebRTC traffic from a scripted opaque View. | High confidentiality risk | Enforce an empty browser connection allowlist and require a native enforcement report before accepting producer HTML. Preserve the trusted native form when enforcement cannot be established. |
| Fresh runtime and formal-tool dependency audits identify vulnerable locked versions. | Required release check fails | Update exact direct and transitive pins, retain reproducible locks and verify SMTP, formal tooling and production dependency layout. Dependency severity alone does not establish an active unauthenticated HAIP exploit. |
| An accepted SDK origin ending in `/` produces `//v2/...` paths. | Functional defect | Store the parsed canonical origin and restrict local transport exceptions to HTTP loopback. Exercise real SDK and CLI requests. |
| Failed browser launch leaves the isolation test fixture running. | Test reliability defect | Include launch and browser closure within the fixture cleanup region. Verify launch failure exits promptly and closes owned resources. |
| Webhook DNS resolution and unused response streams lack an overall lifetime limit. | Availability risk | Bound the whole delivery attempt to ten seconds, suppress requests after late DNS resolution and close unused response bodies after acknowledgement. Verify timeout and disposal against controlled DNS and a real TLS receiver. |
| SMTP continuation replies renew inactivity timers, while closing the non-pooled transport leaves its underlying socket open. | Availability risk | Apply one ten-second deadline to the complete attempt and cancel the owned socket. Retain TLS verification and record timeout acceptance as unknown. |
| Acceptance adapters can leave descendants holding captured pipes after the direct child is killed. | Validation liveness risk | Isolate each adapter in a POSIX process group, terminate its descendants and settle without waiting for inherited pipes. Verify that later checks continue and unrelated processes survive. |
| Current research instructions still name the removed MCP pairing, archived website links enter current pages and the HTTP example concatenates an unnormalised origin. | Documentation and example defects | Correct the current instructions and eight archive links, normalise the executable example and verify its public HTTP behaviour and rejected origins. |

The final local review adds a browser execution fixture that signs in through the OIDC redirect, displays and confirms the exact execution-purpose candidate, proves refusal creates no claim or effect and verifies one authorised counter increment across retries. The read-only origins/TLS adapter preserves private evidence and reports incomplete browser coverage as `blocked`. Its passing header probes cannot satisfy deployed acceptance.

## Confinement

The sandbox uses `Connection-Allowlist: (); webrtc=block; redirects=block; report-to=haip-view-policy` alongside its existing CSP and opaque inner frame. It declares no reporting endpoint. A trusted proxy creates a peer with no ICE servers, channel or session description and accepts only a browser-created `connection-allowlist` report showing enforced WebRTC denial with an empty allowlist. It closes the peer and observer before announcing readiness. Producer HTML is withheld until this check passes. Missing browser support or stripped policy returns the native review form.

The [Connection Allowlists report](https://wicg.github.io/connection-allowlists/) remains a draft rather than a W3C standard. The implementation checks observed enforcement instead of inferring it from a browser name or version. Browser fixtures must demonstrate both blocked RTC traffic and preserved interactive review. This control addresses explicit network requests, while browser resource exhaustion and indirect side channels remain residual risks.

Hostile RTC construction in an opaque frame caused a Chromium renderer crash in the tested 153, 154 and 156 engines. The connection policy remains enforced. A distinct-site HTTPS fixture kept the trusted host available after the View process failed. A trusted bootstrap runs before producer HTML and answers fresh private proxy challenges from the exact inner window. The proxy consumes these replies locally and emits a heartbeat only while they remain fresh. Missing inner replies or proxy heartbeats remove the View and clear View-derived confirmation state. This demonstrates process responsiveness and confers no decision authority. Stored producer bytes remain unchanged and verified against their registered digest before the trusted execution wrapper is added. Localhost deployments can share a renderer process and do not establish the production availability boundary. Browser-engine defects remain an availability risk for independent review.

## Validation

The pre-commit validation snapshot is `sha256:a522db530a271f442b4ef7d17258b058911811fd96f1e7a7b37f85f321cdbc12`. It covers 257 maintained source and documentation files, including the three corrected archival and research instruction files, and excludes this report, ignored outputs, untouched archives and historical research. The local validation manifest retains each file digest and command log separately. All recorded files were unchanged after the build and tests. Later formatting repairs affect the two archived installation guides, with their documentation regression rerun. The first published commit, `3ebf74305265ec42fc46a562335d467b6e55e3da`, passed the hosted 174-test suite and nine Docker service checks. Three additional fixture corrections bind evidence permissions and bytes to one file handle, restrict the message observer to the trusted parent and keep the generated public TLS certificate in memory. Runtime source remains identical to the full-suite and CodeQL snapshot. Hosted checks must cover the final follow-up commit.

| Check | Result |
| --- | --- |
| Build, generated types and integrity | Passed |
| Full service and browser suite | 174 passed, no failures or skips |
| New confinement cases | Seven passed, included in the full suite |
| New schema security cases | Twelve passed, included in the full suite |
| SDK and CLI regressions | Two passed, included in the full suite |
| Browser execution demonstration | OIDC, trusted refusal and authorisation, one counter effect and safe replay passed |
| Documentation and HTTP example | Two passed, including archive links and rejected origin components |
| Origins/TLS adapter | Seven local TLS regressions passed. Complete deployment acceptance remains blocked |
| Webhook deadline and disposal | Three passed, including stalled DNS, shared deadline and a real TLS receiver holding response bodies open |
| SMTP deadline and TLS | Six passed, including stalled DNS and replies, late acknowledgement, later checkpoint progress, synchronous errors, implicit TLS, STARTTLS, certificate identity and plaintext refusal |
| Acceptance runner | Eight passed, including owned descendant termination, unrelated process survival, inherited pipes, excessive output and synchronous startup failure |
| Cross-language comparisons | 25 passed |
| Current contract binding and model typecheck | Passed |
| Quint scenarios | 46 passed |
| Seeded simulation | 500 samples, at most 30 steps, passed |
| Pinned source integrity | Ten unique source blobs passed |
| Root, production and formal dependency audits | Zero reported vulnerabilities |
| Package dry runs and isolated installation | Five packages passed |
| Packed module imports, worker, SMTP and CLI help | Six imports, plain Node worker and SMTP cleanup, and CLI passed |
| Production dependency layout | All eleven runtime dependencies resolve from the image's copied modules, including compiled schema and SMTP helpers |
| Maintained-source secret scan | 2.37 MB scanned, no leaks found |
| Text and diff checks | House-style and whitespace checks passed |
| Pre-commit local CodeQL | 104 queries completed, all sixteen findings assessed, no confirmed new defect |
| Fixture CodeQL recheck | Fresh extraction and all three affected queries passed, with no findings in the three corrected fixtures |
| Hosted reference suite | Passed on `3ebf743`, including 174 tests and nine container checks. Required again on the final follow-up commit |
| Hosted CodeQL | Analysis passed on `3ebf743`, with three fixture alerts triggering the separate alert check. Required again after fixture corrections |
| Development container | Hosted build and nine service checks passed on `3ebf743`. Docker is unavailable locally |
| Real deployment acceptance | Unrun |
| Independent assurance | Open |

The production layout check recreates the Docker dependency-install and copy layout in an isolated directory. It does not execute an image. The earlier baseline passed 129 tests, but its fresh dependency audit and the two security probes failed. Passing historical CI cannot replace hosted checks for the corrected commit.

The full local CodeQL run used CLI 2.23.9 and query pack 2.2.4. It covered all 100 selected JavaScript/TypeScript files and both Actions files. Its sixteen findings retain individual dispositions covering fixed-file example uploads, generated public TLS certificates, private test evidence, escaped fixture HTML, non-authorising test observers, explicit CLI export and the counter demonstration's documented private-directory assumption. That extraction archive contains 120 repository files, all matching the validated source bytes. A fresh extraction after the fixture corrections reran the three affected queries, with no findings in those fixtures. Current hosted analysis remains required.

House-style passed all changed prose and code comments, the two archived installation guides and the prepared PR description. The guides retain their historical commands and incompatibility warnings. Character and provenance checks passed. The documentation regression verifies the corrected links separately.

## Release gates

[Deployment acceptance](https://github.com/haiprotocol/haip/issues/10) remains unrun. It requires real identity and TLS, independently administered immutable storage and effective writer permissions, conflict and outage exercises, notifications, monitoring, encrypted restoration and restart and rollback checks. Local fixtures and prepared deployment templates do not supply that evidence.

[Independent assurance](https://github.com/haiprotocol/haip/issues/11) remains open. A separately accountable reviewer must assess the final source and a separate implementation, record findings and residual risk, and verify that no critical or high finding remains unresolved. Internal reviews, models and conformance tests support that review but do not meet the independence requirement.

Keep the contract and packages at `2.0.0-draft.3` during preparation. A reviewed draft source change needs passing checks on its final commit. Stable publication and production deployment require both external gates and explicit release authorisation.
