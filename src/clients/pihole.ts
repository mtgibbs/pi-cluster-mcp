// Pi-hole v6 API client
// Docs: http://pi.hole/api/docs (self-hosted on each Pi-hole instance)

const PIHOLE_URL = process.env.PIHOLE_URL || 'http://pihole-web.pihole.svc.cluster.local';
const PIHOLE_PASSWORD = process.env.PIHOLE_API_TOKEN || process.env.PIHOLE_PASSWORD;

// Session management
let sessionId: string | null = null;
let sessionExpiry: number = 0;

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

async function authenticate(): Promise<string | null> {
  // Check if we have a valid session
  if (sessionId && Date.now() < sessionExpiry) {
    return sessionId;
  }

  // No password configured - some endpoints work without auth
  if (!PIHOLE_PASSWORD) {
    return null;
  }

  try {
    const response = await fetch(`${PIHOLE_URL}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PIHOLE_PASSWORD }),
    });

    if (!response.ok) {
      throw new Error(`Auth failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as AuthResponse;

    if (!data.session.valid || !data.session.sid) {
      // No password set on Pi-hole, or auth failed
      sessionId = null;
      return null;
    }

    sessionId = data.session.sid;
    // Set expiry 30 seconds before actual expiry to be safe
    const validity = data.session.validity || 300;
    sessionExpiry = Date.now() + (validity - 30) * 1000;

    return sessionId;
  } catch (error) {
    console.error('Pi-hole auth error:', error);
    sessionId = null;
    return null;
  }
}

async function piholeFetch<T>(endpoint: string, requiresAuth = true): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (requiresAuth) {
    const sid = await authenticate();
    if (sid) {
      headers['sid'] = sid;
    }
  }

  const url = `${PIHOLE_URL}/api/${endpoint}`;
  const response = await fetch(url, { headers });

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

export async function getSummary(): Promise<PiholeStats> {
  const stats = await piholeFetch<StatsResponse>('stats/summary', false);
  return convertStatsToLegacy(stats);
}

export async function getTopItems(count = 10): Promise<{ top_queries: Record<string, number>; top_ads: Record<string, number> }> {
  const [topPermitted, topBlocked] = await Promise.all([
    piholeFetch<TopDomainsResponse>(`stats/top_domains?count=${count}&blocked=false`),
    piholeFetch<TopDomainsResponse>(`stats/top_domains?count=${count}&blocked=true`),
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
  // Query types are included in the stats summary in v6
  const stats = await piholeFetch<StatsResponse>('stats/summary', false);
  const querytypes: Record<string, number> = {};

  const total = stats.queries.total || 1;
  for (const [type, count] of Object.entries(stats.queries.types || {})) {
    querytypes[type] = (count / total) * 100;
  }

  return { querytypes };
}

export async function getStatus(): Promise<{ status: string }> {
  try {
    const stats = await piholeFetch<StatsResponse>('stats/summary', false);
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
    const response = await piholeFetch<MessagesResponse>('info/messages');
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
    const response = await piholeFetch<DomainsResponse>('domains/allow');
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
    const response = await piholeFetch<QueriesResponse>(`queries?length=${count}`);
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

  const sid = await authenticate();
  if (sid) {
    headers['sid'] = sid;
  }

  const response = await fetch(`${PIHOLE_URL}/api/action/gravity`, {
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
