# Spec: Poll every Pi-hole instance in `get_dns_status` (primary + secondary)

## 1. Why · [R]

`src/clients/pihole.ts` reads a single `PIHOLE_URL` (default `http://pihole-web.pihole.svc.cluster.local`),
whose Service selects `app: pihole`. The secondary resolver runs as `app: pihole-secondary` and has
no URL at all, so the client never talks to it. On our HA DNS the numbers `get_dns_status` reports
are those of one of two resolvers, and a secondary-only auth or health problem is invisible.

## 2. Outcomes · [R]

1. `get_dns_status` queries **every** configured Pi-hole instance, not just the primary, and reports
   per-instance query counters in `result.stats.instances` — so a secondary-only failure shows up.
2. `result.stats.queriesToday` / `blockedToday` are the **sum** across the instances that answered,
   with `stats.instancesResponded` / `stats.instancesTotal` alongside so the reader knows how many
   instances the totals cover.
3. Each instance is **authenticated with its own session**: the secondary's API calls carry the sid
   returned by the secondary's own `POST <secondary>/api/auth`, never the primary's.
4. A single unreachable instance does not fail the tool: the healthy ones still return stats and the
   failed one is listed in `result.stats.instancesFailed`.
5. When **no** instance answers, `result.stats` is still present with `queriesToday` `0`,
   `blockedToday` `0`, `instancesResponded` `0` and every configured URL listed in `instancesFailed`;
   `result.statsError` is **not** set. This case is normative (§11) but has no dedicated `it()` block
   or verify.sh literal — tests 4 and 5 already pin that failures are listed and healthy numbers
   survive.
