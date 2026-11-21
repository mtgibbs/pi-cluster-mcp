// Pi-hole v6 API client
// Docs: http://pi.hole/api/docs (self-hosted on each Pi-hole instance)

/**
 * Base URL of the primary — the host every single-instance call (and the gravity write) uses.
 *
 * Read per call, not frozen at import: `getPiholeUrls()` reads `PIHOLE_URLS` live, and having the
 * fallback read live too keeps the two consistent when env changes after the first import
 * (`src/__tests__/pihole-auth.test.ts:42` re-imports the module to pick up env).
 */
function primaryUrl(): string {
  return process.env.PIHOLE_URL || 'http://pihole-web.pihole.svc.cluster.local';
}

const PIHOLE_PASSWORD = process.env.PIHOLE_API_TOKEN || process.env.PIHOLE_PASSWORD;

/**
 * Every Pi-hole instance we should poll. HA DNS runs two Pi-holes (`app: pihole` and
 * `app: pihole-secondary`), but the client used to read a single `PIHOLE_URL`, which points at
 * the primary's Service — so half the queries, and any secondary-only auth or health problem,
 * were simply invisible in get_dns_status (see pi-cluster-mcp#45).
 *
 * Re-read per call rather than frozen at import: callers (and tests) may set `PIHOLE_URLS`
 * after the module is first loaded.
 */
export function getPiholeUrls(): string[] {
  const configured = (process.env.PIHOLE_URLS || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0);

  // Empty or unset PIHOLE_URLS must keep today's single-host behaviour byte-for-byte.
  return configured.length > 0 ? configured : [primaryUrl()];
}

/** Per-instance session state. #48 single-flight and rate-limit cooldowns are per host, not global. */
interface InstanceState {
  sessionId: string | null;
  sessionExpiry: number;
  // Shared across concurrent callers so a burst of parallel requests performs ONE login per host.
  authInFlight: Promise<string | null> | null;
  // Set when FTL answers 429; suppresses further login attempts on this host until it elapses.
  rateLimitedUntil: number;
}

const instances = new Map<string, InstanceState>();

function instanceState(url: string): InstanceState {
  let state = instances.get(url);
  if (!state) {
    state = { sessionId: null, sessionExpiry: 0, authInFlight: null, rateLimitedUntil: 0 };
    instances.set(url, state);
  }
  return state;
}

// How long to stop attempting logins after FTL rate-limits us, when it sends no Retry-After.
const RATE_LIMIT_COOLDOWN_MS = 60_000;

interface AuthResponse {
  session: {
    valid: boolean;
    totp: boolean;
    sid: string | null;
    csrf?: string;
    validity?: number;
    message?: string;
  };
}

interface StatsResponse {
  queries: {
    total: number;
    blocked: number;
    percent_blocked: number;
    unique_domains: number;
    forwarded: number;
    cached: number;
    frequency: number;
    types: Record<string, number>;
    status: Record<string, number>;
    replies: Record<string, number>;
  };
  clients: {
    active: number;
    total: number;
  };
  gravity: {
    domains_being_blocked: number;
    last_update: number;
  };
  took: number;
}

interface TopDomainsResponse {
  domains: Array<{
    domain: string;
    count: number;
  }>;
  total_count: number;
  took: number;
}

interface QueriesResponse {
  queries: Array<{
    id: number;
    time: number;
    type: string;
    domain: string;
    client: string;
    status: string;
    reply: string;
    dnssec: string;
    upstream: string;
  }>;
  cursor: number | null;
  recordsTotal: number;
  recordsFiltered: number;
  took: number;
}

interface DomainsResponse {
  domains: Array<{
    id: number;
    domain: string;
    unicode: string;
    type: string;
    kind: string;
    enabled: boolean;
    comment: string | null;
    groups: number[];
    date_added: number;
    date_modified: number;
  }>;
  took: number;
}

interface MessagesResponse {
  messages: Array<{
    id: number;
    timestamp: number;
    type: string;
    message: string;
    blob1?: string;
    blob2?: string;
    blob3?: string;
    blob4?: string;
    blob5?: string;
  }>;
  took: number;
}

