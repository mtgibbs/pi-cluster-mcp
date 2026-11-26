# Spec: Poll every Pi-hole instance in `get_dns_status` (primary + secondary)

## 1. Why · [R]

`src/clients/pihole.ts` reads a single `PIHOLE_URL` (default `http://pihole-web.pihole.svc.cluster.local`),
whose Service selects `app: pihole`. The secondary resolver runs as `app: pihole-secondary` and has
no URL at all, so the client never talks to it. On our HA DNS the numbers `get_dns_status` reports
are those of one of two resolvers, and a secondary-only auth or health problem is invisible.

## 2. Outcomes · [R]

1. `get_dns_status` queries **every** configured Pi-hole instance, not just the primary, and reports
   per-instance counters in `result.stats.instances` — so a secondary-only failure shows up.
2. `result.stats.queriesToday` / `blockedToday` are the **sum** across the instances that answered,
   with `stats.instancesResponded` / `stats.instancesTotal` alongside so the reader knows how many
   instances the totals cover.
3. Each instance is **authenticated with its own session**: the secondary's API calls carry the sid
   returned by the secondary's own `POST <secondary>/api/auth`, never the primary's.
4. A single unreachable instance does not fail the tool: the healthy ones still return stats and the
   failed one is listed in `result.stats.instancesFailed` with a non-empty `error`.
5. When **no** instance answers, `getStatsInstances()` returns `queriesToday` `0`, `blockedToday` `0`,
   `instancesResponded` `0`, `instancesTotal` equal to the number of configured instances, and
   `instancesFailed` listing every configured URL in config order. Pinned by client-level test 8 (§11).
6. With `PIHOLE_URLS` unset the system queries only `PIHOLE_URL`: exactly 1 auth call,
   `instancesTotal` 1, `instancesResponded` 1, `queriesToday` equal to that instance's
   `queries.total`, and no request URL containing `pihole-secondary` (test 7).
7. With `PIHOLE_URLS` set it wins over `PIHOLE_URL`, and the list is built by trimming each entry
   and dropping empty ones (`" url-a , , url-b , "` → 2 hosts, 2 auth calls, 2 entries — test 9).

## 3. Entities · [E]

- Env var **`PIHOLE_URLS`** — comma-separated list of instance base URLs, in order; **first entry is
  the primary**. `PIHOLE_URLS` is split on commas, each entry trimmed, empty entries dropped. If the
  resulting list is non-empty it is the whole list and `PIHOLE_URL` is ignored; if it is empty
  (unset, empty string, or only commas/whitespace) the list is `[PIHOLE_URL]`, keeping today's
  default. Duplicate entries are kept as written (no de-duplication logic).
- Client type **`PiholeInstanceStats`** (exported from `src/clients/pihole.ts`):
  `{ url: string; ok: boolean; error?: string; summary?: PiholeStats }` — `error` is set when that
  instance failed. `getSummary()`'s existing behaviour (it throws when its instance is unreachable)
  is unchanged.
- Client type **`PiholeInstanceCounters`**:
  `{ url: string; ok: boolean; queriesToday: number; blockedToday: number; error?: string }` — the
  shape the tool puts in `result.stats.instances`. For a failed instance `queriesToday` and
  `blockedToday` are `0` and `error` is non-empty, so a dead host reads as "no data" rather than
  silently contributing traffic.
- Exported function **`getAllSummaries(): Promise<PiholeInstanceStats[]>`** — one entry per configured
  instance, in config order; a failed instance yields `{ url, ok: false, error }`.
- Exported function **`getStatsInstances(topCount?: number): Promise<PiholeMultiStats>`** — what
  `get_dns_status` calls instead of `getFullStats`. `PiholeMultiStats` extends `PiholeFullStats` and
  adds `instances: PiholeInstanceCounters[]`, `instancesTotal: number`, `instancesResponded: number`,
  `instancesFailed: string[]` (URLs of failed instances, config order).
- **Only `queriesToday` and `blockedToday` are aggregated.** Every other key already in
  `result.stats` (`status`, `blockedPercentage`, `domainsBlocked`, `uniqueDomains`,
  `queriesForwarded`, `queriesCached`, `uniqueClients`, `gravityUpdated`, `topQueries`, `topBlocked`)
  keeps today's single-source semantics: they come from the primary instance's own
  `getFullStats` call, exactly as they do now. This spec does **not** fan them out, sum them, or
  merge them, and adds no fallback rule for them (when the primary is down the whole stats block
  already fails over to today's `statsError` path for those keys; per-instance visibility of that is
  carried by `instancesFailed`).
