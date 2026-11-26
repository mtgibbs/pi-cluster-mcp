# Spec: Poll every Pi-hole instance in `get_dns_status` (primary + secondary)

## 1. Why · [R]

`src/clients/pihole.ts` reads a single `PIHOLE_URL` (default `http://pihole-web.pihole.svc.cluster.local`),
whose Service selects `app: pihole`. The secondary resolver runs as `app: pihole-secondary` and has
no URL at all, so the client never talks to it. On our HA DNS the numbers `get_dns_status` reports
are those of one of two resolvers, and a secondary-only auth or health problem is invisible.

## 2. Outcomes · [R]

1. `get_dns_status` queries **every** configured Pi-hole instance, not just the primary, and reports
   per-instance query counts in `result.stats.instances` — so a secondary-only failure shows up.
2. `result.stats.queriesToday` / `blockedToday` are the **sum** across the instances that answered,
   with `stats.instancesResponded` / `stats.instancesTotal` alongside so the reader knows how many
   instances the totals cover.
3. Each instance is **authenticated with its own session**: the secondary's API calls carry the sid
   returned by the secondary's own `POST <secondary>/api/auth`, never the primary's.
4. A single unreachable instance does not fail the tool: the healthy ones still return stats and the
   failed one is listed in `result.stats.instancesFailed`.
5. With no `PIHOLE_URLS` configured the behaviour is exactly what it is today — one instance from
   `PIHOLE_URL`, same `result.stats` numbers — so existing deployments are unaffected.

## 3. Entities · [E]

- Env var **`PIHOLE_URLS`** — comma-separated list of instance base URLs, in order; first entry is
  the primary. Unset/empty → the client falls back to `[PIHOLE_URL]`, preserving today's behaviour.
- Client type **`PiholeInstanceStats`** (exported from `src/clients/pihole.ts`):
  `{ url: string; ok: boolean; error?: string; summary?: PiholeStats }`
- Exported function **`getAllSummaries(): Promise<PiholeInstanceStats[]>`** in `src/clients/pihole.ts`
  — one entry per configured instance, in config order.
- Exported function **`getStatsInstances(topCount?: number): Promise<PiholeFullStats>`** in
  `src/clients/pihole.ts` — what `get_dns_status` calls instead of `getFullStats`. Its
  `PiholeFullStats` gains: `instances: PiholeInstanceStats[]`, `instancesTotal: number`,
  `instancesResponded: number`, `instancesFailed: string[]` (the `url`s of the failed ones).
- Per-instance session state replaces the module-level `sessionId` / `sessionExpiry` /
  `authInFlight` globals: a `Map<url, …>` keyed by instance URL. `rateLimitedUntil` stays global
  (Pi-hole FTL throttles by client IP, so one instance's 429 means the others will 429 too).
- `src/tools/dns.ts` `get_dns_status` adds to `result.stats`: `instances` — array of
  `{ url, ok, queriesToday, blockedToday }` (a failed instance has `ok: false` and no counters) —
  plus `instancesTotal`, `instancesResponded`, `instancesFailed`. All existing `result.stats` keys
  keep their names.
- New test file: `src/__tests__/pihole-secondary.test.ts`.

## 4. Approach · [A]

Turn the client's single-URL module state into a per-URL session map, derive the instance list from
`PIHOLE_URLS` (falling back to `[PIHOLE_URL]`), and add `getAllSummaries()` which fans out with
`Promise.allSettled` and returns one `PiholeInstanceStats` per instance. `getStatsInstances()` keeps
the primary's `topQueries` / `topBlocked` / `queryTypes` (merging top-domain maps across instances
would produce counts no single Pi-hole agrees with) and sums only the `summary` counters.
`get_dns_status` switches its `getFullStats(5)` call to `getStatsInstances(5)` and surfaces the
per-instance list. Single-flight login stays per instance so a burst still performs at most one
login per host.