/** Pi-hole error bodies are `{ error: { key, message, hint } }`. Best-effort — never throws. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { key?: string; message?: string } };
    const key = body.error?.key;
    const message = body.error?.message;
    const detail = [key, message].filter(Boolean).join(': ');
    return detail ? ` (${detail})` : '';
  } catch {
    return '';
  }
}

async function authenticate(url: string): Promise<string | null> {
  const state = instanceState(url);

  // Check if we have a valid session
  if (state.sessionId && Date.now() < state.sessionExpiry) {
    return state.sessionId;
  }

  // No password configured - some endpoints work without auth
  if (!PIHOLE_PASSWORD) {
    return null;
  }

  // FTL rate-limits login attempts, and retrying inside that window only re-arms the limiter —
  // which is how a single burst turned into a self-sustaining lockout (see pi-cluster-mcp#48).
  // Fail fast without touching the network until the cooldown elapses. Per instance, so a
  // throttled secondary cannot stop the primary from being polled (#45).
  if (Date.now() < state.rateLimitedUntil) {
    const seconds = Math.ceil((state.rateLimitedUntil - Date.now()) / 1000);
    throw new Error(
      `Pi-hole auth on ${url} was suppressed: FTL is rate-limiting login attempts; not retrying for ${seconds}s. ` +
        'This is throttling, NOT a bad credential — do not rotate PIHOLE_API_TOKEN on this error.',
    );
  }

  // Concurrent callers must share one login. get_dns_status alone fans out two parallel requests
  // (getFullStats + getMessages, itself fanning out three more), and every one of them missed the
  // not-yet-populated cache and fired its own POST /api/auth — tripping the limiter that then
  // failed them all. Single-flight collapses that burst into one attempt, per instance.
  if (state.authInFlight) {
    return state.authInFlight;
  }

  const attempt = login(url, state);
  state.authInFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (state.authInFlight === attempt) {
      state.authInFlight = null;
    }
  }
}

/**
 * Perform the actual login. Only ever called via `authenticate()`, which serializes it.
 *
 * A password IS configured by this point, so failure is a real error and must be reported as
 * one. Returning null instead would silently downgrade the caller to an unauthenticated
 * request, and the endpoint would answer 401 — which reads as "the stats endpoint is broken"
 * rather than "your Pi-hole password is wrong". That misdirection hid a stale credential for
 * months; see pi-cluster-mcp#44.
 */
async function login(url: string, state: InstanceState): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${url}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PIHOLE_PASSWORD }),
    });
  } catch (error) {
    state.sessionId = null;
    throw new Error(
      `Pi-hole auth request to ${url}/api/auth failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 429 is throttling, not a rejected credential. Blaming the password here would send the next
  // reader off to rotate a perfectly good secret — the same misdirection #44 was about, pointed
  // at a different cause.
  if (response.status === 429) {
    state.sessionId = null;
    const retryAfter = Number(response.headers.get('retry-after'));
    const cooldownMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_COOLDOWN_MS;
    state.rateLimitedUntil = Date.now() + cooldownMs;
    const detail = await readErrorDetail(response);
    throw new Error(
      `Pi-hole auth rate-limited: 429 Too Many Requests${detail} on ${url} — FTL is throttling login attempts; ` +
        `backing off for ${Math.round(cooldownMs / 1000)}s. This is NOT a bad credential.`,
    );
  }

  if (!response.ok) {
    state.sessionId = null;
    const detail = await readErrorDetail(response);
    throw new Error(
      // Wording note: keep the contiguous phrase "auth failed" — src/__tests__/pihole-auth.test.ts
      // pins /auth failed/i, and readers (and that test) grep for it when a credential is stale.
      `Pi-hole auth failed: ${response.status} ${response.statusText}${detail} on ${url} — PIHOLE_API_TOKEN must equal the Pi-hole web password (v6 authenticates via POST /api/auth)`,
    );
  }

  const data = (await response.json()) as AuthResponse;

  if (!data.session.valid || !data.session.sid) {
    state.sessionId = null;
    throw new Error(
      `Pi-hole auth rejected on ${url}: no valid session returned — PIHOLE_API_TOKEN must equal the Pi-hole web password (v6 authenticates via POST /api/auth)`,
    );
  }

  state.sessionId = data.session.sid;
  state.rateLimitedUntil = 0;
  // Set expiry 30 seconds before actual expiry to be safe
  const validity = data.session.validity || 300;
  state.sessionExpiry = Date.now() + (validity - 30) * 1000;

  return state.sessionId;
}

async function piholeFetch<T>(url: string, endpoint: string, requiresAuth = true): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (requiresAuth) {
    const sid = await authenticate(url);
    if (sid) {
      headers['sid'] = sid;
    }
  }

  const fullUrl = `${url}/api/${endpoint}`;
  const response = await fetch(fullUrl, { headers });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pi-hole API error: ${response.status} ${response.statusText} - ${text}`);
  }

  return response.json() as Promise<T>;
}