6. With `PIHOLE_URLS` unset the totals, the queried host and the per-instance view are what they are
   for a one-instance cluster today (`instancesTotal` 1, `instancesResponded` 1, `queriesToday` equal
   to that instance's `queries.total`) — existing deployments are unaffected.

## 3. Entities · [E]

- Env var **`PIHOLE_URLS`** — comma-separated list of instance base URLs, in order; **first entry is
  the primary**. Precedence: if `PIHOLE_URLS` is set and non-empty after trimming, it is the whole
  list and `PIHOLE_URL` is ignored; otherwise (unset, empty, or only commas/whitespace) the list is
  `[PIHOLE_URL]`, which keeps today's default `http://pihole-web.pihole.svc.cluster.local`. Empty
  entries (`"a,,b"`) and surrounding whitespace (`" a , b "`) are dropped/trimmed; duplicates are
  kept as written (no de-duplication logic).
- Client type **`PiholeInstanceStats`** (exported from `src/clients/pihole.ts`):
  `{ url: string; ok: boolean; error?: string; summary?: PiholeStats }` — `error` is the failure
  reason for that instance, present exactly when `ok` is false.
- Client type **`PiholeInstanceCounters`**: `{ url: string; ok: boolean; queriesToday: number; blockedToday: number; error?: string }`
  — the shape the tool puts in `result.stats.instances`. `queriesToday` / `blockedToday` are **`0`
  when that instance failed** (so "no data" never reads as "no traffic" only by absence of a key).
- Exported function **`getAllSummaries(): Promise<PiholeInstanceStats[]>`** — one entry per
  configured instance, in config order; a failed instance yields `{ url, ok: false, error }`.
- Exported function **`getStatsInstances(topCount?: number): Promise<PiholeMultiStats>`** — what
  `get_dns_status` calls instead of `getFullStats`. `PiholeMultiStats` extends `PiholeFullStats` and
  adds `instances: PiholeInstanceCounters[]`, `instancesTotal: number`, `instancesResponded: number`,
  `instancesFailed: string[]` (the `url`s of the failed instances, config order).
- **Non-primary fields come from the primary** (first configured instance that answered, else the
  first configured instance): `status`, `blockedPercentage`, `domainsBlocked`, `uniqueDomains`,
  `queriesForwarded`, `queriesCached`, `uniqueClients`, `gravityUpdated`, `topQueries`, `topBlocked`,
  `queryTypes`. Only `queriesToday` and `blockedToday` are sums. When the primary is the instance
  that failed, those non-summed fields come from the first *responding* instance; `topQueries` /
  `topBlocked` / `queryTypes` are `[]` only when **no** instance answered.
- Per-instance session state replaces the module-level `sessionId` / `sessionExpiry` / `authInFlight`
  globals: a map keyed by instance URL. `rateLimitedUntil` stays global — Pi-hole FTL throttles
  logins by client IP, so one instance's 429 legitimately suppresses logins to the others too.
- `src/tools/dns.ts` `get_dns_status` adds to `result.stats`: `instances` (array of
  `PiholeInstanceCounters`), `instancesTotal`, `instancesResponded`, `instancesFailed`. All existing
  `result.stats` keys keep their names.
- New test file: `src/__tests__/pihole-secondary.test.ts`.

## 4. Approach · [A]

Turn the client's single-URL module state into per-URL session state, derive the instance list from
`PIHOLE_URLS` (fallback `[PIHOLE_URL]`), and add `getAllSummaries()` which fans out over the list and
returns one `PiholeInstanceStats` per instance with per-instance error capture. `getStatsInstances()`
sums `dns_queries_today` / `ads_blocked_today` across the instances that answered, takes every other
stats field from the primary (first responder), and reports the per-instance counters plus
total/responded/failed. `get_dns_status` switches its `getFullStats(5)` call to `getStatsInstances(5)`
and surfaces the per-instance list; its existing `statsError` catch stays for the K8s/fatal path.
Single-flight login stays per instance, so one burst performs at most one login per host.

Rejected: a **new tool** (operators already look at `get_dns_status`; a new tool means registry and
read-only-scope changes); **discovering instances by pod label** (couples the API client to pod
naming and breaks outside the cluster); **`k8s/` manifest changes** (ops sets `PIHOLE_URLS` in the
deployment env separately); **merging `topQueries`/`topBlocked` across instances** (would publish
counts no single Pi-hole agrees with); **fanning `get_pihole_whitelist` / `get_pihole_queries` /
`update_pihole_gravity` out to every instance** (the idea is stats observability; gravity triggers are
writes and belong to a different change).

## 5. Scope · [S]

**In scope:** `src/clients/pihole.ts`, `src/tools/dns.ts` (the `get_dns_status` stats block only),
`src/__tests__/pihole-secondary.test.ts`.

**Out of scope:** `k8s/` manifests, `package.json`, CI, auth middleware, tool registration
(`src/tools/index.ts`), `get_pihole_whitelist` / `get_pihole_queries` / `update_pihole_gravity`
behaviour, other test files (they must keep passing unchanged).

## 6. Prior facts · [S]

All line numbers are `git show 94902a6a` (the base commit of this run); match on the symbol names if
the file shifts.

- `src/clients/pihole.ts` l.4 — `const PIHOLE_URL = process.env.PIHOLE_URL || 'http://pihole-web.pihole.svc.cluster.local';`
  read once at import. Session state is module-level: `sessionId`, `sessionExpiry` (l.8–9),
  `authInFlight` (l.11), `rateLimitedUntil` (l.13).
- `authenticate()` l.124 — session cache, global rate-limit gate, then single-flight around `login()`.
- `login()` l.174 — `POST ${PIHOLE_URL}/api/auth`; 429 sets `rateLimitedUntil` and says "throttling,
  NOT a bad credential"; non-OK throws `Pi-hole auth failed: … PIHOLE_API_TOKEN must equal …`; a
  response with `session.valid`/`session.sid` missing throws `Pi-hole auth rejected`.
- `piholeFetch()` l.231 — `GET ${PIHOLE_URL}/api/${endpoint}` with the `sid` header when auth is needed.
- `convertStatsToLegacy()` l.283 maps `queries.total → dns_queries_today`, `queries.blocked → ads_blocked_today`;
  `getSummary()` l.315 fetches `stats/summary` **with** auth; `getFullStats()` l.470 runs
  `getSummary` + `getTopItems` + `getQueryTypes` into `{ summary, topQueries, topBlocked, queryTypes }`.
- `src/tools/dns.ts` — the stats block starts at the `if (includeStats && piholePods.some((p) => p.ready))`
  gate (l.69); inside it calls `getFullStats(5)` + `getMessages()` (l.70–73) and builds
  `result.stats` (l.74–92); the `catch (statsError)` (l.98) sets `result.statsError` and returns the
  pod lists. So today **any** failure in that block drops the whole stats section.
- `src/__tests__/pihole-auth.test.ts` is the existing client-test pattern: stub `PIHOLE_URL` /
  `PIHOLE_API_TOKEN`, stub global `fetch`, `vi.resetModules()` and re-import so module-level consts
  are re-read. Its `stats/summary` fixture is `total: 100, blocked: 10`, so a second instance must use
  visibly different numbers.
- `src/__tests__/write-tool-gates.test.ts` l.39 mocks `../clients/pihole.js` with `getFullStats`,
  `getMessages`, `updateGravity`, `getWhitelist`, `getRecentQueries` — those exports must keep their
  names so that mock keeps working.
- `CLAUDE.md` — "If a tool states a conclusion, it must be correct — small models repeat tool
  conclusions verbatim"; the summary-first conventions apply to *list* tools, and `get_dns_status` is
  not a list tool, so no `detail` param is added here.

## 7. Norms · [N]

- Keep `getFullStats`, `getSummary`, `getStatus`, `getMessages`, `getWhitelist`, `getRecentQueries`,
  `updateGravity` exported with their current signatures; `getFullStats` and the whitelist/query/gravity
  tools keep hitting the primary (first configured instance).
- Error text style from #44/#48 is preserved per instance: auth failures name `PIHOLE_API_TOKEN`,
  429 stays "throttling, NOT a bad credential", and every per-instance `error` string starts with the
  instance URL (e.g. `http://pihole-secondary.test: Pi-hole auth failed: 401 …`).
- Tests: vitest, no network — `vi.stubGlobal('fetch', …)` plus a fresh `vi.resetModules()` import per
  test (`pihole-auth.test.ts`), and handler-level tests via `tools.find(t => t.name === …)` with
  `vi.mock('../clients/kubernetes.js', …)` for `listPods` (`summary.test.ts`, `write-tool-gates.test.ts`).
- No new dependencies; `npm run lint` / `typecheck` / `test` / `build` stay green.

## 8. Safeguards · [S]

- No secrets in output: `instances[].url` is a base URL only — never the sid, the password, or
  request headers. `src/tools/dns.ts` must not contain the strings `sid`, `csrf` or `password`.
- Fail **closed** on auth per instance: a rejected credential must surface as that instance's `error`
  (matching `/auth failed/i` and naming `PIHOLE_API_TOKEN`), never as a silent null session (#44) —
  and must not take the healthy instance's numbers with it.
- `readOnly` on `get_dns_status` stays `true`; no new tool is registered, so `readonly-scope.test.ts`
  and the write gates are untouched.
- No per-instance login storms: single-flight is keyed per instance URL, so one `get_dns_status` run
  performs **exactly one** `POST /api/auth` per configured host (§11 test 6).

## 9. Tasks · [O]

- T1: Refactor `src/clients/pihole.ts` to per-instance session state and a `PIHOLE_URLS`-derived
  instance list (precedence + trimming rules in §3; fallback `[PIHOLE_URL]`).
- T2: Add `PiholeInstanceStats`, `PiholeInstanceCounters`, `getAllSummaries()` and
  `getStatsInstances()` to `src/clients/pihole.ts` with per-instance error capture, summed
  `dns_queries_today` / `ads_blocked_today` and primary-sourced remaining fields.
- T3: Make `get_dns_status` in `src/tools/dns.ts` call `getStatsInstances(5)` and surface
  `instances` / `instancesTotal` / `instancesResponded` / `instancesFailed`, keeping every existing
  stats key.
- T4: Add `src/__tests__/pihole-secondary.test.ts` with the **seven** tests named in §11, using the
  exact fixtures and expected values there.
- T5: Run `npm run lint && npm run typecheck && npm test && npm run build`, then
  `bash specs/pihole-secondary-stats-panels/verify.sh`, confirming `pihole-auth.test.ts` and
  `write-tool-gates.test.ts` still pass unchanged.

## 10. Acceptance criteria (EARS) · [O]

- **AC1** When `PIHOLE_URLS` lists three URLs and the stats block runs, the system shall issue
  `POST /api/auth` exactly once per host, on each host's own base URL (3 auth calls total).
- **AC2** When the secondary answers, the system shall send its stats request with the `sid` returned
  by the **secondary's** auth response, and that sid shall differ from the primary's.
- **AC3** When both instances report stats, `stats.queriesToday` and `stats.blockedToday` shall be the
  sums across instances (100+40 = `140`, 10+5 = `15`), `stats.instances` shall have length 2 with
  per-instance `queriesToday` 100 and 40, `instancesResponded` shall be 2 and `instancesFailed` empty.
- **AC4** When one instance's `/api/auth` answers 500, the tool shall return `instancesResponded` 1,
  `instancesTotal` 2, `instancesFailed` exactly `['http://pihole-secondary.test']`, the failed entry
  `ok: false` with a non-empty `error` containing that URL, the healthy entry `queriesToday` 100, and
  the failed entry's counters `0`.
- **AC5** If an instance rejects the password (401), that instance's entry shall have `ok: false` and
  an `error` matching `/auth failed/i` that contains `PIHOLE_API_TOKEN`, while the healthy instance
  still reports `queriesToday` 100.
- **AC6** If `PIHOLE_URLS` is unset, empty, or only whitespace/commas, the system shall query only
  `PIHOLE_URL` and report `instancesTotal` 1, `instancesResponded` 1, `queriesToday` equal to that
  instance's `queries.total`.
- **AC7** When `PIHOLE_URLS` lists two healthy hosts and the stats block runs once, the system shall
  make exactly 2 auth calls — one per host — never 1 (shared session) and never more than 2.
- **AC8** If **no** configured instance answers, the system shall still return `result.stats` with
  `queriesToday` 0, `blockedToday` 0, `instancesResponded` 0, `instancesTotal` equal to the number of
  configured instances, `instancesFailed` listing every configured URL, and shall not set
  `result.statsError`. This criterion is normative (§11): it is covered by the same per-instance
  failure path that AC4/AC5 pin, not by its own `it()` block.

## 11. Verification

`verify.sh` runs these checks, each of which can fail:

1. **Static presence** (all absent on today's tree, so the gate fails before implementation):
   `PIHOLE_URLS`, `getAllSummaries`, `getStatsInstances` in `src/clients/pihole.ts`; `getStatsInstances`,
   `instancesResponded`, `instancesFailed`, `instancesTotal` in `src/tools/dns.ts`.
2. **Safeguard**: `src/tools/dns.ts` contains none of `sid`, `csrf`, `password` — fails if session
   material is echoed into tool output (§8).
3. **Regression**: `src/__tests__/pihole-auth.test.ts` still contains its #48 title
   `performs ONE login for a burst of concurrent requests` — fails if the refactor deletes existing
   auth tests to go green.
4. **Machine-readable vitest run**: `npx vitest run src/__tests__/pihole-secondary.test.ts --reporter=json
   --outputFile=…`, then a Node check on the JSON report asserting **exactly** `numPassedTests === 7`,
   `numFailedTests === 0`, `numPendingTests === 0` and that the set of assertion titles equals the seven
   titles below (all `status: "passed"`). This cannot pass with `it.skip`, empty or removed tests, and
   does not depend on reporter text.
5. **Pinned assertion literals**: each is a whole-line grep (anchored, whitespace-tolerant, optional
   trailing semicolon) restricted to the **body of the named test** — from its `it('<title>'` line
   until the next `it`/`test`/`describe` — so a stray substring, a commented-out assertion, or an
   assertion living in a different test cannot satisfy it.

Test file `src/__tests__/pihole-secondary.test.ts`. Fixtures — deliberately different per instance so
"summed" cannot be confused with "first one wins" or "last one wins"; sids differ per host:

| | primary `http://pihole-primary.test` | secondary `http://pihole-secondary.test` | third `http://pihole-third.test` |
|---|---|---|---|
| auth sid | `sid-primary-aaa` | `sid-secondary-bbb` | `sid-third-ccc` |
| `queries.total` | `100` | `40` | `20` |
| `queries.blocked` | `10` | `5` | `2` |

Handler-level tests stub `listPods` to return a Ready pod named `pihole-pod-a` (so the stats gate in
`src/tools/dns.ts` opens) plus `unbound-pod-a`, and reach the handler via
`tools.find(t => t.name === 'get_dns_status')`. Client-level tests call the exported client functions
directly after `vi.resetModules()`.

| # | Exact `it()` title | Level | Asserts (fixture → expected) | Fails when |
|---|---|---|---|---|
| 1 | `polls every configured Pi-hole instance` | client | `PIHOLE_URLS` = primary + secondary + third; `getAllSummaries()` → total auth calls `toHaveLength(3)`; per-host auth call buckets each `toHaveLength(1)`; per-host `stats/summary` buckets each `toHaveLength(1)` | client still queries one URL; a host is skipped (bucket length 0) |
| 2 | `logs in to the secondary separately from the primary` | client | same 3-host config → secondary's `stats/summary` request `headers.sid` is `'sid-secondary-bbb'`, primary's is `'sid-primary-aaa'`, third's is `'sid-third-ccc'`, and primary sid `!==` secondary sid | one login reused across hosts; secondary fetched unauthenticated |
| 3 | `sums query totals across instances and reports per-instance health` | handler | `PIHOLE_URLS` = primary + secondary → `stats.queriesToday` `toBe(140)`, `stats.blockedToday` `toBe(15)`, `stats.instances` `toHaveLength(2)`, `instances[0].queriesToday` `toBe(100)`, `instances[1].queriesToday` `toBe(40)`, `instancesResponded` `toBe(2)`, `instancesTotal` `toBe(2)`, `instancesFailed` `toHaveLength(0)` | primary-only (100/10); last-wins (40/5); aggregate-only (no per-instance counters) |
| 4 | `reports a failed instance instead of dropping all stats` | handler | secondary `/api/auth` → 500: `instancesResponded` `toBe(1)`, `instancesTotal` `toBe(2)`, `instancesFailed` `toEqual(['http://pihole-secondary.test'])`, `instances[1].ok` `toBe(false)`, `instances[1].queriesToday` `toBe(0)`, `instances[1].error` contains `'http://pihole-secondary.test'` and is non-empty, `queriesToday` `toBe(100)` | one dead instance drops the stats block (today's `statsError` path); failure swallowed (`instancesFailed` empty, totals 140) |
| 5 | `fails loudly for the instance whose credential is rejected, not silently` | handler | secondary `/api/auth` → 401: `instances[1].ok` `toBe(false)`, `instances[1].error` matches `/auth failed/i` **and** contains `PIHOLE_API_TOKEN`, `instances[0].ok` `toBe(true)`, `queriesToday` `toBe(100)` | rejected session swallowed to null (#44); one bad host zeroing the healthy one |
| 6 | `logs in at most once per host under concurrent fan-out` | handler | `PIHOLE_URLS` = primary + secondary, both healthy, one `get_dns_status` call → total auth calls `toHaveLength(2)` (exactly one per host) | single-flight dropped → >2 auth calls (re-arms FTL's limiter, #48); single-flight global → 1 auth call, i.e. one host's session reused |
| 7 | `keeps single-instance behaviour when PIHOLE_URLS is unset` | handler | only `PIHOLE_URL` = `http://pihole-primary.test` (no `PIHOLE_URLS`) → auth calls `toHaveLength(1)`, `instancesTotal` `toBe(1)`, `instancesResponded` `toBe(1)`, `queriesToday` `toBe(100)`, and no request URL contains `pihole-secondary` | `PIHOLE_URL` fallback dropped; a second host invented when none was configured |

The **all-instances-failed** case (AC8) is a normative rule with no separate `it()` block and no
verify.sh literal: when no configured instance answers, `getStatsInstances()` returns
`queriesToday` 0, `blockedToday` 0, `instancesResponded` 0 and `instancesFailed` listing every
configured URL, and `get_dns_status` keeps the `stats` block instead of setting `statsError`. It is
stated here rather than gated because the tool-level behaviour is already pinned by tests 4 and 5
(failure entries listed, healthy numbers preserved) and a zero-instance case adds no new assertion
the two do not already imply.

The literals verify.sh pins, each as a whole line that must appear inside the body of the named test
(so a passing test cannot borrow another test's assertion):

- test 1: `expect(authCalls).toHaveLength(3)`
- test 3: `expect(stats.queriesToday).toBe(140)` · `expect(stats.blockedToday).toBe(15)` ·
  `expect(stats.instances).toHaveLength(2)`
- test 4: `expect(stats.instancesFailed).toEqual(['http://pihole-secondary.test'])` ·
  `expect(stats.instancesResponded).toBe(1)` · `expect(stats.instances[1].queriesToday).toBe(0)`
- test 5: `expect(stats.instances[1].error).toMatch(/auth failed/i)` ·
  `expect(stats.instances[1].error).toContain('PIHOLE_API_TOKEN')`
- test 6: `expect(authCalls).toHaveLength(2)`
- test 7: `expect(stats.instancesTotal).toBe(1)`
- fixtures: `sid-primary-aaa`, `sid-secondary-bbb`, `sid-third-ccc`, `http://pihole-primary.test`,
  `http://pihole-secondary.test`, `http://pihole-third.test`

`verify.sh` does **not** grep `k8s/` — manifests are out of scope (§4).

## 12. Open questions

- Should `PIHOLE_URLS` also drive `update_pihole_gravity`, `get_pihole_whitelist` and
  `get_pihole_queries`? This spec leaves them on the primary; a follow-up could fan them out.
- Real deployment values for `PIHOLE_URLS` (in-cluster Service DNS vs. `192.168.1.55` / `.56`) are an
  ops decision outside this change.
