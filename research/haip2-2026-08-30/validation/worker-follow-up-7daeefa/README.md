# Worker and boundary regression evidence

Source commit: `7daeefacb04891a610ebaea0b23bb942fec55782`.
Source tree: `232e59806ae3f78e0d90e7c178627b7a41402668`.

These records address the review of HAIP draft PR #5 at `67b6f17` and remain
separate from the earlier 46-test and 68-test records.

- [Clean-copy validation](local/manifest.json): 85 passing tests, 25 primitive
  cross-language comparisons, zero known production dependency vulnerabilities,
  four package dry runs and reviewed secret findings. All 459 tracked files were
  unchanged after the checks. Dependencies were freshly installed with `npm ci`.
- [Publication checks](publication/manifest.json): 12 declared hash pairs, 128
  original HAIP 1 source files, 105 historical research files and the four earlier
  migrations remain unchanged. All 73 MDX pages parse, with 27 live pages, 41
  redirects and 322 internal links checked at the source revision above.
- [Hosted validation](hosted/manifest.json): [run 33342151204](https://github.com/haiprotocol/haip/actions/runs/33342151204)
  passed the same 85-test suite, comparisons, audit and package checks, then built
  the development image and passed nine packaged-service checks. Its PR merge tree
  matches the clean-copy tree above; downloaded artifact bytes match GitHub's digest.

The local manifest records runtime versions, command outcomes, source hashes and
original evidence hashes. Machine-specific roots are replaced in retained text;
screenshots are retained byte-for-byte. The app is visibly populated and its
stored payload is expanded before the complete frozen candidate is confirmed.
An earlier local run exposed missing off-screen iframe pixels in a full-page
screenshot. Capture now expands the actual viewport temporarily and restores it
before confirmation; production headers and app content were not weakened or edited.

The publication records preserve their original bytes. In
[claims.json](publication/claims.json), `prior_review_record` is the relative path
used in the original local audit folder, not a link within this retained bundle.
Its matching [prior claims record](publication/prior-claims.json) is included here
byte-for-byte, with SHA-256
`071e9ae8d3460c9b51cf793716c782be8ed35c68a5c8718494bb9820b4ea497d`.
Both publication reviews exclude the authentication implementation; its runtime
regressions are covered by the local and hosted suites above, with independent
security review still outstanding.

The [evidence scan](evidence-scan.json) records the review of the newly retained
files. Hash-like scanner findings are checked against the corresponding source
blobs, rather than described as a zero-finding scan. The hosted container uses
local PostgreSQL and OIDC fixtures; Compose configuration was validated, while
runtime smoke used disposable Linux containers and host networking.

Fixtures do not prove production identity, Azure permissions, independent
administration, deployed recovery or Plasm integration. No cloud resource, merge,
package or image publication, or deployment is included.
