#!/usr/bin/env bash
# Gate for spec pihole-secondary-stats (issue #45): Pi-hole stats must cover every
# configured instance, not just the primary behind PIHOLE_URL.
# Run from repo root: STRICT=1 bash specs/pihole-secondary-stats/verify.sh

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

TEST=src/__tests__/pihole-multi-instance.test.ts
CLIENT=src/clients/pihole.ts
DNS=src/tools/dns.ts

PASS=0
FAIL=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

run_vitest() {
  npx vitest run "$1" >/dev/null 2>&1
}

# --- shape of the new client surface -------------------------------------
check "PIHOLE_URLS env var read in $CLIENT" grep -q "PIHOLE_URLS" "$CLIENT"
check "getPiholeUrls exported from $CLIENT" grep -Eq "export (async )?function getPiholeUrls" "$CLIENT"
check "PiholeInstanceStats exported from $CLIENT" grep -Eq "export (interface|type) PiholeInstanceStats" "$CLIENT"
check "getFullStatsPerInstance exported from $CLIENT" grep -Eq "export (async )?function getFullStatsPerInstance" "$CLIENT"
check "aggregateStats exported from $CLIENT" grep -Eq "export (async )?function aggregateStats" "$CLIENT"

# --- the tool must actually consume the multi-instance client -------------
check "$DNS imports getFullStatsPerInstance" grep -q "getFullStatsPerInstance" "$DNS"
check "$DNS surfaces per-instance results in get_dns_status" grep -q "instances" "$DNS"

# --- the named regression tests exist ------------------------------------
check "test file $TEST exists" test -f "$TEST"

titles=(
  "fetches every configured Pi-hole instance with its own login"
  "never reuses a session id across instances"
  "aggregates totals across instances instead of reporting one host"
  "reports a secondary auth failure instead of hiding it"
  "get_dns_status aggregates stats from both instances"
  "keeps single-host behavior when PIHOLE_URLS is unset"
)
if [ -f "$TEST" ]; then
  for t in "${titles[@]}"; do
    check "test titled '$t' exists in $TEST" grep -qF "it('$t'" "$TEST"
  done
else
  for t in "${titles[@]}"; do
    echo "FAIL: test titled '$t' exists in $TEST (file missing)"
    FAIL=$((FAIL + 1))
  done
fi

# --- pinned fixtures: distinct per-host numbers and the expected aggregates
# 1400/140 are the summed totals (1000+400 / 100+40); 1500 is max gravity.
# Identical per-host fixtures could not tell "summed" from "first wins", so the
# literals below must appear in the test file.
if [ -f "$TEST" ]; then
  for lit in "1400" "140" "1000" "400" "host-a-sid" "host-b-sid" "1500" "http://host-b.test"; do
    check "test file pins expected fixture/assertion literal '$lit'" grep -qF -- "$lit" "$TEST"
  done
else
  for lit in "1400" "140" "1000" "400" "host-a-sid" "host-b-sid" "1500" "http://host-b.test"; do
    echo "FAIL: test file pins expected fixture/assertion literal '$lit' (file missing)"
    FAIL=$((FAIL + 1))
  done
fi

# --- behaviour -----------------------------------------------------------
check "new multi-instance tests pass ($TEST)" run_vitest "$TEST"
check "existing Pi-hole auth tests still pass (#44/#48 guarantees)" run_vitest "src/__tests__/pihole-auth.test.ts"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
