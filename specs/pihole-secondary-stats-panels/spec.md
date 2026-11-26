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
5. When **no** instance answers, `getStatsInstances()` **throws** the primary's error, so
   `get_dns_status` takes today's `statsError` path — no `stats` block, and `result.statsError`
   naming the primary's failure. `getStatsInstances()` never returns a zero-answer `PiholeMultiStats`.
   (There is no such thing as "a stats block with no data behind it": if nothing answered, the tool
   reports the error exactly as it does today. Pinned by client-level test 8 (§11), which asserts the
   rejection.)
6. With `PIHOLE_URLS` unset the system queries only `PIHOLE_URL`: exactly 1 auth call,
   `instancesTotal` 1, `instancesResponded` 1, `queriesToday` equal to that instance's
   `queries.total`, and no request URL containing `pihole-secondary` (test 7).
7. With `PIHOLE_URLS` set it wins over `PIHOLE_URL`, and the list is built by trimming each entry
   and dropping empty ones (`" url-a , , url-b , "` → 2 hosts, 2 auth calls, 2 entries — test 9).

## 3. Entities · [E]

- Env var **`PIHOLE_URLS`** — comma-separated list of instance base URLs, in order; **first entry is
  the primary**. `PIHOLE_URLS` is split on commas, each entry trimmed, empty entries dropped. If the
  resulting list is non-empty it is the whole list and `PIHOLE_URL` is ignored; if it is empty
  (unset, empty string, or only commas/whitespace — i.e. no usable entry) the list is `[PIHOLE_URL]`,
  keeping today's default. Both branches are pinned by test 9 (§11).
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
  `get_dns_status` calls instead of `getFullStats`. **The primary is the single source for every
  per-instance number and for `instancesFailed`:** `getStatsInstances()` calls `getFullStats()`
  against the primary only (so every existing stats key is sourced exactly as today), and
  `getAllSummaries()` for the other instances, **skipping the primary's own `stats/summary` request**
  so the primary is fetched once per run, not twice. `instances[0]` is the primary — its
  `queriesToday` / `blockedToday` come from the `getFullStats` summary — and `instances[i]` for
  `i > 0` comes from that instance's `getAllSummaries()` entry. `instancesFailed` lists exactly the
  URLs whose own fetch failed (the primary's failure throws, see below), so there is no case where
  `getFullStats` succeeds while the primary is listed as failed, or the reverse. If the primary
  throws, `getStatsInstances()` rejects with that error (outcome 5) and never returns a value.
  `PiholeMultiStats` extends `PiholeFullStats` and adds `instances: PiholeInstanceCounters[]`,
  `instancesTotal: number`, `instancesResponded: number`, `instancesFailed: string[]` (URLs of failed
  instances, config order). Every `PiholeFullStats` key is always present, because a value only exists
  when the primary answered.
- **Only `queriesToday` and `blockedToday` are aggregated.** Every other key already in `result.stats`
  (`status`, `blockedPercentage`, `domainsBlocked`, `uniqueDomains`, `queriesForwarded`,
  `queriesCached`, `uniqueClients`, `gravityUpdated`, `topQueries`, `topBlocked`) comes from the
  **primary's** `getFullStats` call, exactly as it does now — pinned in test 4 by the distinct fixture
  value `gravity_last_updated.relative.days` = `7`, which appears on the primary and nowhere else,
  asserting `stats.gravityUpdated` is `'7d 0h ago'` (test 3 asserts it is **not** `'3d 0h ago'`, the
  secondary's value). This spec does **not** fan those keys out, sum them, or merge them, and adds no
  fallback rule: when the primary is down there is no stats block at all (outcome 5).
- Session state (`sessionId` / `sessionExpiry` / `authInFlight`) becomes a map keyed by instance URL
  so each host logs in independently.
- `src/tools/dns.ts` `get_dns_status` adds to `result.stats`: `instances`, `instancesTotal`,
  `instancesResponded`, `instancesFailed`. All existing `result.stats` keys keep their names.
- New test file: `src/__tests__/pihole-secondary.test.ts`.

## 4. Approach · [A]

Turn the client's single-URL session state into per-URL state, derive the instance list from
`PIHOLE_URLS` (fallback `[PIHOLE_URL]`), and add `getAllSummaries()`, which fans out over the list
with `Promise.allSettled`-style per-instance error capture and returns one `PiholeInstanceStats` per
instance. `getStatsInstances()` calls `getFullStats()` for the primary (so every existing stats key is
sourced exactly as today) plus `getAllSummaries()` for the remaining instances, then sets
`queriesToday` / `blockedToday` to the sums across responding instances and appends the per-instance
counters plus total/responded/failed. If the primary's `getFullStats()` throws, `getStatsInstances()`
rejects — the same thing `getFullStats()` does today, so a primary outage keeps today's behaviour and
`get_dns_status` keeps its existing `statsError` catch for it (outcome 5); a *non-primary* instance
failing never throws (outcome 4). `get_dns_status` switches its `getFullStats(5)` call to
`getStatsInstances(5)` and surfaces the four new keys.

Rejected: a **new tool** (registry and read-only-scope churn); **discovering instances by pod label**
(couples the API client to pod naming, breaks outside the cluster); **`k8s/` manifest changes** (ops
sets `PIHOLE_URLS` separately); **merging or falling-back for `topQueries`/`topBlocked`/the other
non-summed fields** (the idea is "aggregate totals and/or surface per-instance health"; a source
fallback rule adds behaviour nothing asked for and nothing tests); **failing over to a non-primary
source when the primary is down** (the primary's own outage is today's `statsError` behaviour and
keeping it avoids two competing error paths).

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
  gate; inside it calls `getFullStats(5)` + `getMessages()` and builds `result.stats`
  (`queriesToday: stats.summary.dns_queries_today`, `blockedToday: …ads_blocked_today`,
  `gravityUpdated: '<n>d <m>h ago'` built from `stats.summary.gravity_last_updated.relative`); the
  `catch (statsError)` sets `result.statsError` and returns the pod lists. Today **any** failure in
  that block drops the whole stats section, and a primary outage takes that path.
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
- No per-instance login storms or duplicate fetches: single-flight is keyed per instance URL, so one
  `get_dns_status` run performs **exactly one** `POST /api/auth` and **exactly one**
  `stats/summary` request per configured host (§11 test 6).
- A primary outage must not be disguised: `getStatsInstances()` throws rather than returning zeroed
  totals, so `get_dns_status` reports `statsError` (outcome 5, test 8). "0 queries today" must never
  be reported when nothing actually answered.

## 9. Tasks · [O]

- T1: Refactor `src/clients/pihole.ts` to per-instance session state and a `PIHOLE_URLS`-derived
  instance list (split/trim/drop-empty + `[PIHOLE_URL]` fallback per §3).
- T2: Add `PiholeInstanceStats`, `PiholeInstanceCounters`, `getAllSummaries()` and
  `getStatsInstances()` to `src/clients/pihole.ts` with per-instance error capture, summed
  `dns_queries_today` / `ads_blocked_today`, every other stats field sourced from the primary exactly
  as today, the primary fetched once per run (no duplicate `stats/summary` for it), and a rejection
  when the primary's `getFullStats()` fails.
- T3: Make `get_dns_status` in `src/tools/dns.ts` call `getStatsInstances(5)` and surface
  `instances` / `instancesTotal` / `instancesResponded` / `instancesFailed`, keeping every existing
  stats key and the existing `statsError` catch for a primary failure.
- T4: Add `src/__tests__/pihole-secondary.test.ts` with the **nine** tests named in §11, using the
  exact fixtures (per-host sids, per-host query numbers, per-host `gravity_last_updated` days) and the
  pinned expected literals there, with fetch stubs that only answer `stats/summary` for a host's own
  sid and reject a request that is not a configured host's `/api/auth` or `/api/stats/summary`.
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
  per-instance `queriesToday` 100 and 40, `instancesResponded` 2, `instancesTotal` 2,
  `instancesFailed` empty, and `stats.gravityUpdated` **not** the secondary's `'3d 0h ago'`.
- **AC4** When one non-primary instance's `/api/auth` answers 500, the tool shall return
  `instancesResponded` 1, `instancesTotal` 2, `instancesFailed` exactly
  `['http://pihole-secondary.test']`, the healthy entry `ok: true` with `queriesToday` 100, the failed
  entry `ok: false` with counters `0` and a non-empty `error` containing that URL, and
  `stats.gravityUpdated` `'7d 0h ago'` — the primary's own value, proving the non-summed keys are
  primary-sourced.
- **AC5** If an instance rejects the password (401), that instance's entry shall have `ok: false` and
  an `error` matching `/auth failed/i` that contains `PIHOLE_API_TOKEN`, while the healthy instance
  still reports `ok: true` and `queriesToday` 100.
- **AC6** If `PIHOLE_URLS` is unset, the system shall query only `PIHOLE_URL` — exactly 1 auth call,
  no request URL containing `pihole-secondary` — and report `instancesTotal` 1, `instancesResponded` 1,
  `queriesToday` equal to that instance's `queries.total` (100).
- **AC7** When `PIHOLE_URLS` lists two healthy hosts and `get_dns_status` runs once, the system shall
  make exactly 2 auth calls — one per host — never 1 (shared session) and never more than 2, and
  exactly 2 `stats/summary` requests in total (the primary is not fetched twice).
- **AC8** If the **primary** instance's `/api/auth` answers 500, `getStatsInstances()` shall reject
  with the primary's error (message containing `http://pihole-primary.test`) rather than return a
  zero-answer value.
- **AC9** If `PIHOLE_URLS` is set while `PIHOLE_URL` is also set, `PIHOLE_URLS` shall win; when its
  entries carry surrounding whitespace or are empty, the system shall trim each entry, drop the empty
  ones, and contact exactly the remaining hosts once each. If `PIHOLE_URLS` is set but yields no
  usable entry (`' , '`), the system shall fall back to `PIHOLE_URL` — exactly 1 auth call and 1
  entry, to that host.

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
   --outputFile=…`, then a Node check on the JSON report asserting exactly the passed/failed/skipped counts being exactly 9/0/0,
   0 failed, 0 skipped/pending, and that the set of passed titles equals the nine titles below. This
   cannot pass with `it.skip`, empty or removed tests, and does not depend on reporter text.
5. **Pinned assertion literals**: each is a whole-line grep (anchored, whitespace-tolerant, optional
   trailing semicolon) restricted to the **body of the named test**. The body-extraction awk anchors
   the capture window to the test *call* — a line matching
   `^[[:space:]]*(it|test)[[:space:]]*[.(][[:space:]]*['"]<title>['"]` — and ends it at the next
   `it`/`test`/`describe` call line, so a commented-out title, a `describe` name or a title mentioned
   in prose cannot open the window; a stray substring, a commented-out assertion, or an assertion
   living in a different test cannot satisfy it either.
6. **Body-scoped fixture literals**: the fixture strings below must each appear inside the body of at
   least one of the nine named tests (same body-extraction rule as 5). A whole-file or comment-only
   occurrence cannot satisfy it.

Test file `src/__tests__/pihole-secondary.test.ts`. Fixtures — deliberately different per instance so
"summed" cannot be confused with "first one wins" or "last one wins", and so the primary-sourced keys
cannot be confused with any other instance's:

| | primary `http://pihole-primary.test` | secondary `http://pihole-secondary.test` | third `http://pihole-third.test` |
|---|---|---|---|
| auth sid | `sid-primary-aaa` | `sid-secondary-bbb` | `sid-third-ccc` |
| `queries.total` | `100` | `40` | `20` |
| `queries.blocked` | `10` | `5` | `2` |
| `gravity_last_updated.relative.days` | `7` | `3` | `1` |

**Stub rules the test file must follow** (they make the sid and sourcing rules behavioural, not just
literal, so verify.sh does not have to inspect stub code):

- `POST <url>/api/auth` answers with that URL's own sid, or the status the test asked for (500/401).
- `GET <url>/api/stats/summary` (and `/api/stats/top-items`, `/api/stats/query-types`) resolve **only
  when the request's `sid` header equals the sid that host's own auth response returned**, and answer
  **401** otherwise — so a client that reuses the primary's sid for the secondary fails tests 1–7
  behaviourally, and `summaries.every((s) => s.ok)` (pinned in test 1) is a real check.
- A request whose URL is not one of `<configured url>/api/…` makes the stub **throw**
  `new Error('unexpected request: ' + url)`. That is what makes the `requestedUrls` helper in test 7
  exhaustive: an implementation that contacted a second, unconfigured host would fail the test rather
  than silently record a URL nobody asserted on.

| # | Exact `it()` title | Level | Asserts (fixture → expected) | Fails when |
|---|---|---|---|---|
| 1 | `polls every configured Pi-hole instance` | client | `PIHOLE_URLS` = primary + secondary + third → `summaries = await getAllSummaries()`; `expect(summaries).toHaveLength(3)`; url list equals the three URLs in config order; `expect(summaries.every((s) => s.ok)).toBe(true)`; total auth calls `toHaveLength(3)`; per-host auth buckets `authCallsTo('<each url>')` each `toHaveLength(1)`; per-host `stats/summary` buckets `summaryCallsTo('<each url>')` each `toHaveLength(1)` | still queries one URL; a host skipped (bucket 0); primary contacted three times; wrong count or order; any host not `ok` (e.g. a reused sid → 401) |
| 2 | `logs in to the secondary separately from the primary` | client | same 3-host config; after `getAllSummaries()`, read the recorded `stats/summary` requests and their `headers.sid` into `primarySid` / `secondarySid` / `thirdSid` → `sid-primary-aaa`, `sid-secondary-bbb`, `sid-third-ccc` | one login reused across hosts; secondary fetched unauthenticated or with the primary's sid |
| 3 | `sums query totals across instances and reports per-instance health` | handler | `PIHOLE_URLS` = primary + secondary → `stats.queriesToday` `140`, `stats.blockedToday` `15`, `stats.instances` length 2, `instances[0].queriesToday` `100` / `ok: true` / `error` undefined, `instances[1].queriesToday` `40` / `ok: true`, `instancesResponded` `2`, `instancesTotal` `2`, `instancesFailed` length 0, and `stats.gravityUpdated` **not** `'3d 0h ago'` (the secondary's value) | primary-only (100/10); last-wins (40/5); aggregate-only (no per-instance counters); error set on a healthy entry; non-summed keys sourced from a non-primary instance |
| 4 | `reports a failed instance instead of dropping all stats` | handler | secondary `/api/auth` → 500 (primary healthy): `instancesResponded` `1`, `instancesTotal` `2`, `instancesFailed` exactly `['http://pihole-secondary.test']`, `instances[0].ok` `true` / `queriesToday` `100`, `instances[1].ok` `false` / `queriesToday` `0` / `error` contains `'http://pihole-secondary.test'`, `queriesToday` `100`, and `stats.gravityUpdated` `'7d 0h ago'` (the **primary's** value) | one dead instance drops the stats block (today's `statsError` path); failure swallowed (`instancesFailed` empty, totals 140); dead host reported healthy; non-summed keys sourced from the wrong instance |
| 5 | `fails loudly for the instance whose credential is rejected, not silently` | handler | secondary `/api/auth` → 401: `instances[0].ok` `true`, `instances[1].ok` `false`, `instances[1].error` matches `/auth failed/i` **and** contains `PIHOLE_API_TOKEN`, `queriesToday` `100` | rejected session swallowed to null (#44); one bad host zeroing the healthy one |
| 6 | `logs in at most once per host under concurrent fan-out` | handler | `PIHOLE_URLS` = primary + secondary, both healthy, one `get_dns_status` call → total auth calls `toHaveLength(2)` and total `stats/summary` requests `toHaveLength(2)` (the primary is fetched once, not twice) | single-flight dropped → >2 auth calls (re-arms FTL's limiter, #48); single-flight global → 1 auth call, i.e. one host's session reused; primary double-fetched → 3 summary requests |
| 7 | `keeps single-instance behaviour when PIHOLE_URLS is unset` | handler | only `PIHOLE_URL` = `http://pihole-primary.test` (no `PIHOLE_URLS`) → auth calls `toHaveLength(1)`, `instancesTotal` `1`, `instancesResponded` `1`, `queriesToday` `100`, and no recorded request URL contains `pihole-secondary` | `PIHOLE_URL` fallback dropped; a second host invented when none was configured (the stub throws on any URL outside the configured host, and `requestedUrls` sees every surviving request); fallback reports 0 responded |
| 8 | `fails over to statsError when the primary Pi-hole is unreachable` | client | `PIHOLE_URLS` = primary + secondary, **primary** `/api/auth` → 500 (secondary healthy) → `await expect(getStatsInstances()).rejects.toThrow(/http:\/\/pihole-primary\.test/)` | primary outage returns a fabricated zero-answer stats block (no `statsError`, so the tool would report "0 queries today" instead of the failure) or silently reports only the secondary |
| 9 | `prefers PIHOLE_URLS over PIHOLE_URL and ignores empty entries` | client | two parts in one test body. (a) `PIHOLE_URL` = `http://pihole-secondary.test` **and** `PIHOLE_URLS` = `' http://pihole-primary.test , , http://pihole-third.test , '` → url list equals `['http://pihole-primary.test', 'http://pihole-third.test']`, auth calls `toHaveLength(2)`, `authCallsTo('http://pihole-secondary.test')` `toHaveLength(0)`. (b) `PIHOLE_URLS` = `' , '` with `PIHOLE_URL` = `http://pihole-primary.test` → url list equals `['http://pihole-primary.test']` and auth calls `toHaveLength(1)` | `PIHOLE_URL` still wins; whitespace kept (host never answers → `ok:false`); empty entry contacted as a host (`['', '…']` → 2 auth calls / wrong url list); a whitespace-only `PIHOLE_URLS` yielding `['']` instead of falling back |

Handler-level tests stub `../clients/kubernetes.js` (`vi.mock`) so `listPods` resolves a Ready pod
named `pihole-pod-a` plus `unbound-pod-a` (opening the `includeStats` gate), stub global `fetch`, and
reach the handler via `tools.find(t => t.name === 'get_dns_status')`. Client-level tests (1, 2, 8, 9)
call the exported client functions directly after `vi.resetModules()`. The test file defines these
local helpers, and the pinned literals name them with concrete fixture values:

- `authCalls` / `summaryCalls` — arrays of every recorded `POST …/api/auth` / `GET …/api/stats/summary`
  request URL made during the test.
- `authCallsTo(url)` / `summaryCallsTo(url)` — `authCalls` / `summaryCalls` filtered to requests whose
  URL starts with that base URL.
- `requestedUrls` — every recorded request URL (any method, any path) that the stub accepted, i.e. the
  stub's record of everything the client touched.

The literals verify.sh pins, each as a whole line that must appear inside the body of the named test:

- test 1: `expect(summaries).toHaveLength(3)` ·
  `expect(summaries.map((s) => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-secondary.test', 'http://pihole-third.test'])` ·
  `expect(summaries.every((s) => s.ok)).toBe(true)` ·
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
  `expect(stats.instancesFailed).toHaveLength(0)` ·
  `expect(stats.gravityUpdated).not.toBe('3d 0h ago')`
- test 4: `expect(stats.instancesFailed).toEqual(['http://pihole-secondary.test'])` ·
  `expect(stats.instancesResponded).toBe(1)` · `expect(stats.instancesTotal).toBe(2)` ·
  `expect(stats.instances[0].ok).toBe(true)` · `expect(stats.instances[0].queriesToday).toBe(100)` ·
  `expect(stats.instances[1].ok).toBe(false)` · `expect(stats.instances[1].queriesToday).toBe(0)` ·
  `expect(stats.instances[1].error).toContain('http://pihole-secondary.test')` ·
  `expect(stats.queriesToday).toBe(100)` ·
  `expect(stats.gravityUpdated).toBe('7d 0h ago')`
- test 5: `expect(stats.instances[0].ok).toBe(true)` · `expect(stats.instances[1].ok).toBe(false)` ·
  `expect(stats.instances[1].error).toMatch(/auth failed/i)` ·
  `expect(stats.instances[1].error).toContain('PIHOLE_API_TOKEN')` · `expect(stats.queriesToday).toBe(100)`
- test 6: `expect(authCalls).toHaveLength(2)` · `expect(summaryCalls).toHaveLength(2)`
- test 7: `expect(authCalls).toHaveLength(1)` · `expect(stats.instancesTotal).toBe(1)` ·
  `expect(stats.instancesResponded).toBe(1)` · `expect(stats.queriesToday).toBe(100)` ·
  `expect(requestedUrls.some((u) => u.includes('pihole-secondary'))).toBe(false)`
- test 8: `await expect(getStatsInstances()).rejects.toThrow(/http:\/\/pihole-primary\.test/)`
- test 9: `expect(summaries.map((s) => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-third.test'])` ·
  `expect(authCalls).toHaveLength(2)` ·
  `expect(authCallsTo('http://pihole-secondary.test')).toHaveLength(0)` ·
  `expect(fallbackSummaries.map((s) => s.url)).toEqual(['http://pihole-primary.test'])` ·
  `expect(authCallsTo('http://pihole-primary.test')).toHaveLength(1)`
- fixture strings (each must appear inside at least one test body): `sid-primary-aaa`,
  `sid-secondary-bbb`, `sid-third-ccc`, `http://pihole-primary.test`, `http://pihole-secondary.test`,
  `http://pihole-third.test`

`verify.sh` does **not** grep `k8s/` — manifests are out of scope (§4).

## 12. Open questions

- Should `PIHOLE_URLS` also drive `update_pihole_gravity`, `get_pihole_whitelist` and
  `get_pihole_queries`? This spec leaves them on the primary; a follow-up could fan them out.
- Real deployment values for `PIHOLE_URLS` (in-cluster Service DNS vs. `192.168.1.55` / `.56`) are an
  ops decision outside this change.
