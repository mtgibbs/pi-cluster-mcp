const PIHOLE_URL = process.env.PIHOLE_URL || 'http://pihole.pihole.svc.cluster.local';
const PIHOLE_API_TOKEN = process.env.PIHOLE_API_TOKEN;

interface PiholeStats {
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

interface TopItems {
  top_queries: Record<string, number>;
  top_ads: Record<string, number>;
}

interface QueryTypes {
  querytypes: Record<string, number>;
}

interface PiholeMessage {
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

interface PiholeMessagesResponse {
  messages: PiholeMessage[];
}

async function piholeFetch<T>(endpoint: string): Promise<T> {
  const params = new URLSearchParams();
  if (PIHOLE_API_TOKEN) {
    params.set('auth', PIHOLE_API_TOKEN);
  }

  const url = `${PIHOLE_URL}/admin/api.php?${endpoint}&${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Pi-hole API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function getSummary(): Promise<PiholeStats> {
  return piholeFetch<PiholeStats>('summary');
}

export async function getTopItems(count = 10): Promise<TopItems> {
  return piholeFetch<TopItems>(`topItems=${count}`);
}

export async function getQueryTypes(): Promise<QueryTypes> {
  return piholeFetch<QueryTypes>('getQueryTypes');
}

export async function getStatus(): Promise<{ status: string }> {
  return piholeFetch<{ status: string }>('status');
}

export async function getMessages(): Promise<PiholeMessage[]> {
  const response = await piholeFetch<PiholeMessagesResponse>('messages');
  return response.messages || [];
}

export async function updateGravity(): Promise<string> {
  const params = new URLSearchParams();
  if (PIHOLE_API_TOKEN) {
    params.set('auth', PIHOLE_API_TOKEN);
  }

  const url = `${PIHOLE_URL}/admin/api.php?updateGravity&${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Pi-hole API error: ${response.status} ${response.statusText}`);
  }

  return response.text();
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