- Session state (`sessionId` / `sessionExpiry` / `authInFlight`) becomes a map keyed by instance URL
  so each host logs in independently.
- `src/tools/dns.ts` `get_dns_status` adds to `result.stats`: `instances`, `instancesTotal`,
  `instancesResponded`, `instancesFailed`. All existing `result.stats` keys keep their names.
- New test file: `src/__tests__/pihole-secondary.test.ts`.

## 4. Approach · [A]

Turn the client's single-URL session state into per-URL state, derive the instance list from
`PIHOLE_URLS` (fallback `[PIHOLE_URL]`), and add `getAllSummaries()`, which fans out over the list
with `Promise.allSettled`-style per-instance error capture and returns one `PiholeInstanceStats` per
instance. `getStatsInstances()` calls `getFullStats()` for the primary (so every existing stats key
is sourced exactly as today) plus `getAllSummaries()`, then sets `queriesToday` / `blockedToday` to
the sums across responding instances and appends the per-instance counters plus total/responded/failed.
`get_dns_status` switches its `getFullStats(5)` call to `getStatsInstances(5)` and surfaces the four
new keys; its existing `statsError` catch stays for the K8s/fatal path.

Rejected: a **new tool** (registry and read-only-scope churn); **discovering instances by pod label**
(couples the API client to pod naming, breaks outside the cluster); **`k8s/` manifest changes** (ops
sets `PIHOLE_URLS` separately); **merging or falling-back for `topQueries`/`topBlocked`/the other
non-summed fields** (the idea is "aggregate totals and/or surface per-instance health"; a source
fallback rule adds behaviour nothing asked for and nothing tests).

## 5. Scope · [S]

**In scope:** `src/clients/pihole.ts`, `src/tools/dns.ts` (the `get_dns_status` stats block only),
`src/__tests__/pihole-secondary.test.ts`.

**Out of scope:** `k8s/` manifests, `package.json`, CI, auth middleware, tool registration
(`src/tools/index.ts`), `get_pihole_whitelist` / `get_pihole_queries` / `update_pihole_gravity`
behaviour, rate-limit (`rateLimitedUntil`) semantics, other test files (they must keep passing
unchanged).

## 6. Prior facts · [S]

Match on symbol names; line numbers are the base commit `94902a6a`.

- `src/clients/pihole.ts` — `const PIHOLE_URL = process.env.PIHOLE_URL || 'http://pihole-web.pihole.svc.cluster.local';`
  read once at import. Session state is module-level: `sessionId`, `sessionExpiry`, `authInFlight`,
  plus a module-level `rateLimitedUntil`.
- `authenticate()` — session cache, rate-limit gate, then single-flight around `login()`.
- `login()` — `POST ${PIHOLE_URL}/api/auth`; 429 sets `rateLimitedUntil` and says "throttling, NOT a
  bad credential"; non-OK throws `Pi-hole auth failed: … PIHOLE_API_TOKEN must equal …`.
- `piholeFetch()` — `GET ${PIHOLE_URL}/api/${endpoint}` with the `sid` header when auth is needed.
- `convertStatsToLegacy()` maps `queries.total → dns_queries_today`, `queries.blocked → ads_blocked_today`;
  `getSummary()` fetches `stats/summary` **with** auth; `getFullStats()` runs `getSummary` +
  `getTopItems` + `getQueryTypes` into `{ summary, topQueries, topBlocked, queryTypes }`.
- `src/tools/dns.ts` — the stats block starts at the `if (includeStats && piholePods.some((p) => p.ready))`
  gate; inside it calls `getFullStats(5)` + `getMessages()` and builds `result.stats`; the
  `catch (statsError)` sets `result.statsError` and returns the pod lists. Today **any** failure in
  that block drops the whole stats section.
- `src/__tests__/pihole-auth.test.ts` is the existing client-test pattern: stub `PIHOLE_URL` /
  `PIHOLE_API_TOKEN`, stub global `fetch`, `vi.resetModules()` and re-import so module-level consts
  are re-read. Its `stats/summary` fixture is `total: 100, blocked: 10`, so a second instance must
  use visibly different numbers.
