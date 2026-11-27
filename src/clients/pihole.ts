// Pi-hole v6 API client
// Docs: http://pi.hole/api/docs (self-hosted on each Pi-hole instance)

const PIHOLE_URL = process.env.PIHOLE_URL || 'http://pihole-web.pihole.svc.cluster.local';
const PIHOLE_PASSWORD = process.env.PIHOLE_API_TOKEN || process.env.PIHOLE_PASSWORD;

/**
 * Every Pi-hole instance we poll, in config order — the FIRST entry is the primary.
 *
 * `PIHOLE_URLS` is a comma-separated list of instance base URLs; each entry is trimmed and empty
 * entries are dropped. When it yields no usable entry (unset, empty, or only commas/whitespace) we
 * fall back to `[PIHOLE_URL]`, which is exactly today's single-instance behaviour. HA DNS runs a
 * second resolver (`app: pihole-secondary`) that no URL pointed at, so its stats were simply
 * invisible (pi-cluster-mcp#45).
 *
 * Resolved per call rather than captured at import, so a process that sets the environment after
 * loading this module (a test, a reconfigured server) still gets the fleet it asked for.
 */
export function getInstanceUrls(): string[] {
  const list = (process.env.PIHOLE_URLS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // `PIHOLE_URL` is read per call for the same reason, and an unset variable must land on the
  // default rather than the literal string a stubbed `undefined` would give it.
  const fallback = process.env.PIHOLE_URL || PIHOLE_URL;
  return list.length > 0 ? list : [fallback];
}

/** The primary — first configured instance, and the source of every non-summed stats key. */
export function getPrimaryUrl(): string {
  return getInstanceUrls()[0];
}

interface InstanceSession {
  sessionId: string | null;
  sessionExpiry: number;
  // Shared across concurrent callers so a burst of parallel requests to THIS host performs ONE login.
  authInFlight: Promise<string | null> | null;
}

// Session state is per instance URL: each host has its own Pi-hole, so each host gets its own
// login and its own sid. A shared session would send the primary's sid to the secondary, which
// answers 401 — and the secondary's stats would be missing for reasons that look like an outage.
const sessions = new Map<string, InstanceSession>();
function sessionFor(url: string): InstanceSession {
  let session = sessions.get(url);
  if (!session) {
    session = { sessionId: null, sessionExpiry: 0, authInFlight: null };
    sessions.set(url, session);
  }
  return session;
}

// Set when FTL answers 429; suppresses further login attempts until it elapses.
let rateLimitedUntil: number = 0;

// How long to stop attempting logins after FTL rate-limits us, when it sends no Retry-After.
const RATE_LIMIT_COOLDOWN_MS = 60_000;

// In-flight `stats/summary` requests, keyed by instance URL. See `fetchSummaryStats()`.
const summaryInFlight = new Map<string, Promise<StatsResponse>>();

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

async function authenticate(url: string = getPrimaryUrl()): Promise<string | null> {
  const session = sessionFor(url);

  // Check if we have a valid session
  if (session.sessionId && Date.now() < session.sessionExpiry) {
    return session.sessionId;
  }

  // No password configured - some endpoints work without auth
  if (!PIHOLE_PASSWORD) {
    return null;
  }

  // FTL rate-limits login attempts, and retrying inside that window only re-arms the limiter —
  // which is how a single burst turned into a self-sustaining lockout (see pi-cluster-mcp#48).
  // Fail fast without touching the network until the cooldown elapses.
  if (Date.now() < rateLimitedUntil) {
    const seconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    throw new Error(
      `Pi-hole auth suppressed: FTL is rate-limiting login attempts; not retrying for ${seconds}s. ` +
        'This is throttling, NOT a bad credential — do not rotate PIHOLE_API_TOKEN on this error.',
    );
  }

  // Concurrent callers must share one login. get_dns_status alone fans out two parallel requests
  // (getFullStats + getMessages, itself fanning out three more), and every one of them missed the
  // not-yet-populated cache and fired its own POST /api/auth — tripping the limiter that then
  // failed them all. Single-flight collapses that burst into one attempt, per host.
  if (session.authInFlight) {
    return session.authInFlight;
  }

  const attempt = login(url);
  session.authInFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (session.authInFlight === attempt) {
      session.authInFlight = null;
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
 *
 * The instance URL is included so a per-instance failure (one node of an HA pair) names which
 * host failed.
 */
async function login(url: string): Promise<string | null> {
  const session = sessionFor(url);
  let response: Response;
  try {
    response = await fetch(`${url}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PIHOLE_PASSWORD }),
    });
  } catch (error) {
    session.sessionId = null;
    throw new Error(
      `Pi-hole auth request to ${url}/api/auth failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 429 is throttling, not a rejected credential. Blaming the password here would send the next
  // reader off to rotate a perfectly good secret — the same misdirection #44 was about, pointed
  // at a different cause.
  if (response.status === 429) {
    session.sessionId = null;
    const retryAfter = Number(response.headers.get('retry-after'));
    const cooldownMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_COOLDOWN_MS;
    rateLimitedUntil = Date.now() + cooldownMs;
    const detail = await readErrorDetail(response);
    throw new Error(
      `${url}: Pi-hole auth rate-limited: 429 Too Many Requests${detail} — FTL is throttling login attempts; ` +
        `backing off for ${Math.round(cooldownMs / 1000)}s. This is NOT a bad credential.`,
    );
  }

  if (!response.ok) {
    session.sessionId = null;
    const detail = await readErrorDetail(response);
    throw new Error(
      `${url}: Pi-hole auth failed: ${response.status} ${response.statusText}${detail} — PIHOLE_API_TOKEN must equal the Pi-hole web password (v6 authenticates via POST /api/auth)`,
    );
  }

  const data = (await response.json()) as AuthResponse;

  if (!data.session.valid || !data.session.sid) {
    session.sessionId = null;
    throw new Error(
      `${url}: Pi-hole auth rejected: no valid session returned — PIHOLE_API_TOKEN must equal the Pi-hole web password (v6 authenticates via POST /api/auth)`,
    );
  }

  session.sessionId = data.session.sid;
  rateLimitedUntil = 0;
  // Set expiry 30 seconds before actual expiry to be safe
  const validity = data.session.validity || 300;
  session.sessionExpiry = Date.now() + (validity - 30) * 1000;

  return session.sessionId;
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
 * Raw `stats/summary` from one instance, deduplicated within a run.
 *
 * `getFullStats()` needs the same payload twice — once for the legacy stats block, once for the
 * query-type breakdown — and `get_dns_status` fans out alongside it. Deduplicating in flight keeps
 * that at one request per host instead of two, which is the difference between talking politely to
 * FTL and re-arming its limiter (#48).
 */
function fetchSummaryStats(url: string): Promise<StatsResponse> {
  const inFlight = summaryInFlight.get(url);
  if (inFlight) return inFlight;

  // NOTE: `stats/summary` REQUIRES a session in Pi-hole v6. It was readable without one in v5, and
  // passing `requiresAuth = false` here is what made get_dns_status report `statsError: 401` for
  // months — independent of whether the credential was valid.
  const attempt = piholeFetch<StatsResponse>(url, 'stats/summary').finally(() => {
    if (summaryInFlight.get(url) === attempt) {
      summaryInFlight.delete(url);
    }
  });
  summaryInFlight.set(url, attempt);
  return attempt;
}

/**
 * One instance's `stats/summary`, in the legacy v5-shaped form the tools consume.
 *
 * `expiresImmediately` is what `getAllSummaries()` passes: that fan-out wants one request per host
 * per run, so its promise must not stay in the map for a later phase of the same run to reuse.
 * Callers that want the reuse keep the default, which shares a single request with everything else
 * launched while it is still in flight; the entry is dropped as soon as it settles, so the next
 * poll always re-reads live numbers.
 */
export async function getSummary(
  url: string = getPrimaryUrl(),
  expiresImmediately = false,
): Promise<PiholeStats> {
  const promise = fetchSummaryStats(url);
  if (expiresImmediately) summaryInFlight.delete(url);
  return convertStatsToLegacy(await promise);
}

export async function getTopItems(count = 10): Promise<{ top_queries: Record<string, number>; top_ads: Record<string, number> }> {
  const primaryUrl = getPrimaryUrl();
  const [topPermitted, topBlocked] = await Promise.all([
    piholeFetch<TopDomainsResponse>(primaryUrl, `stats/top_domains?count=${count}&blocked=false`),
    piholeFetch<TopDomainsResponse>(primaryUrl, `stats/top_domains?count=${count}&blocked=true`),
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
}

export async function getQueryTypes(): Promise<{ querytypes: Record<string, number> }> {
  // Query types are included in the stats summary in v6 (which requires auth — see getSummary),
  // so this reuses the run's in-flight request instead of issuing a second one.
  const stats = await fetchSummaryStats(getPrimaryUrl());
  const querytypes: Record<string, number> = {};

  const total = stats.queries.total || 1;
  for (const [type, count] of Object.entries(stats.queries.types || {})) {
    querytypes[type] = (count / total) * 100;
  }

  return { querytypes };
}

export async function getStatus(): Promise<{ status: string }> {
  try {
    const stats = await fetchSummaryStats(getPrimaryUrl());
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
    const response = await piholeFetch<MessagesResponse>(getPrimaryUrl(), 'info/messages');
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
    const response = await piholeFetch<DomainsResponse>(getPrimaryUrl(), 'domains/allow');
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
    const response = await piholeFetch<QueriesResponse>(getPrimaryUrl(), `queries?length=${count}`);
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

export async function updateGravity(): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  const sid = await authenticate(getPrimaryUrl());
  if (sid) {
    headers['sid'] = sid;
  }

  const response = await fetch(`${getPrimaryUrl()}/api/action/gravity`, {
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

/** What `getAllSummaries()` returns for one configured instance. */
export interface PiholeInstanceStats {
  url: string;
  ok: boolean;
  error?: string;
  summary?: PiholeStats;
}

/** The per-instance shape `get_dns_status` puts in `result.stats.instances`. */
export interface PiholeInstanceCounters {
  url: string;
  ok: boolean;
  queriesToday: number;
  blockedToday: number;
  error?: string;
}

export interface PiholeMultiStats extends PiholeFullStats {
  instances: PiholeInstanceCounters[];
  instancesTotal: number;
  instancesResponded: number;
  /** URLs of the instances whose own fetch failed, in config order. */
  instancesFailed: string[];
}

/**
 * Fetch `stats/summary` from every configured instance, capturing failures per instance instead
 * of letting one dead node take the whole fan-out down.
 *
 * `excludeUrls` is how `getStatsInstances()` avoids a second request to the primary, which it has
 * already fetched through `getFullStats()`.
 */
export async function getAllSummaries(excludeUrls: string[] = []): Promise<PiholeInstanceStats[]> {
  const targets = getInstanceUrls().filter((url) => !excludeUrls.includes(url));

  return Promise.all(
    targets.map(async (url): Promise<PiholeInstanceStats> => {
      try {
        // `true`: this fan-out owns one request per host for the run, and must not share or reuse
        // the primary's `getFullStats()` request beyond that.
        return { url, ok: true, summary: await getSummary(url, true) };
      } catch (error) {
        // Style from #44/#48 is preserved per instance; the URL says WHICH host failed.
        const message = error instanceof Error ? error.message : String(error);
        return {
          url,
          ok: false,
          error: message.includes(url) ? message : `${url}: ${message}`,
        };
      }
    }),
  );
}

/**
 * Stats for every configured Pi-hole, which is what `get_dns_status` calls.
 *
 * The primary is the single source for every per-instance number and for `instancesFailed`: it is
 * fetched once through `getFullStats()` (so every pre-existing stats key is sourced exactly as
 * before), and the remaining instances through `getAllSummaries()`. Only `queriesToday` and
 * `blockedToday` are summed; everything else stays the primary's.
 *
 * If the primary throws, this rejects with that error rather than returning zeroed totals —
 * "0 queries today" must never be reported when nothing answered, and the tool keeps its existing
 * `statsError` path for it.
 */
export async function getStatsInstances(topCount = 5): Promise<PiholeMultiStats> {
  const primaryUrl = getPrimaryUrl();
  const [primaryStats, others] = await Promise.all([
    getFullStats(topCount),
    getAllSummaries([primaryUrl]),
  ]);

  const instances: PiholeInstanceCounters[] = [
    {
      url: primaryUrl,
      ok: true,
      queriesToday: primaryStats.summary.dns_queries_today,
      blockedToday: primaryStats.summary.ads_blocked_today,
    },
    ...others.map((instance) => ({
      url: instance.url,
      ok: instance.ok,
      queriesToday: instance.ok ? instance.summary!.dns_queries_today : 0,
      blockedToday: instance.ok ? instance.summary!.ads_blocked_today : 0,
      ...(instance.error ? { error: instance.error } : {}),
    })),
  ];

  const responded = instances.filter((instance) => instance.ok);

  return {
    ...primaryStats,
    summary: {
      ...primaryStats.summary,
      dns_queries_today: responded.reduce((sum, instance) => sum + instance.queriesToday, 0),
      ads_blocked_today: responded.reduce((sum, instance) => sum + instance.blockedToday, 0),
    },
    instances,
    instancesTotal: instances.length,
    instancesResponded: responded.length,
    instancesFailed: instances.filter((instance) => !instance.ok).map((instance) => instance.url),
  };
}