Rejected: a **new tool** (`get_dns_status` is where operators already look, and a new tool means
tool-registry + read-only-scope changes); **listing pods by label and deriving URLs** (couples the
API client to pod naming and breaks outside the cluster); **`k8s/` manifest changes** (out of scope
per the "prefer `src/clients/`" guidance — ops sets `PIHOLE_URLS` in the deployment env separately);
**merging top domains across instances** (fabricated numbers); **changing `get_pihole_whitelist` /
`get_pihole_queries` / `update_pihole_gravity`** to fan out (the idea is about stats observability;
gravity triggers are per-instance writes and belong to a different change).

## 5. Scope · [S]

**In scope:** `src/clients/pihole.ts`, `src/tools/dns.ts` (the `get_dns_status` stats block only),
`src/__tests__/pihole-secondary.test.ts`.

**Out of scope:** `k8s/` manifests, `package.json`, CI, auth middleware, tool registration
(`src/tools/index.ts`), `src/utils/whitelist.ts`, `get_pihole_whitelist` / `get_pihole_queries` /
`update_pihole_gravity` behaviour, test fixtures in other test files.

## 6. Prior facts · [S]

- `src/clients/pihole.ts:4` — `const PIHOLE_URL = process.env.PIHOLE_URL || 'http://pihole-web.pihole.svc.cluster.local';`
  read once at import; `login()` posts to `${PIHOLE_URL}/api/auth` (l.177) and `piholeFetch()` calls
  `${PIHOLE_URL}/api/${endpoint}` (l.243). Session state is module-level: `sessionId`, `sessionExpiry`,
  `authInFlight`, `rateLimitedUntil` (l.8–13).
- `getSummary()` (l.312) fetches `stats/summary` **with** auth; `convertStatsToLegacy()` (l.285) maps
  the v6 payload onto `PiholeStats`, where `dns_queries_today = queries.total` and
  `ads_blocked_today = queries.blocked`. `getFullStats()` (l.455) runs `getSummary` + `getTopItems` +
  `getQueryTypes` and exposes `summary`/`topQueries`/`topBlocked`/`queryTypes`.
- `src/tools/dns.ts:70–101` — when `includeStats` and any Pi-hole pod is Ready, `get_dns_status`
  calls `getFullStats(5)` and `getMessages()`; on throw it sets `result.statsError` and returns the
  pod list. That `statsError` catch is the only failure path today: one bad instance currently makes
  the whole stats block fail (which is exactly how a healthy primary got hidden).
- `src/__tests__/pihole-auth.test.ts` is the existing pattern: stub `PIHOLE_URL`/`PIHOLE_API_TOKEN`,
  stub global `fetch`, `vi.resetModules()` and re-import so module-level consts are re-read. Its
  fixtures use `total: 100, blocked: 10` for `stats/summary`, so a second instance must use visibly
  different numbers.
- `src/__tests__/write-tool-gates.test.ts:39` mocks `../clients/pihole.js` with `getFullStats`,
  `getMessages`, `updateGravity`, `getWhitelist`, `getRecentQueries` — those exports must keep
  existing so that mock keeps typechecking.
- `CLAUDE.md` — "If a tool states a conclusion, it must be correct — small models repeat tool
  conclusions verbatim"; summary-first conventions apply to *list* tools, and `get_dns_status` is not
  a list tool, so no `detail` param is added here.

## 7. Norms · [N]

- Keep `getFullStats`, `getSummary`, `getStatus`, `getMessages`, `getWhitelist`,
  `getRecentQueries`, `updateGravity` exported with their current signatures — `updateGravity` and
  the whitelist/query tools must keep hitting the **primary** (first configured instance).
- Error text style from #44/#48 is preserved: auth failures name `PIHOLE_API_TOKEN`, 429 is
  described as throttling and never as a bad credential, per-instance errors carry the instance URL.
- Tests: vitest, no network — `vi.stubGlobal('fetch', …)` + fresh import per test, following
  `pihole-auth.test.ts`. Tool-level tests reach the handler via `tools.find(t => t.name === …)`,
  following `summary.test.ts`.
- No new dependencies; `npm run lint`/`typecheck`/`test`/`build` stay green.

## 8. Safeguards · [S]

- No secrets in output: `instances[].url` is a base URL only — never the sid, the password, or
  request headers. `result.stats` must not gain any `sid`/`csrf`/`password` key.