- `src/__tests__/write-tool-gates.test.ts` mocks `../clients/pihole.js` with `getFullStats`,
  `getMessages`, `updateGravity`, `getWhitelist`, `getRecentQueries` — those exports must keep their
  names so that mock keeps working.
- `CLAUDE.md` — "If a tool states a conclusion, it must be correct"; the summary-first conventions
  apply to *list* tools, and `get_dns_status` is not a list tool, so no `detail` param is added here.

## 7. Norms · [N]

- Keep `getFullStats`, `getSummary`, `getStatus`, `getMessages`, `getWhitelist`, `getRecentQueries`,
  `updateGravity` exported with their current signatures; `getFullStats` and the whitelist/query/gravity
  tools keep hitting the primary (first configured instance).
- Error text style from #44/#48 is preserved per instance: auth failures name `PIHOLE_API_TOKEN`,
  429 stays "throttling, NOT a bad credential", and every per-instance `error` string **contains**
  the instance URL (e.g. `http://pihole-secondary.test: Pi-hole auth failed: 401 …`). No test pins
  the position of the URL inside the message.
- Tests: vitest, no network — `vi.stubGlobal('fetch', …)` plus a fresh `vi.resetModules()` import per
  test (`pihole-auth.test.ts`), and handler-level tests via `tools.find(t => t.name === 'get_dns_status')`
  with `vi.mock('../clients/kubernetes.js', …)` for `listPods` (`summary.test.ts`,
  `write-tool-gates.test.ts`).
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
  instance list (split/trim/drop-empty + `[PIHOLE_URL]` fallback per §3).
- T2: Add `PiholeInstanceStats`, `PiholeInstanceCounters`, `getAllSummaries()` and
  `getStatsInstances()` to `src/clients/pihole.ts` with per-instance error capture, summed
  `dns_queries_today` / `ads_blocked_today`, and every other stats field sourced from the primary as today.
- T3: Make `get_dns_status` in `src/tools/dns.ts` call `getStatsInstances(5)` and surface
  `instances` / `instancesTotal` / `instancesResponded` / `instancesFailed`, keeping every existing
  stats key.
- T4: Add `src/__tests__/pihole-secondary.test.ts` with the **nine** tests named in §11, using the
  exact fixtures and expected values there.
- T5: Run `npm run lint && npm run typecheck && npm test && npm run build`, then
  `bash specs/pihole-secondary-stats-panels/verify.sh`, confirming `pihole-auth.test.ts` and
  `write-tool-gates.test.ts` still pass unchanged.

## 10. Acceptance criteria (EARS) · [O]

- **AC1** When `PIHOLE_URLS` lists three URLs and `getAllSummaries()` runs, the system shall issue
  `POST /api/auth` exactly once per host, on each host's own base URL (3 auth calls total), and
  return 3 entries in config order.
- **AC2** When the secondary answers, the system shall send its stats request with the `sid` returned
  by the **secondary's** auth response, and that sid shall differ from the primary's and the third's.
- **AC3** When both instances report stats, `stats.queriesToday` and `stats.blockedToday` shall be the
  sums across instances (100+40 = `140`, 10+5 = `15`), `stats.instances` shall have length 2 with
  per-instance `queriesToday` 100 and 40, `instancesResponded` 2, `instancesTotal` 2, and
  `instancesFailed` empty.
- **AC4** When one instance's `/api/auth` answers 500, the tool shall return `instancesResponded` 1,
  `instancesTotal` 2, `instancesFailed` exactly `['http://pihole-secondary.test']`, the healthy entry
  `ok: true` with `queriesToday` 100, the failed entry `ok: false` with counters `0` and a non-empty
  `error` containing that URL.
- **AC5** If an instance rejects the password (401), that instance's entry shall have `ok: false` and
  an `error` matching `/auth failed/i` that contains `PIHOLE_API_TOKEN`, while the healthy instance
  still reports `ok: true` and `queriesToday` 100.
- **AC6** If `PIHOLE_URLS` is unset, the system shall query only `PIHOLE_URL` — exactly 1 auth call,
  no request URL containing `pihole-secondary` — and report `instancesTotal` 1, `instancesResponded` 1,
  `queriesToday` equal to that instance's `queries.total` (100).
- **AC7** When `PIHOLE_URLS` lists two healthy hosts and `get_dns_status` runs once, the system shall
  make exactly 2 auth calls — one per host — never 1 (shared session) and never more than 2.
