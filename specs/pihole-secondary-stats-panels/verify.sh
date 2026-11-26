#!/usr/bin/env bash
# Gate for specs/pihole-secondary-stats-panels — must FAIL on today's tree.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

CLIENT=src/clients/pihole.ts
TOOL=src/tools/dns.ts
TEST_FILE=src/__tests__/pihole-secondary.test.ts
AUTH_TEST=src/__tests__/pihole-auth.test.ts
REPORT=/tmp/pihole-secondary-vitest.txt

fails=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fails=$((fails + 1)); }

check_has() { # file, pattern, label
  if grep -qE -- "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3"; fi
}

# --- Static: names this change introduces ------------------------------------
check_has "$CLIENT" 'PIHOLE_URLS' "client reads PIHOLE_URLS (multi-instance config)"
check_has "$CLIENT" 'export (async )?function getAllSummaries' "client exports getAllSummaries"
check_has "$CLIENT" 'export (async )?function getStatsInstances' "client exports getStatsInstances"
check_has "$TOOL"   'getStatsInstances' "get_dns_status calls getStatsInstances (not only getFullStats)"
check_has "$TOOL"   'instancesResponded' "get_dns_status surfaces instancesResponded"
check_has "$TOOL"   'instancesFailed' "get_dns_status surfaces instancesFailed (single-node failure visible)"
check_has "$TOOL"   'instancesTotal' "get_dns_status surfaces instancesTotal"

# Regression guard: the #44/#48 auth tests must survive the session-state refactor.
check_has "$AUTH_TEST" 'performs ONE login for a burst of concurrent requests' \
  "existing pihole-auth tests still present (refactor must not delete them to go green)"

# --- Safeguard: no session/credential material in tool output ----------------
if grep -qE 'csrf|password|\bsid\b' "$TOOL" 2>/dev/null; then
  bad "src/tools/dns.ts leaks no session/credential material (no sid/csrf/password)"
else
  ok "src/tools/dns.ts leaks no session/credential material (no sid/csrf/password)"
fi

# --- Behaviour: the new tests must exist and pass ----------------------------
if [ ! -f "$TEST_FILE" ]; then
  bad "new test file $TEST_FILE exists"
else
  ok "new test file $TEST_FILE exists"

  npx vitest run "$TEST_FILE" --reporter=default >"$REPORT" 2>&1
  vitest_status=$?
  if [ "$vitest_status" -eq 0 ] && grep -qE 'Test Files +1 passed' "$REPORT"; then
    ok "vitest run $TEST_FILE passes"
  else
    bad "vitest run $TEST_FILE passes (exit $vitest_status)"
    tail -50 "$REPORT"
  fi

  for title in \
    'polls every configured Pi-hole instance' \
    'logs in to the secondary separately from the primary' \
    'sums query totals across instances and reports per-instance health' \
    'reports a failed instance instead of dropping all stats' \
    'fails loudly for the instance whose credential is rejected, not silently' \
    'logs in at most once per host under concurrent fan-out' \
    'keeps single-instance behaviour when PIHOLE_URLS is unset' \
    ; do
    if grep -qF -- "$title" "$TEST_FILE" && grep -qF -- "$title" "$REPORT"; then
      ok "test '$title' exists and ran"
    else
      bad "test '$title' exists and ran"
    fi
  done

  # Pinned fixtures + expected values (spec.md §11): different numbers per instance so "summed"
  # cannot be confused with "first one wins", and exact per-host call counts so an upper bound
  # cannot pass at zero.
  for lit in \
    'http://pihole-primary.test' \
    'http://pihole-secondary.test' \
    'http://pihole-third.test' \
    'sid-primary-aaa' \
    'sid-secondary-bbb' \
    'sid-third-ccc' \
    'toBe(140)' \
    'toBe(15)' \
    'toHaveLength(3)' \
    'toHaveLength(2)' \
    'toHaveLength(1)' \
    'toHaveLength(0)' \
    'toBe(2)' \
    'toBe(1)' \
    'ok: false' \
    'auth failed' \
    'PIHOLE_API_TOKEN' \
    ; do
    if grep -qF -- "$lit" "$TEST_FILE"; then
      ok "test pins expected literal: $lit"
    else
      bad "test pins expected literal: $lit"
    fi
  done
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "RESULT: $fails check(s) failed"
  exit 1
fi
echo "RESULT: all checks passed"
exit 0
