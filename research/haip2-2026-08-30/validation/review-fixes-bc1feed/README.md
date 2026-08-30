# Review regression evidence

Source commit: `bc1feed4aac1dbe5ea6e47d2c9ad5ce8dd9f9fcd`.
Source tree: `4b689e8c54625feec1bbce8847ee11cb1cf3471b`.

These records follow the review of HAIP draft PR #5 at `7e58dece5fe4c93afa33fe42cbc062e8be102141`.
They do not replace or update the original 46-test records.

- [Clean-copy validation](local/manifest.json): 68 tests, 25 primitive cross-language
  comparisons, zero known production dependency vulnerabilities, four package dry
  runs and a reviewed secret scan. All 416 tracked files remained unchanged after
  the checks. Source files came from an exported Git index, not the working tree.
- [Publication checks](publication/manifest.json): all 12 publication-ledger hash
  pairs, 128 unchanged HAIP 1 source files, seven unchanged historical CI files,
  27 distinct live guides, 41 redirects, 292 internal targets and 73 MDX parses.
- [Hosted validation](hosted/manifest.json): [run 33339089387](https://github.com/haiprotocol/haip/actions/runs/33339089387)
  passed the same suite and built the development image. Nine additional checks
  exercised its runtime, context exclusions, bootstrap, OIDC login, signed review
  and isolation headers. The downloaded artifact digest was verified before
  retaining its files. GitHub's PR merge checkout has the exact source tree above.

The local and hosted manifests preserve actual runtime versions and file hashes.
Selected logs omit transport formatting and replace machine-specific roots; the
manifests retain hashes of the original log bytes. Historical outcome records are
unchanged. The screenshots show the populated app and complete frozen candidate
before confirmation; injected script strings are intentional escaping-test inputs.

The container uses disposable PostgreSQL and OIDC fixtures. Compose configuration
was validated, while the runtime smoke used Linux Docker containers with host
networking. Hosted documentation rendering, real provider permissions, independent
Azure administration, production restore and Plasm integration remain unvalidated.
No image/package publication, deployment, paid resource or merge is included.