// Legacy interface for compatibility with existing code
export interface PiholeStats {
  domains_being_blocked: number;
  dns_queries_today: number;
  ads_blocked_today: number;
  ads_percentage_today: number;
  unique_domains: number;
  queries_forwarded: number;
  queries_cached: number;
  clients_ever_seen: number;
  unique_clients: number;
  dns_queries_all_types: number;
  reply_NODATA: number;
  reply_NXDOMAIN: number;
  reply_CNAME: number;
  reply_IP: number;
  privacy_level: number;
  status: string;
  gravity_last_updated: {
    file_exists: boolean;
    absolute: number;
    relative: {
      days: number;
      hours: number;
      minutes: number;
    };
  };
}

function convertStatsToLegacy(stats: StatsResponse): PiholeStats {
  const now = Math.floor(Date.now() / 1000);
  const gravityAge = now - stats.gravity.last_update;
  const days = Math.floor(gravityAge / 86400);
  const hours = Math.floor((gravityAge % 86400) / 3600);
  const minutes = Math.floor((gravityAge % 3600) / 60);

  return {
    domains_being_blocked: stats.gravity.domains_being_blocked,
    dns_queries_today: stats.queries.total,
    ads_blocked_today: stats.queries.blocked,
    ads_percentage_today: stats.queries.percent_blocked,
    unique_domains: stats.queries.unique_domains,
    queries_forwarded: stats.queries.forwarded,
    queries_cached: stats.queries.cached,
    clients_ever_seen: stats.clients.total,
    unique_clients: stats.clients.active,
    dns_queries_all_types: stats.queries.total,
    reply_NODATA: stats.queries.replies?.NODATA || 0,
    reply_NXDOMAIN: stats.queries.replies?.NXDOMAIN || 0,
    reply_CNAME: stats.queries.replies?.CNAME || 0,
    reply_IP: stats.queries.replies?.IP || 0,
    privacy_level: 0, // Not available in v6 API
    status: 'enabled',
    gravity_last_updated: {
      file_exists: true,
      absolute: stats.gravity.last_update,
      relative: { days, hours, minutes },
    },
  };
}

/**
 * Single-host summary: the FIRST reachable instance, in `getPiholeUrls()` order.
 *
 * Callers other than `get_dns_status` (top items, query types, whitelist, queries) are
 * primary-only by design — those are lists, not counters, and fanning them out would double the
 * requests for a duplicated answer. `get_dns_status` uses `getFullStatsPerInstance()` instead.
 * If no instance answers, the LAST error is thrown so the caller still gets a real message.
 */