- **AC8** If **no** configured instance answers, `getStatsInstances()` shall return `queriesToday` 0,
  `blockedToday` 0, `instancesResponded` 0, `instancesTotal` 2, and `instancesFailed` listing every
  configured URL in config order.
- **AC9** If `PIHOLE_URLS` is set while `PIHOLE_URL` is also set, `PIHOLE_URLS` shall win; when its
  entries carry surrounding whitespace or are empty, the system shall trim each entry, drop the empty
  ones, and contact exactly the remaining hosts once each.

## 11. Verification

`verify.sh` runs these checks, each of which can fail:

1. **Static presence** (all absent on today's tree, so the gate fails before implementation):
   `PIHOLE_URLS`, `getAllSummaries`, `getStatsInstances` in `src/clients/pihole.ts`;
   `getStatsInstances`, `instancesResponded`, `instancesFailed`, `instancesTotal` in `src/tools/dns.ts`.
2. **Safeguard**: `src/tools/dns.ts` contains none of `sid`, `csrf`, `password` — fails if session
   material is echoed into tool output (§8).
3. **Regression**: `src/__tests__/pihole-auth.test.ts` still contains its #48 title
   `performs ONE login for a burst of concurrent requests` — fails if the refactor deletes existing
   auth tests to go green.
4. **Machine-readable vitest run**: `npx vitest run src/__tests__/pihole-secondary.test.ts --reporter=json
   --outputFile=…`, then a Node check on the JSON report asserting exactly `numPassedTests === 9`,
   0 failed, 0 skipped/pending, and that the set of passed titles equals the nine titles below. This
   cannot pass with `it.skip`, empty or removed tests, and does not depend on reporter text.
5. **Pinned assertion literals**: each is a whole-line grep (anchored, whitespace-tolerant, optional
   trailing semicolon) restricted to the **body of the named test** — from its `it('<title>'` line
   until the next `it`/`test`/`describe` — so a stray substring, a commented-out assertion, or an
   assertion living in a different test cannot satisfy it.
6. **Body-scoped fixture literals**: the fixture strings below must each appear inside the body of at
   least one of the nine named tests (same body-extraction rule as 5). A whole-file or comment-only
   occurrence cannot satisfy it.

Test file `src/__tests__/pihole-secondary.test.ts`. Fixtures — deliberately different per instance so
"summed" cannot be confused with "first one wins" or "last one wins". **Every fetch stub must resolve
`stats/summary` only when the request's `sid` header equals the sid that host's own auth response
returned, and answer a 401 otherwise** — so a client that reuses the primary's sid for the secondary
fails tests 1–7 behaviourally, not just by the pinned literals. Sids differ per host:

| | primary `http://pihole-primary.test` | secondary `http://pihole-secondary.test` | third `http://pihole-third.test` |
|---|---|---|---|
| auth sid | `sid-primary-aaa` | `sid-secondary-bbb` | `sid-third-ccc` |
| `queries.total` | `100` | `40` | `20` |
| `queries.blocked` | `10` | `5` | `2` |

| # | Exact `it()` title | Level | Asserts (fixture → expected) | Fails when |
|---|---|---|---|---|
| 1 | `polls every configured Pi-hole instance` | client | `PIHOLE_URLS` = primary + secondary + third → `summaries = await getAllSummaries()`; `expect(summaries).toHaveLength(3)`; `expect(summaries.map(s => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-secondary.test', 'http://pihole-third.test'])`; `expect(summaries.every(s => s.ok)).toBe(true)`; total auth calls `toHaveLength(3)`; per-host auth buckets `authCallsTo('<each url>')` each `toHaveLength(1)`; per-host `stats/summary` buckets `summaryCallsTo('<each url>')` each `toHaveLength(1)` | still queries one URL; a host skipped (bucket 0); primary contacted three times; `getAllSummaries` returns the wrong count or wrong order |
| 2 | `logs in to the secondary separately from the primary` | client | same 3-host config; after `getAllSummaries()`, read the recorded `stats/summary` requests and their `headers.sid` into `primarySid` / `secondarySid` / `thirdSid` → `sid-primary-aaa`, `sid-secondary-bbb`, `sid-third-ccc` (the stub 401s any request whose sid is not that host's own, so a shared session yields `ok:false` and an empty/absent sid) | one login reused across hosts; secondary fetched unauthenticated or with the primary's sid |
| 3 | `sums query totals across instances and reports per-instance health` | handler | `PIHOLE_URLS` = primary + secondary → `stats.queriesToday` `140`, `stats.blockedToday` `15`, `stats.instances` length 2, `instances[0].queriesToday` `100`, `instances[0].ok` `true`, `instances[0].error` `undefined`, `instances[1].queriesToday` `40`, `instances[1].ok` `true`, `instancesResponded` `2`, `instancesTotal` `2`, `instancesFailed` length 0 | primary-only (100/10); last-wins (40/5); aggregate-only (no per-instance counters); error set on a healthy entry |
| 4 | `reports a failed instance instead of dropping all stats` | handler | secondary `/api/auth` → 500: `instancesResponded` `1`, `instancesTotal` `2`, `instancesFailed` exactly `['http://pihole-secondary.test']`, `instances[0].ok` `true`, `instances[0].queriesToday` `100`, `instances[1].ok` `false`, `instances[1].queriesToday` `0`, `instances[1].error` contains `'http://pihole-secondary.test'`, `queriesToday` `100` | one dead instance drops the stats block (today's `statsError` path); failure swallowed (`instancesFailed` empty, totals 140); dead host reported healthy |
| 5 | `fails loudly for the instance whose credential is rejected, not silently` | handler | secondary `/api/auth` → 401: `instances[0].ok` `true`, `instances[1].ok` `false`, `instances[1].error` matches `/auth failed/i` **and** contains `PIHOLE_API_TOKEN`, `queriesToday` `100` | rejected session swallowed to null (#44); one bad host zeroing the healthy one |
| 6 | `logs in at most once per host under concurrent fan-out` | handler | `PIHOLE_URLS` = primary + secondary, both healthy, one `get_dns_status` call → total auth calls `toHaveLength(2)` (exactly one per host) | single-flight dropped → >2 auth calls (re-arms FTL's limiter, #48); single-flight global → 1 auth call, i.e. one host's session reused |
| 7 | `keeps single-instance behaviour when PIHOLE_URLS is unset` | handler | only `PIHOLE_URL` = `http://pihole-primary.test` (no `PIHOLE_URLS`) → auth calls `toHaveLength(1)`, `instancesTotal` `1`, `instancesResponded` `1`, `queriesToday` `100`, and no recorded request URL contains `pihole-secondary` | `PIHOLE_URL` fallback dropped; a second host invented when none was configured; fallback reports 0 responded |
| 8 | `returns zeroed totals and every URL in instancesFailed when no instance answers` | client | `PIHOLE_URLS` = primary + secondary, **both** `/api/auth` → 500 → `multi.queriesToday` `0`, `multi.blockedToday` `0`, `multi.instancesResponded` `0`, `multi.instancesTotal` `2`, `multi.instancesFailed` exactly `['http://pihole-primary.test', 'http://pihole-secondary.test']` | zero-instance case throws or sets `statsError` (tool drops the stats block); `instancesFailed` left empty; totals non-zero |
| 9 | `prefers PIHOLE_URLS over PIHOLE_URL and ignores empty entries` | client | `PIHOLE_URL` = `http://pihole-secondary.test` **and** `PIHOLE_URLS` = `' http://pihole-primary.test , , http://pihole-third.test , '` → `expect(summaries.map(s => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-third.test'])`; total auth calls `toHaveLength(2)`; `authCallsTo('http://pihole-secondary.test')` `toHaveLength(0)` | `PIHOLE_URL` still wins; whitespace kept (host never answers → `ok:false`); empty entry fetched as a host |

Handler-level tests stub `../clients/kubernetes.js` (`vi.mock`) so `listPods` resolves a Ready pod
named `pihole-pod-a` plus `unbound-pod-a` (opening the `includeStats` gate), stub global `fetch`, and
reach the handler via `tools.find(t => t.name === 'get_dns_status')`. Client-level tests (1, 2, 8, 9)
call the exported client functions directly after `vi.resetModules()`. `authCallsTo(url)` and
`summaryCallsTo(url)` are local helpers in the test file counting recorded `POST <url>/api/auth` and
`GET <url>/api/stats/summary` calls; the pinned literals name them with the concrete fixture URL, so
each per-host bucket is gated.

The literals verify.sh pins, each as a whole line that must appear inside the body of the named test:

- test 1: `expect(summaries).toHaveLength(3)` ·
  `expect(summaries.map((s) => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-secondary.test', 'http://pihole-third.test'])` ·
  `expect(authCalls).toHaveLength(3)` ·
  `expect(authCallsTo('http://pihole-primary.test')).toHaveLength(1)` ·
  `expect(authCallsTo('http://pihole-secondary.test')).toHaveLength(1)` ·
  `expect(authCallsTo('http://pihole-third.test')).toHaveLength(1)` ·
  `expect(summaryCallsTo('http://pihole-primary.test')).toHaveLength(1)` ·
  `expect(summaryCallsTo('http://pihole-secondary.test')).toHaveLength(1)` ·
  `expect(summaryCallsTo('http://pihole-third.test')).toHaveLength(1)`
- test 2: `expect(secondarySid).toBe('sid-secondary-bbb')` · `expect(primarySid).toBe('sid-primary-aaa')` ·
  `expect(thirdSid).toBe('sid-third-ccc')`
- test 3: `expect(stats.queriesToday).toBe(140)` · `expect(stats.blockedToday).toBe(15)` ·
  `expect(stats.instances).toHaveLength(2)` · `expect(stats.instances[0].queriesToday).toBe(100)` ·
  `expect(stats.instances[0].ok).toBe(true)` · `expect(stats.instances[0].error).toBeUndefined()` ·
  `expect(stats.instances[1].queriesToday).toBe(40)` · `expect(stats.instances[1].ok).toBe(true)` ·
  `expect(stats.instancesResponded).toBe(2)` · `expect(stats.instancesTotal).toBe(2)` ·
  `expect(stats.instancesFailed).toHaveLength(0)`
- test 4: `expect(stats.instancesFailed).toEqual(['http://pihole-secondary.test'])` ·
  `expect(stats.instancesResponded).toBe(1)` · `expect(stats.instancesTotal).toBe(2)` ·
  `expect(stats.instances[0].ok).toBe(true)` · `expect(stats.instances[0].queriesToday).toBe(100)` ·
  `expect(stats.instances[1].ok).toBe(false)` · `expect(stats.instances[1].queriesToday).toBe(0)` ·
  `expect(stats.instances[1].error).toContain('http://pihole-secondary.test')` ·
  `expect(stats.queriesToday).toBe(100)`
- test 5: `expect(stats.instances[0].ok).toBe(true)` · `expect(stats.instances[1].ok).toBe(false)` ·
  `expect(stats.instances[1].error).toMatch(/auth failed/i)` ·
  `expect(stats.instances[1].error).toContain('PIHOLE_API_TOKEN')` · `expect(stats.queriesToday).toBe(100)`
- test 6: `expect(authCalls).toHaveLength(2)`
- test 7: `expect(authCalls).toHaveLength(1)` · `expect(stats.instancesTotal).toBe(1)` ·
  `expect(stats.instancesResponded).toBe(1)` · `expect(stats.queriesToday).toBe(100)` ·
  `expect(requestedUrls.some((u) => u.includes('pihole-secondary'))).toBe(false)`
- test 8: `expect(multi.queriesToday).toBe(0)` · `expect(multi.blockedToday).toBe(0)` ·
  `expect(multi.instancesResponded).toBe(0)` · `expect(multi.instancesTotal).toBe(2)` ·
  `expect(multi.instancesFailed).toEqual(['http://pihole-primary.test', 'http://pihole-secondary.test'])`
- test 9: `expect(summaries.map((s) => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-third.test'])` ·
  `expect(authCalls).toHaveLength(2)` ·
  `expect(authCallsTo('http://pihole-secondary.test')).toHaveLength(0)`
- fixture strings (each must appear inside at least one test body): `sid-primary-aaa`,
  `sid-secondary-bbb`, `sid-third-ccc`, `http://pihole-primary.test`, `http://pihole-secondary.test`,
  `http://pihole-third.test`

`verify.sh` does **not** grep `k8s/` — manifests are out of scope (§4).

## 12. Open questions

- Should `PIHOLE_URLS` also drive `update_pihole_gravity`, `get_pihole_whitelist` and
  `get_pihole_queries`? This spec leaves them on the primary; a follow-up could fan them out.
- Real deployment values for `PIHOLE_URLS` (in-cluster Service DNS vs. `192.168.1.55` / `.56`) are an
  ops decision outside this change.
