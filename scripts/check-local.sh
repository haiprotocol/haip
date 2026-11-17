#!/bin/sh
set -eu

export HAIP_TEST_CADDY="${HAIP_TEST_CADDY:-caddy}"
export HAIP_TEST_DEX="${HAIP_TEST_DEX:-dex}"

for tool in "$HAIP_TEST_CADDY" "$HAIP_TEST_DEX" openssl htpasswd promtool prometheus alertmanager; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required local check tool is missing (%s)\n' "$tool" >&2
    exit 1
  fi
done

promtool test rules deployment/alerts.test.yml
npm run check
node --import tsx --test --test-concurrency=1 tests/dex-oidc.integration.ts tests/alerts.integration.ts