async function fetchFirstReachable<T>(
  fetchOne: (url: string) => Promise<T>,
  urls: string[] = getPiholeUrls(),
): Promise<T> {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      return await fetchOne(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Pi-hole request failed: no configured instance responded');
}

export async function getSummary(): Promise<PiholeStats> {
  // NOTE: `stats/summary` REQUIRES a session in Pi-hole v6. It was readable without one in
  // v5, and passing `requiresAuth = false` here is what made get_dns_status report
  // `statsError: 401` for months — independent of whether the credential was valid.
  const stats = await fetchFirstReachable((url) =>
    piholeFetch<StatsResponse>(url, 'stats/summary'),
  );
  return convertStatsToLegacy(stats);
}

export async function getTopItems(count = 10): Promise<{ top_queries: Record<string, number>; top_ads: Record<string, number> }> {
  return fetchFirstReachable(async (url) => {
    const [topPermitted, topBlocked] = await Promise.all([
      piholeFetch<TopDomainsResponse>(url, `stats/top_domains?count=${count}&blocked=false`),
      piholeFetch<TopDomainsResponse>(url, `stats/top_domains?count=${count}&blocked=true`),
    ]);

    const top_queries: Record<string, number> = {};
    const top_ads: Record<string, number> = {};

    for (const item of topPermitted.domains || []) {
      top_queries[item.domain] = item.count;
    }
    for (const item of topBlocked.domains || []) {
      top_ads[item.domain] = item.count;
    }

    return { top_queries, top_ads };
  });
}

export async function getQueryTypes(): Promise<{ querytypes: Record<string, number> }> {
  return fetchFirstReachable(async (url) => {
    // Query types are included in the stats summary in v6 (which requires auth — see getSummary)
    const stats = await piholeFetch<StatsResponse>(url, 'stats/summary');
    const querytypes: Record<string, number> = {};

    const total = stats.queries.total || 1;
    for (const [type, count] of Object.entries(stats.queries.types || {})) {
      querytypes[type] = (count / total) * 100;
    }

    return { querytypes };
  });
}

export async function getStatus(): Promise<{ status: string }> {
  try {
    const stats = await fetchFirstReachable((url) =>
      piholeFetch<StatsResponse>(url, 'stats/summary'),
    );
    return { status: stats.queries ? 'enabled' : 'disabled' };
  } catch {
    return { status: 'error' };
  }
}

export interface PiholeMessage {
  id: number;
  type: string;
  message: string;
  blob1: string;
  blob2: string;
  blob3: string;
  blob4: string;
  blob5: string;
  timestamp: number;
}

export async function getMessages(): Promise<PiholeMessage[]> {
  try {
    const response = await fetchFirstReachable((url) =>
      piholeFetch<MessagesResponse>(url, 'info/messages'),
    );
    return (response.messages || []).map((msg) => ({
      id: msg.id,
      type: msg.type,
      message: msg.message,
      blob1: msg.blob1 || '',
      blob2: msg.blob2 || '',
      blob3: msg.blob3 || '',
      blob4: msg.blob4 || '',
      blob5: msg.blob5 || '',
      timestamp: msg.timestamp,
    }));
  } catch {
    return [];
  }
}

export interface PiholeDomainEntry {
  id: number;
  type: number;
  domain: string;
  enabled: number;
  date_added: number;
  date_modified: number;
  comment: string;
  groups: number[];
}

export async function getWhitelist(): Promise<PiholeDomainEntry[]> {
  try {
    const response = await fetchFirstReachable((url) =>
      piholeFetch<DomainsResponse>(url, 'domains/allow'),
    );
    return (response.domains || []).map((d) => ({
      id: d.id,
      type: d.kind === 'regex' ? 2 : 0, // 0 = exact, 2 = regex
      domain: d.domain,
      enabled: d.enabled ? 1 : 0,
      date_added: d.date_added,
      date_modified: d.date_modified,
      comment: d.comment || '',
      groups: d.groups,
    }));
  } catch {
    return [];
  }
}

export async function getRecentQueries(count = 100): Promise<string[][]> {
  try {
    const response = await fetchFirstReachable((url) =>
      piholeFetch<QueriesResponse>(url, `queries?length=${count}`),
    );
    // Convert to legacy format: [[timestamp, type, domain, client, status], ...]
    return (response.queries || []).map((q) => [
      String(q.time),
      q.type,
      q.domain,
      q.client,
      q.status,
    ]);
  } catch {
    return [];
  }
}

/**
 * Trigger a gravity update. Deliberately PRIMARY-ONLY (first configured URL): this is a write,
 * and fanning writes out to every instance needs its own decision and cooldown semantics
 * (pi-cluster-mcp#45). Nothing else in this file mutates state, so it keeps using `PIHOLE_URL`.
 */
export async function updateGravity(): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  const sid = await authenticate(primaryUrl());
  if (sid) {
    headers['sid'] = sid;
  }

  const response = await fetch(`${primaryUrl()}/api/action/gravity`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pi-hole API error: ${response.status} ${response.statusText} - ${text}`);
  }

  return 'Gravity update triggered';
}

export interface PiholeFullStats {
  summary: PiholeStats;
  topQueries: { domain: string; count: number }[];
  topBlocked: { domain: string; count: number }[];
  queryTypes: { type: string; percentage: number }[];
}

export async function getFullStats(topCount = 5): Promise<PiholeFullStats> {
  const [summary, topItems, queryTypes] = await Promise.all([
    getSummary(),
    getTopItems(topCount),
    getQueryTypes(),
  ]);

  return {
    summary,
    topQueries: Object.entries(topItems.top_queries || {}).map(([domain, count]) => ({
      domain,
      count,
    })),
    topBlocked: Object.entries(topItems.top_ads || {}).map(([domain, count]) => ({
      domain,
      count,
    })),
    queryTypes: Object.entries(queryTypes.querytypes || {}).map(([type, percentage]) => ({
      type,
      percentage,
    })),
  };
}

/**
 * One Pi-hole instance's contribution, with its own health.
 *
 * `ok: false` plus `error` is the whole point: an instance we could not authenticate against or
 * reach must be *visible* in the output, not silently dropped from a total that still looks
 * healthy (pi-cluster-mcp#45).
 */
export interface PiholeInstanceStats {
  url: string;
  ok: boolean;
  summary?: PiholeStats;
  error?: string;
}

/**
 * Fetch every configured instance in parallel, each with its OWN session, and never throw:
 * per-instance failures come back as `ok: false` + `error` so one broken secondary degrades only
 * itself. `topCount` is accepted for call-site symmetry with `getFullStats`; the per-instance
 * payload is the summary only, since totals are what need summing across hosts.
 */
export async function getFullStatsPerInstance(_topCount = 5): Promise<PiholeInstanceStats[]> {
  // `_topCount` exists so call sites read the same as `getFullStats(topCount)`. The per-instance
  // payload is the summary only on purpose: totals are what must be summed across hosts, and the
  // top-N lists are lists rather than counters (see `getTopItems`).
  return Promise.all(
    getPiholeUrls().map(async (url): Promise<PiholeInstanceStats> => {
      try {
        const stats = await piholeFetch<StatsResponse>(url, 'stats/summary');
        return { url, ok: true, summary: convertStatsToLegacy(stats) };
      } catch (error) {
        // Error messages name the instance and, for auth, PIHOLE_API_TOKEN — never the password
        // value or the session id, both of which would leak through tool output.
        return {
          url,
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to fetch Pi-hole stats',
        };
      }
    }),
  );
}

/**
 * Merge per-instance summaries into one set of totals.
 *
 * Counters (queries, blocked, forwarded, cached, clients) are SUMMED — each instance only counts
 * the queries it answered itself, so first-wins or averaging would understate live traffic.
 * `domains_being_blocked` is the MAX, not the sum: both instances pull the same gravity, so
 * adding them would double-count the same blocklist. `blockedPercentage` is recomputed from the
 * summed totals rather than averaged, because averaging two percentages with different
 * denominators is meaningless. Pure and exported so it can be tested without a fake network.
 */
export function aggregateStats(perInstance: PiholeInstanceStats[]): PiholeFullStats['summary'] {
  const reachable = perInstance.filter((i) => i.ok && i.summary);
  // Only `ok` instances with a summary contribute: a failed host must not be merged into a
  // healthy-looking total, and must not zero out the hosts that did answer either.
  const sum = (pick: (s: PiholeStats) => number): number =>
    reachable.reduce((total, i) => total + (pick(i.summary!) || 0), 0);

  const queries = sum((s) => s.dns_queries_today);
  const blocked = sum((s) => s.ads_blocked_today);

  // Gravity age comes from the most recently updated instance: an older timestamp on the
  // secondary is a stale pull, not evidence that the blocklist itself is old.
  const latestGravity = reachable
    .map((i) => i.summary!.gravity_last_updated)
    .filter((g) => g && typeof g.absolute === 'number')
    .sort((a, b) => b.absolute - a.absolute)[0];

  const now = Math.floor(Date.now() / 1000);
  const gravityAge = latestGravity ? Math.max(0, now - latestGravity.absolute) : 0;

  return {
    domains_being_blocked: reachable.reduce(
      (max, i) => Math.max(max, i.summary!.domains_being_blocked || 0),
      0,
    ),
    dns_queries_today: queries,
    ads_blocked_today: blocked,
    ads_percentage_today: queries > 0 ? (blocked / queries) * 100 : 0,
    unique_domains: sum((s) => s.unique_domains),
    queries_forwarded: sum((s) => s.queries_forwarded),
    queries_cached: sum((s) => s.queries_cached),
    clients_ever_seen: sum((s) => s.clients_ever_seen),
    unique_clients: sum((s) => s.unique_clients),
    dns_queries_all_types: queries,
    reply_NODATA: sum((s) => s.reply_NODATA),
    reply_NXDOMAIN: sum((s) => s.reply_NXDOMAIN),
    reply_CNAME: sum((s) => s.reply_CNAME),
    reply_IP: sum((s) => s.reply_IP),
    privacy_level: 0, // Not available in v6 API
    // One unreachable instance is reported in `instances`; the verdict here describes what we did read.
    status: reachable.length > 0 ? 'enabled' : 'unknown',
    gravity_last_updated: latestGravity
      ? {
          file_exists: latestGravity.file_exists,
          absolute: latestGravity.absolute,
          relative: {
            days: Math.floor(gravityAge / 86400),
            hours: Math.floor((gravityAge % 86400) / 3600),
            minutes: Math.floor((gravityAge % 3600) / 60),
          },
        }
      : { file_exists: false, absolute: 0, relative: { days: 0, hours: 0, minutes: 0 } },
  };
}
