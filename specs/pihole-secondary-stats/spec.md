# Spec: Pi-hole secondary stats (HA DNS observability)

## 1. Why · [R]

`src/clients/pihole.ts` reads a single `PIHOLE_URL` (default `http://pihole-web.pihole.svc.cluster.local`),
whose Service selects `app: pihole`. The secondary Pi-hole runs as `app: pihole-secondary` and has no
Service the client knows about, so it is never authenticated against and never polled. On our HA DNS
pair, `get_dns_status` therefore reports the traffic of one of two resolvers, and a secondary-only
auth or health problem is invisible (issue #45).

## 2. Outcomes · [R]

1. With `PIHOLE_URLS` set to N comma-separated base URLs, the client fetches stats from **all N**
   instances, each with its **own** `POST /api/auth` session (no sid reuse across hosts).
2. `get_dns_status` `stats` totals are the **sum across instances** (queries, blocked, forwarded,
   cached, unique clients), `blockedPercentage` is recomputed from the summed totals, and
   `domainsBlocked` is the **max** across reachable instances (both instances share one gravity).
3. `get_dns_status` reports **per-instance health**: each entry carries `url`, `ok`, and either its
   own numbers or an `error` message. A failing secondary is visible instead of silently dropping
   its contribution.
4. Backwards compatibility: with `PIHOLE_URLS` unset, behaviour is byte-for-byte what it is today —
   one primary from `PIHOLE_URL` (or the default svc), same `stats` shape, `instances` absent.
5. Auth failures on one instance degrade that instance only: the other still contributes its stats.

## 3. Entities · [E]

- Env `PIHOLE_URLS` (new, optional): comma-separated Pi-hole base URLs, e.g.
  `http://pihole-web.pihole.svc.cluster.local,http://pihole-secondary.pihole.svc.cluster.local`.
  Empty items are dropped; if the result is empty the list falls back to `[PIHOLE_URL || 'http://pihole-web.pihole.svc.cluster.local']`.
  `PIHOLE_URL` keeps working unchanged as the single-host default.
- Env `PIHOLE_API_TOKEN` / `PIHOLE_PASSWORD` (unchanged): one password, posted separately to every
  instance's `/api/auth`.
- `src/clients/pihole.ts` new exports:
  - `interface PiholeInstanceStats { url: string; ok: boolean; summary?: PiholeStats; error?: string }`
  - `getPiholeUrls(): string[]`
  - `getFullStatsPerInstance(topCount = 5): Promise<PiholeInstanceStats[]>`
  - `aggregateStats(instances: PiholeInstanceStats[]): PiholeFullStats['summary']`
- Per-instance session state replaces the single globals (`sessionId` / `sessionExpiry` /
  `authInFlight` / `rateLimitedUntil` keyed by base URL). The #48 single-flight and rate-limit
  cooldown semantics are preserved **per instance**.
- `src/tools/dns.ts` `get_dns_status` output: `stats` (now aggregated, same field names as today)
  plus new sibling `instances: Array<{ url, ok, queriesToday?, blockedToday?, error? }>` — present
  only when more than one instance is configured.

## 4. Approach · [A]

Turn the module-level singletons in `src/clients/pihole.ts` into a `Map` keyed by base URL: one
session cache, one in-flight login, one rate-limit cooldown per host. `piholeFetch(endpoint)` fans
out over `getPiholeUrls()`; `getSummary()` keeps its current single-host semantics by returning the
summary of the **first** reachable instance (so `get_dns_status` output is unchanged for one host),
while `getFullStatsPerInstance()` returns one `PiholeInstanceStats` per URL, capturing `ok: false`
plus a message instead of throwing. `aggregateStats()` sums the `ok` instances and is used by
`get_dns_status`, which also emits `instances` whenever `getPiholeUrls().length > 1`.
Rejected: (a) a second env var `PIHOLE_SECONDARY_URL` plus duplicated client code — leaves the
N-host case unsolved and doubles the session logic; (b) scraping the secondary's IP the way the
brainrot CronJob hardcodes `192.168.1.55 192.168.1.56` — hardcodes cluster topology in code;
(c) listing Pi-hole pods via the K8s API and deriving URLs — couples stats to pod names and needs
new RBAC; (d) changing `get_dns_status` to always return a list — breaks existing consumers and the
summary-first shape readers already rely on.

## 5. Scope · [S]

In scope:
- `src/clients/pihole.ts` (per-URL auth/session, `PIHOLE_URLS`, `getPiholeUrls`,
  `getFullStatsPerInstance`, `aggregateStats`)
- `src/tools/dns.ts` (`get_dns_status` stats block: aggregate + `instances`)
- `src/__tests__/pihole-multi-instance.test.ts` (new test file)

Out of scope: `update_pihole_gravity` stays primary-only (it is a write; fanning a write out to two
instances is a separate decision), `get_pihole_whitelist` / `get_pihole_queries` /
`test_dns_query` / `diagnose_dns` unchanged, no changes to `k8s/`, `package.json`, CI, auth, or tool
registration, no new dependencies, no README env table edit (docs live in the homelab repo).

## 6. Prior facts · [S]

- `src/clients/pihole.ts:4-13` — `PIHOLE_URL`/`PIHOLE_PASSWORD` read into module consts at import
  time; single `sessionId`, `sessionExpiry`, `authInFlight`, `rateLimitedUntil`. Tests therefore
  re-import the module (`vi.resetModules()`) to pick up env (see `src/__tests__/pihole-auth.test.ts:42-46`).
- `src/clients/pihole.ts:124-229` — `authenticate()`/`login()`: single-flight login (#48), 429 →
  cooldown that must **not** re-arm the limiter, failures throw and must name `PIHOLE_API_TOKEN`,
  never silently downgrade to unauthenticated (#44).
- `src/clients/pihole.ts:315-321` — `getSummary()` calls `piholeFetch('stats/summary')` with auth
  required; `convertStatsToLegacy()` maps v6 → `PiholeStats` (`status: 'enabled'`).
- `src/tools/dns.ts:66-104` — the only consumer of `getFullStats`: builds `result.stats` field by
  field, and on throw sets `result.statsError`. `result.healthy` comes from pod conditions only.
- `src/__tests__/write-tool-gates.test.ts:38-44` — `../clients/pihole.js` is mocked with
  `updateGravity, getFullStats, getMessages, getWhitelist, getRecentQueries`; those export names
  must keep existing.
- CLAUDE.md: no `String(obj)` for errors; summary-first output — "if a tool states a conclusion, it
  must be correct", because small models relay verdicts verbatim; read-only tools stay read-only.
- CI (`.github/workflows/ci.yaml`) runs lint, typecheck, `vitest run`, build — `verify.sh` runs after.

## 7. Norms · [N]

- Keep the existing comment style: each non-obvious guard gets a short "why" comment referencing the
  issue it prevents (see #44/#48 comments).
- Error strings name the instance URL and, for auth, point at `PIHOLE_API_TOKEN` — never the
  password value.
- Tests: vitest, `vi.stubGlobal('fetch', ...)`, fresh `import()` per case, stub env before import;
  one clear assertion theme per `it(...)` with a comment naming the regression it guards.
- Aggregation helpers are pure and exported so they can be tested without a fake network.

## 8. Safeguards · [S]

- No secret may appear in any tool output or error message — `PIHOLE_PASSWORD`/`PIHOLE_API_TOKEN`
  values and session ids must never be echoed.
- `get_dns_status` stays `readOnly: true`; no new write path, no fan-out of `update_pihole_gravity`.
- No fail-open: an instance that cannot be authenticated or reached must be reported as `ok: false`
  with an `error`, never silently merged into a healthy total, and must not mark the whole tool failed.
- Rate-limit protection must not regress: at most one `/api/auth` per instance per burst, and no
  login attempts during a 429 cooldown.
- Existing single-host output (field names under `stats`) must not change; do not rename tool
  exports consumed by `src/__tests__/write-tool-gates.test.ts`.

## 9. Tasks · [O]

- T1: Add `PIHOLE_URLS` parsing, `getPiholeUrls()`, and per-URL session/login/rate-limit state in `src/clients/pihole.ts`.
- T2: Add `getFullStatsPerInstance()` and `aggregateStats()` (plus `PiholeInstanceStats`) in `src/clients/pihole.ts`.
- T3: Make `get_dns_status` in `src/tools/dns.ts` publish aggregated `stats` plus per-instance `instances` when more than one host is configured.
- T4: Add `src/__tests__/pihole-multi-instance.test.ts` with the six named cases in §11.

## 10. Acceptance criteria (EARS) · [O]

- **AC1** When `PIHOLE_URLS` is set to two URLs and `getFullStatsPerInstance(1)` is called, the system shall issue one `POST /api/auth` per URL (exactly 2) and one `stats/summary` GET per URL (exactly 2).
- **AC2** If two hosts return different sids, the system shall send each host's own sid in that host's `stats/summary` request (`host-a-sid` on host-a, `host-b-sid` on host-b).
- **AC3** When two hosts return totals 1000/400 and blocked 100/40, the system shall report `queriesToday: 1400`, `blockedToday: 140`, `blockedPercentage: 10`, `uniqueClients: 5`, `domainsBlocked: 1500`, `status: 'enabled'` in that order-independent mapping (never `20` from averaging, never `1000` from first-wins).
- **AC4** If the second host's `/api/auth` answers 401, the system shall mark only that instance `ok: false` with an error naming `PIHOLE_API_TOKEN`, while the first instance stays `ok: true` with `queriesToday: 1000`.
- **AC5** When `getPiholeUrls()` is called with `PIHOLE_URLS` unset, the system shall return `['http://pihole-web.pihole.svc.cluster.local']` (and with `PIHOLE_URL=http://primary.test` plus `PIHOLE_URLS='http://primary.test, ,http://secondary.test/'` it shall return exactly those two URLs, trailing slash stripped).
- **AC6** When `get_dns_status` runs with two configured hosts, the system shall return `stats.queriesToday: 1400` and an `instances` array of length 2 with `ok: true` on both.
- **AC7** When `get_dns_status` runs with `PIHOLE_URLS` unset, the system shall return `stats.queriesToday: 1000` and `instances` undefined.

## 11. Verification

New test file `src/__tests__/pihole-multi-instance.test.ts`, exact `it(...)` titles and fixtures
(implementer must use these literals):

- Fixture A — host-a `http://host-a.test`, host-b `http://host-b.test`. Per-host `/api/auth` returns sid `host-a-sid` / `host-b-sid`. Per-host
  `stats/summary` returns: host-a `queries.total 1000, blocked 100, percent_blocked 10,
  unique_domains 50, forwarded 800, cached 200`, `clients {active: 3, total: 9}`,
  `gravity.domains_being_blocked 1500`; host-b `total 400, blocked 40, percent_blocked 10,
  unique_domains 50, forwarded 300, cached 100`, `clients {active: 2, total: 9}`,
  `gravity.domains_being_blocked 1200`. Deliberately different numbers so "summed" cannot be
  confused with "first one wins" or "averaged".

| # | `it(...)` title | Asserts |
|---|---|---|
| 1 | `fetches every configured Pi-hole instance with its own login` | 2 auth POSTs, 2 `stats/summary` GETs (`toHaveLength(2)` each), `getPiholeUrls()` returns 2 entries |
| 2 | `never reuses a session id across instances` | host-a summary GET has header `sid` = `host-a-sid`; host-b has `host-b-sid` |
| 3 | `aggregates totals across instances instead of reporting one host` | `aggregateStats` → `dns_queries_today === 1400`, `ads_blocked_today === 140`, `ads_percentage_today === 10`, `queries_forwarded === 1100`, `queries_cached === 300`, `unique_clients === 5`, `domains_being_blocked === 1500`, `status === 'enabled'` |
| 4 | `reports a secondary auth failure instead of hiding it` | instance for `http://host-b.test` → `ok: false`, error matches `/PIHOLE_API_TOKEN/`; instance for `http://host-a.test` → `ok: true`, `queriesToday`/`dns_queries_today === 1000`; exactly one auth attempt on host-b (no re-arming) |
| 5 | `get_dns_status aggregates stats from both instances` | calls the registered `get_dns_status` handler with `../clients/kubernetes.js` mocked so one ready pihole pod exists → `stats.queriesToday === 1400`, `stats.blockedToday === 140`, `instances` length 2, both `ok === true` |
| 6 | `keeps single-host behavior when PIHOLE_URLS is unset` | `getPiholeUrls()` toEqual `['http://pihole-web.pihole.svc.cluster.local']`; handler `stats.queriesToday === 1000`; `instances` is `undefined` |

`verify.sh` checks (each can fail):

1. `PIHOLE_URLS` appears in `src/clients/pihole.ts` and `getPiholeUrls` is exported → fails if the
   multi-host config knob was never added.
2. `getFullStatsPerInstance` and `aggregateStats` are exported, and `PiholeInstanceStats` is exported → fails if aggregation stays inside `get_dns_status` only.
3. `src/tools/dns.ts` imports `getFullStatsPerInstance` and builds an `instances` field → fails if
   `get_dns_status` still calls only `getFullStats`.
4. The six `it(...)` titles exist verbatim in the new test file → fails if the tests are missing or renamed.
5. The expected literals `1400`, `140`, `host-a-sid`, `host-b-sid`, `1000` and `1500` appear in the
   test file → fails if fixtures were dropped or made identical (which would make summing untestable).
6. `npx vitest run src/__tests__/pihole-multi-instance.test.ts` exits 0 → fails on any behavioural mismatch.
7. `npx vitest run src/__tests__/pihole-auth.test.ts` exits 0 → fails if per-instance refactor broke the #44/#48 auth guarantees.

Checks 1-5, and 6, fail on today's tree (the file and exports do not exist).

## 12. Open questions

- Should `update_pihole_gravity` fan out to both instances once the secondary reports gravity age?
  Out of scope here (write fan-out needs its own decision and cooldown semantics).
- Is a per-instance env override for a different secondary password ever needed? Not assumed; one
  shared password is used by the brainrot CronJob today.
