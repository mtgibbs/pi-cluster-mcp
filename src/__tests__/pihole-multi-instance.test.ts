import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PiholeStats } from '../clients/pihole.js';

// Regression tests for pi-cluster-mcp#45.
//
// HA DNS runs TWO Pi-holes. The client read a single `PIHOLE_URL`, which points at the primary's
// Service (`app: pihole`); the secondary runs as `app: pihole-secondary` and was therefore never
// authenticated against or polled. So `get_dns_status` reported one of two resolvers, and a
// secondary-only auth or health problem produced no signal at all.
//
// The fixtures deliberately use DIFFERENT numbers per host (1000 vs 400 queries, 100 vs 40
// blocked, 1500 vs 1200 gravity domains). Identical fixtures could not tell "summed" apart from
// "first one wins" or "averaged", which is exactly the class of bug this spec forbids.

const HOST_A = 'http://host-a.test';
const HOST_B = 'http://host-b.test';
const SID_A = 'host-a-sid';
const SID_B = 'host-b-sid';

function authOk(sid: string): Response {
  return new Response(
    JSON.stringify({ session: { valid: true, totp: false, sid, validity: 300 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function authFail(): Response {
  return new Response(JSON.stringify({ error: { key: 'unauthorized' } }), { status: 401 });
}

function summaryOk(url: string): Response {
  const v = url.includes('host-b')
    ? { total: 400, blocked: 40, forwarded: 300, cached: 100, active: 2, gravity: 1200 }
    : { total: 1000, blocked: 100, forwarded: 800, cached: 200, active: 3, gravity: 1500 };
  return new Response(
    JSON.stringify({
      queries: {
        total: v.total,
        blocked: v.blocked,
        percent_blocked: 10,
        unique_domains: 50,
        forwarded: v.forwarded,
        cached: v.cached,
        frequency: 1,
        types: { A: 60, AAAA: 40 },
        status: {},
        replies: {},
      },
      clients: { active: v.active, total: 9 },
      gravity: { domains_being_blocked: v.gravity, last_update: Math.floor(Date.now() / 1000) },
      took: 0.001,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function topDomainsOk(): Response {
  return new Response(JSON.stringify({ domains: [], total_count: 0, took: 0.001 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function messagesOk(): Response {
  return new Response(JSON.stringify({ messages: [], took: 0.001 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The legacy-shaped summary the client produces, for exercising `aggregateStats` with no network. */
function makeSummary(v: {
  queries: number;
  blocked: number;
  forwarded: number;
  cached: number;
  clients: number;
  gravity: number;
}): PiholeStats {
  return {
    domains_being_blocked: v.gravity,
    dns_queries_today: v.queries,
    ads_blocked_today: v.blocked,
    ads_percentage_today: v.queries > 0 ? (v.blocked / v.queries) * 100 : 0,
    unique_domains: 50,
    queries_forwarded: v.forwarded,
    queries_cached: v.cached,
    clients_ever_seen: 9,
    unique_clients: v.clients,
    dns_queries_all_types: v.queries,
    reply_NODATA: 0,
    reply_NXDOMAIN: 0,
    reply_CNAME: 0,
    reply_IP: 0,
    privacy_level: 0,
    status: 'enabled',
    gravity_last_updated: {
      file_exists: true,
      absolute: Math.floor(Date.now() / 1000),
      relative: { days: 0, hours: 0, minutes: 1 },
    },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Fake FTL. `authFor` decides the /api/auth answer per host; everything else answers 200 with a
 * payload matched on the endpoint. `calls` is passed in rather than created here so a test can
 * keep observing the same log across a `vi.resetModules()` re-import (the tool tests do two
 * phases: client probe, then the handler).
 */
function installFetch(
  calls: Call[],
  authFor: (url: string) => Response = (url) => authOk(url.includes('host-b') ? SID_B : SID_A),
): Call[] {
  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    // Snapshot the headers: the SAME object is reused across hosts by the caller's loop, and
    // Node's global fetch mutates it when it builds the request. Keeping a reference here would
    // make every recorded call show whichever sid was written last.
    const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
    calls.push({ url, method, headers });

    if (url.includes('/api/auth')) {
      return Promise.resolve(authFor(url));
    }
    if (url.includes('stats/top_domains')) return Promise.resolve(topDomainsOk());
    if (url.includes('info/messages')) return Promise.resolve(messagesOk());
    if (url.includes('stats/summary')) return Promise.resolve(summaryOk(url));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const toHost = (url: string, host: string): boolean => url.startsWith(`http://${host}`);
const authCallsTo = (calls: Call[], host: string): Call[] =>
  calls.filter((c) => c.url.includes('/api/auth') && toHost(c.url, host));
const summaryCallsTo = (calls: Call[], host: string): Call[] =>
  calls.filter((c) => c.url.includes('stats/summary') && toHost(c.url, host));

/** Import the client fresh — it reads env into module-level consts at import time. */
async function loadClient(): Promise<typeof import('../clients/pihole.js')> {
  vi.resetModules();
  return import('../clients/pihole.js');
}

const MULTI = `${HOST_A},${HOST_B}`;

describe('pihole client — multiple instances (HA DNS, #45)', () => {
  beforeEach(() => {
    vi.stubEnv('PIHOLE_URLS', MULTI);
    vi.stubEnv('PIHOLE_API_TOKEN', 'the-web-password');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches every configured Pi-hole instance with its own login', async () => {
    const calls: Call[] = [];
    installFetch(calls);

    const { getFullStatsPerInstance, getPiholeUrls } = await loadClient();
    const instances = await getFullStatsPerInstance(1);

    expect(getPiholeUrls()).toHaveLength(2);
    // The regression this guards: the secondary was never contacted at all.
    expect(authCallsTo(calls, 'host-a.test')).toHaveLength(1);
    expect(authCallsTo(calls, 'host-b.test')).toHaveLength(1);
    expect(summaryCallsTo(calls, 'host-a.test')).toHaveLength(1);
    expect(summaryCallsTo(calls, 'host-b.test')).toHaveLength(1);
    expect(instances).toHaveLength(2);
  });

  it('never reuses a session id across instances', async () => {
    const calls: Call[] = [];
    installFetch(calls);

    const { getFullStatsPerInstance } = await loadClient();
    await getFullStatsPerInstance(1);

    // Each host answered with a different sid; each summary GET must carry its own host's sid.
    // A shared (or per-request) session cache would put one host's sid on the other's request.
    expect(summaryCallsTo(calls, 'host-a.test')[0]?.headers.sid).toBe(SID_A);
    expect(summaryCallsTo(calls, 'host-b.test')[0]?.headers.sid).toBe(SID_B);

    // Second round: sessions are cached PER host, so no extra logins and still no sid crossover.
    await getFullStatsPerInstance(1);
    expect(authCallsTo(calls, 'host-a.test')).toHaveLength(1);
    expect(authCallsTo(calls, 'host-b.test')).toHaveLength(1);
    expect(summaryCallsTo(calls, 'host-a.test')[1]?.headers.sid).toBe(SID_A);
    expect(summaryCallsTo(calls, 'host-b.test')[1]?.headers.sid).toBe(SID_B);
  });

  it('aggregates totals across instances instead of reporting one host', async () => {
    // Built from fixtures rather than fetched: aggregateStats is pure, and pinning the inputs here
    // means a first-wins or averaged implementation cannot hide behind a permissive fake fetch.
    const { aggregateStats } = await loadClient();
    const totals = aggregateStats([
      // An unreachable instance contributes nothing but must not zero the others out.
      { url: 'http://down.test', ok: false, error: 'Pi-hole auth failed: 401 — PIHOLE_API_TOKEN is wrong' },
      { url: HOST_A, ok: true, summary: makeSummary({ queries: 1000, blocked: 100, forwarded: 800, cached: 200, clients: 3, gravity: 1500 }) },
      { url: HOST_B, ok: true, summary: makeSummary({ queries: 400, blocked: 40, forwarded: 300, cached: 100, clients: 2, gravity: 1200 }) },
    ]);

    // 1000 + 400 and 100 + 40 — never 1000 (first wins) and never 700/70 (average).
    expect(totals.dns_queries_today).toBe(1400);
    expect(totals.ads_blocked_today).toBe(140);
    // Recomputed from the summed totals, not averaged from the two percent_blocked values.
    expect(totals.ads_percentage_today).toBe(10);
    expect(totals.queries_forwarded).toBe(1100);
    expect(totals.queries_cached).toBe(300);
    expect(totals.unique_clients).toBe(5);
    // Both instances pull the same gravity, so the shared blocklist is the MAX, not the sum.
    expect(totals.domains_being_blocked).toBe(1500);
    expect(totals.status).toBe('enabled');
  });

  it('reports a secondary auth failure instead of hiding it', async () => {
    const calls: Call[] = [];
    installFetch(calls, (url) => (toHost(url, 'host-b.test') ? authFail() : authOk(SID_A)));

    const { getFullStatsPerInstance, aggregateStats } = await loadClient();
    const instances = await getFullStatsPerInstance(1);

    const a = instances.find((i) => i.url === HOST_A);
    const b = instances.find((i) => i.url === HOST_B);

    // The secondary must be VISIBLE as broken, and point at the credential rather than the endpoint.
    expect(b?.ok).toBe(false);
    expect(b?.error).toMatch(/PIHOLE_API_TOKEN/);
    // No stats/summary GET on a host we could not authenticate against (no silent unauthenticated call).
    expect(summaryCallsTo(calls, 'host-b.test')).toHaveLength(0);
    // Exactly one login attempt — the cooldown must not re-arm the limiter (#48, per instance).
    expect(authCallsTo(calls, 'host-b.test')).toHaveLength(1);

    // The primary still contributes its own numbers, so the total is the primary's, not zero.
    expect(a?.ok).toBe(true);
    expect(a?.summary?.dns_queries_today).toBe(1000);
    expect(aggregateStats(instances).dns_queries_today).toBe(1000);
  });

  it('get_dns_status aggregates stats from both instances', async () => {
    const calls: Call[] = [];
    installFetch(calls);
    vi.resetModules();
    vi.stubGlobal('console', { ...console, warn: vi.fn(), error: vi.fn(), info: vi.fn() });

    const readyPiholePod = {
      metadata: { name: 'pihole-abc12', namespace: 'pihole' },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [{ restartCount: 0 }],
      },
    };

    // Only kubernetes.js is mocked, so the real dns.ts and the real multi-instance client run.
    vi.doMock('../clients/kubernetes.js', () => ({
      listPods: vi.fn(() => Promise.resolve([readyPiholePod])),
      execInPod: vi.fn(),
      getReadyPod: vi.fn(() => Promise.resolve(readyPiholePod)),
      readPodLog: vi.fn(() => Promise.resolve('')),
      getCoreApi: (): Record<string, unknown> => ({}),
      getKubeConfig: (): { makeApiClient: () => Record<string, unknown> } => ({
        makeApiClient: (): Record<string, unknown> => ({}),
      }),
      getCustomObjectsApi: (): Record<string, unknown> => ({}),
    }));

    const { tools } = await import('../tools/index.js');
    const handler = tools.find((t) => t.name === 'get_dns_status')!.handler;
    const result = (await handler({})) as {
      stats?: { queriesToday: number; blockedToday: number };
      instances?: Array<{ url: string; ok: boolean }>;
      statsError?: string;
    };

    expect(result.statsError).toBeUndefined();
    expect(result.stats?.queriesToday).toBe(1400);
    expect(result.stats?.blockedToday).toBe(140);
    expect(result.instances).toHaveLength(2);
    expect(result.instances?.every((i) => i.ok === true)).toBe(true);
  });

  it('keeps single-host behavior when PIHOLE_URLS is unset', async () => {
    vi.stubEnv('PIHOLE_URLS', '');
    const calls: Call[] = [];
    installFetch(calls);

    // AC5: the fallback list is exactly the default primary Service.
    const { getPiholeUrls } = await loadClient();
    expect(getPiholeUrls()).toEqual(['http://pihole-web.pihole.svc.cluster.local']);

    // AC5: PIHOLE_URL is still the single-host default, and empty items / trailing slashes in
    // PIHOLE_URLS are dropped rather than becoming bogus hosts.
    vi.stubEnv('PIHOLE_URL', 'http://primary.test');
    vi.stubEnv('PIHOLE_URLS', 'http://primary.test, ,http://secondary.test/');
    expect(getPiholeUrls()).toEqual(['http://primary.test', 'http://secondary.test']);

    // Second phase, with a reachable host as the only configured instance: re-stub the env and
    // re-import so the client and the handler agree on one host.
    vi.stubEnv('PIHOLE_URLS', '');
    vi.stubEnv('PIHOLE_URL', HOST_A);
    vi.stubEnv('PIHOLE_API_TOKEN', 'the-web-password');
    vi.resetModules();
    vi.stubGlobal('console', { ...console, warn: vi.fn(), error: vi.fn(), info: vi.fn() });

    vi.doMock('../clients/kubernetes.js', () => ({
      listPods: vi.fn(() =>
        Promise.resolve([
          {
            metadata: { name: 'pihole-abc12', namespace: 'pihole' },
            status: {
              phase: 'Running',
              conditions: [{ type: 'Ready', status: 'True' }],
              containerStatuses: [{ restartCount: 0 }],
            },
          },
        ]),
      ),
      execInPod: vi.fn(),
      getReadyPod: vi.fn(),
      readPodLog: vi.fn(() => Promise.resolve('')),
      getCoreApi: (): Record<string, unknown> => ({}),
      getKubeConfig: (): { makeApiClient: () => Record<string, unknown> } => ({
        makeApiClient: (): Record<string, unknown> => ({}),
      }),
      getCustomObjectsApi: (): Record<string, unknown> => ({}),
    }));

    const { tools } = await import('../tools/index.js');
    const handler = tools.find((t) => t.name === 'get_dns_status')!.handler;
    const result = (await handler({})) as {
      stats?: Record<string, unknown>;
      instances?: unknown;
      statsError?: string;
    };

    expect(result.statsError).toBeUndefined();
    // One host, so its own totals — and no `instances` block to confuse existing consumers.
    expect(result.stats?.queriesToday).toBe(1000);
    expect(result.instances).toBeUndefined();
    // Field names under `stats` must not change: consumers relaying these verdicts are pinned here.
    expect(Object.keys(result.stats ?? {})).toEqual([
      'status', 'queriesToday', 'blockedToday', 'blockedPercentage', 'domainsBlocked',
      'uniqueDomains', 'queriesForwarded', 'queriesCached', 'uniqueClients', 'gravityUpdated',
      'topQueries', 'topBlocked',
    ]);
    // The single-host fetch really did go to PIHOLE_URL, once — the pre-#45 request pattern.
    expect(summaryCallsTo(calls, 'host-a.test')).toHaveLength(1);
    expect(authCallsTo(calls, 'host-a.test')).toHaveLength(1);
  });
});