- Fail **closed** on auth: a rejected credential on any instance must surface as that instance's
  `error` (matching `/auth failed/i` / `PIHOLE_API_TOKEN`), never as a silent null session — the
  #44 lesson applies per instance.
- `readOnly` on `get_dns_status` stays `true`; the tool gains no write behaviour and no new tool is
  registered (so `src/__tests__/readonly-scope.test.ts` and the write gates are untouched).
- The existing rate-limit cooldown must not fire per instance: the global `rateLimitedUntil` stays
  global, so an unreachable instance can't cause N logins in one burst.

## 9. Tasks · [O]

- T1: Refactor `src/clients/pihole.ts` to per-URL session state and a `PIHOLE_URLS`-derived instance list (fallback `[PIHOLE_URL]`).
- T2: Add `getAllSummaries()` and `getStatsInstances()` to `src/clients/pihole.ts` with per-instance error capture and summed counters.
- T3: Make `get_dns_status` in `src/tools/dns.ts` call `getStatsInstances(5)` and surface `instances` / `instancesTotal` / `instancesResponded` / `instancesFailed`.
- T4: Add `src/__tests__/pihole-secondary.test.ts` with the four named tests and exact fixture values below.
- T5: Run `npm run lint && npm run typecheck && npm test && npm run build` and `bash specs/pihole-secondary-stats-panels/verify.sh`.

## 10. Acceptance criteria (EARS) · [O]

- **AC1** When `PIHOLE_URLS` lists two URLs and `get_dns_status` runs, the system shall issue `POST /api/auth` once **per host**, on each host's own base URL.
- **AC2** When the secondary answers, the system shall send its stats requests to the secondary with the `sid` returned by the **secondary's** auth response, and that sid shall differ from the primary's.
- **AC3** When both instances report stats, `stats.queriesToday` and `stats.blockedToday` shall be the sums across instances, and `stats.instances.length` shall equal the number of configured instances.
- **AC4** When one instance is unreachable, the tool shall still return stats from the reachable one, with `instancesResponded` 1, `instancesTotal` 2, and `instancesFailed` containing exactly the failed instance's URL.
- **AC5** If an instance rejects the password, that instance's stats shall carry an error matching `/auth failed/i`, and the tool shall not report the failure as a working instance.
- **AC6** If `PIHOLE_URLS` is unset, the system shall query only `PIHOLE_URL` and report `instancesTotal` 1 with `queriesToday` equal to that instance's `queries.total`.
- **AC7** If `get_dns_status` fans out concurrently, the system shall log in to each configured host at most once (single-flight is per instance, not shared across hosts).

## 11. Verification

`verify.sh` greps for the names this change introduces (absent today, so the gate fails on the
current tree), then runs `npx vitest run src/__tests__/pihole-secondary.test.ts`, then greps that
run's report for the seven exact `it()` titles and for the pinned expected literals, and finally
greps `src/tools/dns.ts` for `sid` / `csrf` / `password` (safeguard §8).

