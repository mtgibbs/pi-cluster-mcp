#!/usr/bin/env bash
# Gate for specs/pihole-secondary-stats-panels — must FAIL on today's tree.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

CLIENT=src/clients/pihole.ts
TOOL=src/tools/dns.ts
TEST_FILE=src/__tests__/pihole-secondary.test.ts
AUTH_TEST=src/__tests__/pihole-auth.test.ts
REPORT=/tmp/pihole-secondary-vitest.json

fails=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fails=$((fails + 1)); }

check_has() { # file, pattern, label
  if grep -qE -- "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3"; fi
}

check_absent() { # file, pattern, label
  if grep -qE -- "$2" "$1" 2>/dev/null; then bad "$3"; else ok "$3"; fi
}


# Literal must live inside the body of the named test — from its `it('<title>'` line until the next
# it/test/describe — so a passing test cannot borrow another test's assertion, and the match is a
# whole line (optional indentation and trailing semicolon) so a stray substring or a commented-out
# assertion cannot satisfy it.
check_line_in_test() { # file, it-title, literal, label
  local esc
  esc=$(printf '%s' "$3" | sed 's/[][\.^$*+?(){}|\\]/\\&/g')
  if awk -v t="$2" '
      index($0, "'"'"'" t "'"'"'") { inside = 1; next }
      inside && /^[[:space:]]*(it|test|describe)[[:space:]]*[.(]/ { inside = 0 }
      inside { print }
    ' "$1" | grep -qE "^[[:space:]]*${esc}[[:space:]]*(;[[:space:]]*)?$"; then
    ok "$4"
  else
    bad "$4"
  fi
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
check_absent "$TOOL" '\bsid\b|csrf|password' \
  "src/tools/dns.ts leaks no session/credential material (no sid/csrf/password)"

# --- Behaviour: the new tests must exist and pass ----------------------------
if [ ! -f "$TEST_FILE" ]; then
  bad "new test file $TEST_FILE exists"
else
  ok "new test file $TEST_FILE exists"

  rm -f "$REPORT"
  npx vitest run "$TEST_FILE" --reporter=json --outputFile="$REPORT" >/tmp/pihole-secondary-vitest.log 2>&1
  vitest_status=$?
  if [ "$vitest_status" -ne 0 ] || [ ! -s "$REPORT" ]; then
    bad "vitest run $TEST_FILE passes (exit $vitest_status)"
    tail -50 /tmp/pihole-secondary-vitest.log
  else
    ok "vitest run $TEST_FILE passes (exit 0)"
  fi

  # Machine-readable gate on the vitest JSON report: exactly 7 passed, 0 failed, 0 skipped/pending,
  # and the assertion titles are exactly the seven named tests. Title text from the default reporter
  # is not used, so it.skip / empty tests / renamed tests cannot satisfy this.
  node - "$REPORT" <<'NODE'
const fs = require('fs');
const want = [
  'polls every configured Pi-hole instance',
  'logs in to the secondary separately from the primary',
  'sums query totals across instances and reports per-instance health',
  'reports a failed instance instead of dropping all stats',
  'fails loudly for the instance whose credential is rejected, not silently',
  'logs in at most once per host under concurrent fan-out',
  'keeps single-instance behaviour when PIHOLE_URLS is unset',
];
let rep;
try {
  rep = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (e) {
  console.log('FAIL: vitest JSON report is readable (' + e.message + ')');
  process.exit(1);
}
const results = rep.testResults || [];
let fails = 0;
const asserts = results.flatMap((f) => f.assertionResults || []);
const passed = asserts.filter((a) => a.status === 'passed').map((a) => a.title);
const failed = asserts.filter((a) => a.status === 'failed').map((a) => a.title);
const skipped = asserts.filter((a) => a.status === 'skipped' || a.status === 'pending' || a.status === 'todo').map((a) => a.title);
const check = (cond, label) => { if (!cond) fails++; console.log((cond ? 'PASS: ' : 'FAIL: ') + label); };
check(passed.length === 7 && failed.length === 0 && skipped.length === 0,
  `report shows exactly 7 passed / 0 failed / 0 skipped (got ${passed.length}/${failed.length}/${skipped.length})`);
check(skipped.length === 0, 'no test is it.skip / todo (skipped: ' + (skipped.join(', ') || 'none') + ')');
for (const t of want) {
  check(passed.includes(t), `test passed with the exact title: ${t}`);
}
const extra = passed.filter((t) => !want.includes(t));
check(extra.length === 0, 'no un-named extra tests in the file (extra: ' + (extra.join(', ') || 'none') + ')');
if (fails > 0) { process.exitCode = 1; }
NODE
  node_status=$?
  if [ "$node_status" -ne 0 ]; then
    bad "vitest JSON report gate (exit $node_status)"
  fi

  # Pinned expected literals (spec.md §11). Each is a whole-line assertion that must appear inside
  # the body of the named test, so a passing test cannot borrow another test's assertion and a
  # commented-out or stray occurrence cannot satisfy the gate. Different fixture numbers per
  # instance make "summed" distinguishable from "first/last one wins"; exact per-host call counts
  # make an upper bound impossible.
  for lit in \
    'http://pihole-primary.test' \
    'http://pihole-secondary.test' \
    'http://pihole-third.test' \
    'sid-primary-aaa' \
    'sid-secondary-bbb' \
    'sid-third-ccc' \
    ; do
    if grep -qF -- "$lit" "$TEST_FILE"; then
      ok "test file uses fixture value: $lit"
    else
      bad "test file uses fixture value: $lit"
    fi
  done

  check_line_in_test "$TEST_FILE" 'polls every configured Pi-hole instance' \
    'expect(authCalls).toHaveLength(3)' \
    "test 1 pins 3 auth calls (one per configured host)"
  check_line_in_test "$TEST_FILE" 'sums query totals across instances and reports per-instance health' \
    'expect(stats.queriesToday).toBe(140)' \
    "test 3 pins the summed queriesToday 140 (100+40)"
  check_line_in_test "$TEST_FILE" 'sums query totals across instances and reports per-instance health' \
    'expect(stats.blockedToday).toBe(15)' \
    "test 3 pins the summed blockedToday 15 (10+5)"
  check_line_in_test "$TEST_FILE" 'sums query totals across instances and reports per-instance health' \
    'expect(stats.instances).toHaveLength(2)' \
    "test 3 pins two per-instance entries"
  check_line_in_test "$TEST_FILE" 'reports a failed instance instead of dropping all stats' \
    "expect(stats.instancesFailed).toEqual(['http://pihole-secondary.test'])" \
    "test 4 pins instancesFailed to exactly the failed URL"
  check_line_in_test "$TEST_FILE" 'reports a failed instance instead of dropping all stats' \
    'expect(stats.instancesResponded).toBe(1)' \
    "test 4 pins instancesResponded 1 with one host down"
  check_line_in_test "$TEST_FILE" 'reports a failed instance instead of dropping all stats' \
    'expect(stats.instances[1].queriesToday).toBe(0)' \
    "test 4 pins the failed instance's counter to 0 (no data != traffic)"
  check_line_in_test "$TEST_FILE" 'fails loudly for the instance whose credential is rejected, not silently' \
    'expect(stats.instances[1].error).toMatch(/auth failed/i)' \
    "test 5 pins a per-instance auth error string (#44 per instance)"
  check_line_in_test "$TEST_FILE" 'fails loudly for the instance whose credential is rejected, not silently' \
    "expect(stats.instances[1].error).toContain('PIHOLE_API_TOKEN')" \
    "test 5 names PIHOLE_API_TOKEN in the per-instance error"
  check_line_in_test "$TEST_FILE" 'logs in at most once per host under concurrent fan-out' \
    'expect(authCalls).toHaveLength(2)' \
    "test 6 pins exactly one login per host under fan-out (#48 shape)"
  check_line_in_test "$TEST_FILE" 'keeps single-instance behaviour when PIHOLE_URLS is unset' \
    'expect(stats.instancesTotal).toBe(1)' \
    "test 7 pins single-instance fallback when PIHOLE_URLS is unset"
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "RESULT: $fails check(s) failed"
  exit 1
fi
echo "RESULT: all checks passed"
exit 0