Test file `src/__tests__/pihole-secondary.test.ts`. Fixtures (deliberately different per instance so
"summed" cannot be confused with "first one wins"; `percent_blocked` and
`gravity.domains_being_blocked` differ too so the two hosts' payloads are distinguishable):

| | primary `http://pihole-primary.test` | secondary `http://pihole-secondary.test` | third `http://pihole-third.test` |
|---|---|---|---|
| auth sid | `sid-primary-aaa` | `sid-secondary-bbb` | `sid-third-ccc` |
| `queries.total` | `100` | `40` | `20` |
| `queries.blocked` | `10` | `5` | `2` |
| `queries.percent_blocked` | `10` | `12.5` | `10` |
| `gravity.domains_being_blocked` | `1000` | `900` | `800` |

The tool-level tests stub `listPods` so `pihole-pod-a` and `unbound-pod-a` are Ready (the gate at
`src/tools/dns.ts:69`), and reach the handler via `tools.find(t => t.name === 'get_dns_status')`.

- **`'polls every configured Pi-hole instance'`** — `PIHOLE_URLS` = primary + secondary + third.
  Asserts total `/api/auth` calls `toHaveLength(3)`, and the per-host buckets
  `toHaveLength(1)` / `toHaveLength(1)` / `toHaveLength(1)` (exact counts, never "at most N"), plus
  that stats requests were sent to all three hosts. Fails if the client still only queries one URL,
  and fails at zero calls per host.
- **`'logs in to the secondary separately from the primary'`** — asserts
  `secondaryStatsCalls[0].headers.sid === 'sid-secondary-bbb'`, `primaryStatsCalls[0].headers.sid === 'sid-primary-aaa'`,
  and that the two sids are `!==` each other. Fails on the obvious wrong implementation "log in to
  the primary once, reuse the sid for every host", and on "secondary fetched unauthenticated".
- **`'sums query totals across instances and reports per-instance health'`** — handler-level:
  `result.stats.queriesToday === 140` (`toBe(140)`) and `result.stats.blockedToday === 15`
  (`toBe(15)`); `result.stats.instances` `toHaveLength(2)`; `instances[0].queriesToday === 100` and
  `instances[1].queriesToday === 40`; `instancesResponded === 2` (`toBe(2)`), `instancesTotal === 2`,
  `instancesFailed` `toHaveLength(0)`. Fails on "primary only" (100/10), on "last one wins" (40/5),
  and on an aggregate-only implementation that omits per-instance counters.
- **`'reports a failed instance instead of dropping all stats'`** — the secondary's `/api/auth`
  answers 500: `result.stats.instancesResponded === 1` (`toBe(1)`), `instancesTotal === 2`,
  `instancesFailed` `toHaveLength(1)` and equals `['http://pihole-secondary.test']`,
  `queriesToday === 100`, `instances[1].ok === false` (`ok: false` in the fixture assertion), and the
  failed entry's `error` is non-empty. Fails if one dead instance takes the whole stats block down
  with it (today's behaviour: `statsError` set, no `stats`) and fails if the failure is swallowed
  (`instancesFailed` empty, `queriesToday` 140).
- **`'fails loudly for the instance whose credential is rejected, not silently'`** — the secondary's
  `/api/auth` answers 401: `instances[1].error` matches `/auth failed/i` and contains
  `PIHOLE_API_TOKEN` (the #44 lesson, applied per instance), `instances[1].ok === false`
  (`toBe(false)`), while `instances[0].ok === true` and `queriesToday === 100`. Fails if a rejected
  session is swallowed to null, and fails if one bad host is allowed to zero out the healthy one.
- **`'logs in at most once per host under concurrent fan-out'`** — the `#48` single-flight guard in
  the new multi-instance shape: with `PIHOLE_URLS` = primary + secondary (both healthy) and
  `get_dns_status` running, total auth calls `toHaveLength(2)` — exactly one per host. Fails if
  single-flight is dropped (each of the client's parallel sub-calls logs in again, re-arming FTL's
  limiter — the #48 failure) and fails if single-flight is kept global (1 total auth call, meaning
  one host's session was reused for the other — AC2's cross-check also catches this).
- **`'keeps single-instance behaviour when PIHOLE_URLS is unset'`** — only `PIHOLE_URL` stubbed:
  auth calls `toHaveLength(1)`, `instancesTotal === 1`, `queriesToday === 100`, and no request URL
  contains `pihole-secondary`. Fails if the `PIHOLE_URL` fallback is dropped, or if a second host is
  invented when none was configured.

Static checks: `PIHOLE_URLS`, `getAllSummaries`, `getStatsInstances` in `src/clients/pihole.ts`;
`getStatsInstances`, `instancesResponded`, `instancesFailed`, `instancesTotal` in `src/tools/dns.ts`.
Regression guard: `src/__tests__/pihole-auth.test.ts` must still contain its #44/#48 title, so the
session-state refactor cannot go green by deleting the existing auth tests.
`verify.sh` does **not** grep `k8s/`: manifests are out of scope (§4).

## 12. Open questions

- Should `PIHOLE_URLS` also drive `update_pihole_gravity`, `get_pihole_whitelist`, and
  `get_pihole_queries`? This spec leaves them on the primary; a follow-up could fan them out.
- Real deployment values for `PIHOLE_URLS` (in-cluster Service DNS vs. `192.168.1.55`/`.56`) are an
  ops decision in the pi-cluster repo, not part of this change.
