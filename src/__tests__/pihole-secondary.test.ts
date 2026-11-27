/**
 * Regression tests for polling every Pi-hole instance in `get_dns_status`
 * (spec `specs/pihole-secondary-stats-panels`, pi-cluster-mcp#45).
 *
 * `src/clients/pihole.ts` read a single `PIHOLE_URL`, so the second resolver on our HA DNS
 * (`app: pihole-secondary`) was never contacted: every "network-wide" figure was one of two
 * resolvers' numbers, and a secondary-only auth or health problem was invisible.
 *
 * What these tests pin down:
 *
 * 1. Stats come from EVERY instance in `PIHOLE_URLS`, in config order, each authenticated with its
 *    OWN session — the secondary's requests carry the sid the secondary's own `POST /api/auth`
 *    returned, never the primary's.
 * 2. `queriesToday` / `blockedToday` are summed across the instances that answered, with
 *    `instancesTotal` / `instancesResponded` / `instancesFailed` alongside so the reader knows how
 *    many hosts the totals cover. Every other stats key stays the PRIMARY's.
 * 3. One unreachable instance never drops the stats block, and a credential rejected for one
 *    instance fails only that instance (#44) instead of being swallowed to a null session or
 *    taking the healthy host's numbers with it.
 * 4. A primary outage still rejects, so the tool keeps today's `statsError` path rather than
 *    reporting "0 queries today" for a network that was never measured.
 * 5. `PIHOLE_URL`-only deployments keep working: one host, one login, nothing invented.
 *
 * Client-level tests (1, 2, 8, 9) call the exported client functions after `vi.resetModules()`;
 * handler-level tests go through `tools.find(t => t.name === 'get_dns_status')` with
 * `../clients/kubernetes.js` mocked (the `summary.test.ts` pattern). No network, no real Pi-hole,
 * no secrets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PRIMARY = 'http://pihole-primary.test';
const SECONDARY = 'http://pihole-secondary.test';
const THIRD = 'http://pihole-third.test';

/**
 * Fixtures, deliberately different per instance so "summed" cannot be confused with "first one
 * wins" or "last one wins", and so the primary-sourced keys cannot be mistaken for anyone else's:
 *
 * |                            | primary | secondary | third |
 * |----------------------------|---------|-----------|-------|
 * | auth sid                   | `sid-primary-aaa` | `sid-secondary-bbb` | `sid-third-ccc` |
 * | `queries.total`            | 100     | 40        | 20    |
 * | `queries.blocked`          | 10      | 5         | 2     |
 * | gravity `relative.days`    | 7       | 3         | 1     |
 */
interface HostFixture {
  sid: string;
  total: number;
  blocked: number;
  gravityDays: number;
}

const HOSTS: Record<string, HostFixture> = {
  [PRIMARY]: { sid: 'sid-primary-aaa', total: 100, blocked: 10, gravityDays: 7 },
  [SECONDARY]: { sid: 'sid-secondary-bbb', total: 40, blocked: 5, gravityDays: 3 },
  [THIRD]: { sid: 'sid-third-ccc', total: 20, blocked: 2, gravityDays: 1 },
};

interface ConfigureOptions extends StubOptions {
  /** Drop everything recorded so far, so the next phase's counts stand alone. */
  freshLog?: boolean;
}

interface StubOptions {
  /** Force a non-2xx status for a host's `POST …/api/auth`. */
  authStatus?: Record<string, number>;
  /** Hosts that must not be answered at all: any request to them throws. */
  unconfigured?: string[];
}

/**
 * The record a stub keeps of the requests it accepted.
 *
 * `authCalls` / `summaryCalls` / `requestedUrls` are GETTERS over the live log, so binding one of
 * them before an `await` still reports the requests recorded after it — which is what lets the
 * pinned counts read naturally (`expect(authCalls).toHaveLength(3)`) no matter where the helper is
 * bound.
 */
interface PiholeApiLog {
  /**
   * `POST …/api/auth` request URLs the stub accepted.
   *
   * A FUNCTION for the same reason as `authCallsTo`: tests bind it before the fan-out, so a
   * snapshot array would still be empty when the assertion runs.
   */
  authCalls: () => string[];
  /** `GET …/api/stats/summary` request URLs the stub accepted; a function, as above. */
  summaryCalls: () => string[];
  /**
   * `authCalls` filtered by base URL.
   *
   * A FUNCTION, deliberately: the tests bind it as `const authCallsTo = api.authCallsTo` before
   * the fan-out, so a snapshot array would be empty at assertion time. It reads the live log.
   */
  authCallsTo: (base: string) => string[];
  summaryCallsTo: (base: string) => string[];
  /** Every request URL the stub accepted — anything outside it never happened. */
  requestedUrls: () => string[];
  /** The `sid` header that host's own `stats/summary` request carried. */
  sidUsedBy: (base: string) => string | null;
}

/**
 * A stub whose config can change mid-test, with one continuous request log.
 *
 * `PIHOLE_URLS` precedence (test 9) is a single test body that reconfigures the fleet part-way
 * through, and the first phase's counts must still be assertable afterwards. So a stub answers
 * according to whatever `configure()` last installed while every phase appends to the same log.
 */
interface PiholeApiStub extends PiholeApiLog {
  configure(hosts: string[], options?: ConfigureOptions): void;
}

/**
 * Fetch stub for the Pi-hole API surface these tests touch, recording everything it accepts. The
 * stub rules are what make the sid and sourcing checks behavioural rather than mere literals:
 *
 * - `POST <url>/api/auth` answers with that URL's OWN sid, or the status the test asked for.
 * - `GET <url>/api/…` resolves only when the request's `sid` header equals the sid that host's own
 *   auth response returned, and answers 401 otherwise — so a client that reused the primary's
 *   session for the secondary fails here rather than passing by accident.
 * - A request whose URL is not `<configured url>/api/…` throws, so an implementation cannot invent
 *   a host and have nobody notice: `requestedUrls` sees everything that survived.
 *
 * Every accessor is a function over the live record, so a helper bound before an `await` still
 * reports what happened after it.
 */
function stubPiholeApi(hosts: string[], options: StubOptions = {}): PiholeApiStub {
  interface Recorded {
    url: string;
    method: string;
    sid: string | null;
    host: string;
  }
  const calls: Recorded[] = [];
  let configured = new Set(hosts.filter((host) => !(options.unconfigured ?? []).includes(host)));
  let authStatus = options.authStatus ?? {};
  /** The config in force for the request being answered, captured per request. */
  let answering = new Map<string, HostFixture>();

  function configure(nextHosts: string[], nextOptions: ConfigureOptions = {}): void {
    configured = new Set(nextHosts.filter((host) => !(nextOptions.unconfigured ?? []).includes(host)));
    authStatus = nextOptions.authStatus ?? {};
    answering = new Map(nextHosts.map((host) => [host, HOSTS[host]]));
    if (nextOptions.freshLog) calls.length = 0;
  }
  configure(hosts, options);

  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const statsPayload = (host: HostFixture): Response =>
    json({
      queries: {
        total: host.total,
        blocked: host.blocked,
        percent_blocked: host.total ? Math.round((host.blocked / host.total) * 100) : 0,
        unique_domains: 5,
        forwarded: host.total - host.blocked,
        cached: 20,
        frequency: 1,
        types: { A: 60, AAAA: 40 },
        status: {},
        replies: {},
      },
      clients: { active: 3, total: 7 },
      gravity: {
        domains_being_blocked: 1000,
        last_update: Math.floor(Date.now() / 1000) - host.gravityDays * 86400,
      },
      took: 0.001,
    });

  // Not `async`: every branch resolves a `Response` it already has, so awaiting would be a no-op
  // the linter (rightly) flags. The client still receives a promise, which is all it ever saw.
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const host = [...answering.keys()].find((candidate) => url.startsWith(candidate));

    if (!host || !configured.has(host)) {
      return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
    }

    calls.push({ url, method, sid: headers.sid ?? null, host });
    const fixture = answering.get(host)!;

    if (url === `${host}/api/auth` && method === 'POST') {
      const forced = authStatus[host];
      if (forced) {
        return Promise.resolve(
          json({ error: { key: forced === 401 ? 'unauthorized' : 'internal_error' } }, forced),
        );
      }
      return Promise.resolve(
        json({ session: { valid: true, totp: false, sid: fixture.sid, validity: 300 } }),
      );
    }

    if (headers.sid !== fixture.sid) {
      return Promise.resolve(json({ error: { key: 'unauthorized' } }, 401));
    }

    if (url.startsWith(`${host}/api/stats/top_domains`)) {
      return Promise.resolve(json({ domains: [], total_count: 0, took: 0.001 }));
    }
    if (url.startsWith(`${host}/api/stats/summary`)) {
      return Promise.resolve(statsPayload(fixture));
    }
    return Promise.resolve(
      json({
        messages: [],
        domains: [],
        queries: [],
        cursor: null,
        recordsTotal: 0,
        recordsFiltered: 0,
        took: 0.001,
      }),
    );
  }));

  const urlsMatching = (fragment: string): string[] =>
    calls.filter((call) => call.url.includes(fragment)).map((call) => call.url);

  return {
    authCalls: () => urlsMatching('/api/auth'),
    summaryCalls: () => urlsMatching('/api/stats/summary'),
    authCallsTo: (base: string) => urlsMatching('/api/auth').filter((url) => url.startsWith(base)),
    summaryCallsTo: (base: string) =>
      urlsMatching('/api/stats/summary').filter((url) => url.startsWith(base)),
    requestedUrls: () => calls.map((call) => call.url),
    sidUsedBy: (base: string): string | null => {
      const request = calls.find(
        (call) => call.url.startsWith(base) && call.url.includes('/api/stats/summary'),
      );
      return request ? request.sid : null;
    },
    configure,
  };
}

/**
 * The `stats` block `get_dns_status` returns, with the per-instance counters typed as §3 defines
 * them. Index signatures keep the pinned literals (`stats.instances[0].error`, …) type-checking
 * without `any`, while the named keys still catch a typo or a rename.
 */
interface InstanceCounter {
  url: string;
  ok: boolean;
  queriesToday: number;
  blockedToday: number;
  error?: string;
  [key: string]: unknown;
}

interface StatsBlock {
  queriesToday: number;
  blockedToday: number;
  gravityUpdated: string;
  instancesTotal: number;
  instancesResponded: number;
  instancesFailed: string[];
  instances: InstanceCounter[];
  [key: string]: unknown;
}

interface DnsStatusResult {
  stats?: StatsBlock;
  statsError?: string;
  [key: string]: unknown;
}

/**
 * `get_dns_status` exactly as the MCP server exposes it, with the cluster mocked away.
 *
 * `tools/index.ts` pulls in the whole registry, and some clients build SDK clients at import time,
 * so `../clients/kubernetes.js` is replaced wholesale. Nothing in the DNS path reads a k8s object
 * API, so the stubs below only have to exist, not to answer.
 */
const listPods = vi.fn();
vi.mock('../clients/kubernetes.js', () => ({
  listPods: (): unknown => listPods(),
  listNodes: vi.fn(),
  listEvents: vi.fn(),
  listDeployments: vi.fn(),
  patchDeployment: vi.fn(),
  execInPod: vi.fn(),
  getReadyPod: vi.fn(),
  getReadyPodOnNode: vi.fn(),
  readPodLog: vi.fn(),
  initKubeClient: vi.fn(),
  getKubeConfig: vi.fn(),
  getCoreApi: vi.fn(),
  getAppsApi: vi.fn(),
  getCustomObjectsApi: vi.fn(),
  getMetricsClient: vi.fn(),
  getCustomResource: vi.fn(),
}));

interface PiholeClient {
  getAllSummaries: (
    excludeUrls?: string[],
  ) => Promise<Array<{ url: string; ok: boolean; error?: string; summary?: unknown }>>;
  getStatsInstances: (topCount?: number) => Promise<unknown>;
}

async function loadClient(): Promise<PiholeClient> {
  vi.resetModules();
  return import('../clients/pihole.js') as Promise<PiholeClient>;
}

/** A Ready Pi-hole pod plus a Ready Unbound pod: enough to open the `includeStats` gate. */
function readyPod(name: string): unknown {
  return {
    metadata: { name, ownerReferences: [] },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ restartCount: 0 }],
    },
  };
}

async function loadDnsStatus(): Promise<(params: Record<string, unknown>) => Promise<DnsStatusResult>> {
  vi.resetModules();
  const { tools } = await import('../tools/index.js');
  const dnsStatus = tools.find((t) => t.name === 'get_dns_status');
  if (!dnsStatus) throw new Error('get_dns_status is not registered');
  return dnsStatus.handler as (params: Record<string, unknown>) => Promise<DnsStatusResult>;
}

function statsOf(result: DnsStatusResult): StatsBlock {
  if (!result.stats) {
    throw new Error(
      `get_dns_status returned no stats block (statsError=${String(result.statsError)})`,
    );
  }
  return result.stats;
}

beforeEach(() => {
  vi.resetModules();
  listPods.mockReset();
  // Two instances: the one that was already polled, and the one that was invisible.
  vi.stubEnv('PIHOLE_URL', PRIMARY);
  vi.stubEnv('PIHOLE_URLS', `${PRIMARY},${SECONDARY}`);
  vi.stubEnv('PIHOLE_API_TOKEN', 'test-password');
  listPods.mockResolvedValue([readyPod('pihole-pod-a'), readyPod('unbound-pod-a')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('get_dns_status polls every Pi-hole instance (#45)', () => {
  // ------------------------------------------------------------------- fan-out
  // Two Pi-holes are configured and every figure below is per-host. Polling `PIHOLE_URL` alone
  // reported 100 queries where the network did 140, so the dashboard numbers were silently wrong.

  it('polls every configured Pi-hole instance', async () => {
    vi.stubEnv('PIHOLE_URLS', [PRIMARY, SECONDARY, THIRD].join(','));
    const api = stubPiholeApi([PRIMARY, SECONDARY, THIRD]);

    const { getAllSummaries } = await loadClient();
    const summaries = await getAllSummaries();

    // Bound after the fan-out: `authCalls` is a plain array of everything the stub recorded, so
    // reading it here is what makes the pinned counts below describe the run that just happened.
    const authCalls = api.authCalls();
    const authCallsTo = api.authCallsTo;
    const summaryCallsTo = api.summaryCallsTo;

    expect(summaries).toHaveLength(3);
    expect(summaries.map((s) => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-secondary.test', 'http://pihole-third.test']);
    expect(summaries.every((s) => s.ok)).toBe(true);
    expect(authCalls).toHaveLength(3);
    expect(authCallsTo('http://pihole-primary.test')).toHaveLength(1);
    expect(authCallsTo('http://pihole-secondary.test')).toHaveLength(1);
    expect(authCallsTo('http://pihole-third.test')).toHaveLength(1);
    expect(summaryCallsTo('http://pihole-primary.test')).toHaveLength(1);
    expect(summaryCallsTo('http://pihole-secondary.test')).toHaveLength(1);
    expect(summaryCallsTo('http://pihole-third.test')).toHaveLength(1);
  });

  it('logs in to the secondary separately from the primary', async () => {
    vi.stubEnv('PIHOLE_URLS', [PRIMARY, SECONDARY, THIRD].join(','));
    const api = stubPiholeApi([PRIMARY, SECONDARY, THIRD]);

    const { getAllSummaries } = await loadClient();
    await getAllSummaries();

    // Read the sids off the recorded requests rather than off the fixtures, so a client that
    // reused one session across hosts lands on the wrong value instead of being asserted green.
    const primarySid = api.sidUsedBy(PRIMARY);
    const secondarySid = api.sidUsedBy(SECONDARY);
    const thirdSid = api.sidUsedBy(THIRD);

    expect(primarySid).toBe('sid-primary-aaa');
    expect(secondarySid).toBe('sid-secondary-bbb');
    expect(thirdSid).toBe('sid-third-ccc');
    expect(new Set([primarySid, secondarySid, thirdSid]).size).toBe(3);
  });

  it('sums query totals across instances and reports per-instance health', async () => {
    stubPiholeApi([PRIMARY, SECONDARY]);

    const handler = await loadDnsStatus();
    const stats = statsOf(await handler({}));

    // primary 100 + secondary 40, and primary 10 + secondary 5.
    expect(stats.queriesToday).toBe(140);
    expect(stats.blockedToday).toBe(15);
    expect(stats.instances).toHaveLength(2);
    expect(stats.instances[0].url).toBe(PRIMARY);
    expect(stats.instances[0].queriesToday).toBe(100);
    expect(stats.instances[0].ok).toBe(true);
    expect(stats.instances[0].error).toBeUndefined();
    expect(stats.instances[1].url).toBe(SECONDARY);
    expect(stats.instances[1].queriesToday).toBe(40);
    expect(stats.instances[1].ok).toBe(true);
    expect(stats.instancesResponded).toBe(2);
    expect(stats.instancesTotal).toBe(2);
    expect(stats.instancesFailed).toHaveLength(0);
    // The non-summed keys stay the primary's: '3d 0h ago' is the secondary's gravity age, so
    // seeing it here would mean some other host answered for a key it must not source.
    expect(stats.gravityUpdated).not.toBe('3d 0h ago');
  });

  it('reports a failed instance instead of dropping all stats', async () => {
    // The secondary box is up but its API refuses requests; the primary is fine.
    stubPiholeApi([PRIMARY, SECONDARY], { authStatus: { [SECONDARY]: 500 } });

    const handler = await loadDnsStatus();
    const stats = statsOf(await handler({}));

    expect(stats.instancesResponded).toBe(1);
    expect(stats.instancesTotal).toBe(2);
    expect(stats.instancesFailed).toEqual(['http://pihole-secondary.test']);
    expect(stats.instances[0].ok).toBe(true);
    expect(stats.instances[0].queriesToday).toBe(100);
    expect(stats.instances[1].ok).toBe(false);
    // A dead host reads as "no data", never as traffic and never as a healthy zero.
    expect(stats.instances[1].queriesToday).toBe(0);
    expect(stats.instances[1].error).toContain('http://pihole-secondary.test');
    // The healthy instance's numbers, and the primary-sourced keys, survive the other host's outage.
    expect(stats.queriesToday).toBe(100);
    expect(stats.gravityUpdated).toBe('7d 0h ago');
  });

  it('fails loudly for the instance whose credential is rejected, not silently', async () => {
    // #44 pointed at an HA pair: when one node rejects the password the old code could degrade to
    // an unauthenticated request, or reuse the other host's session, so the node reported 0
    // queries and still looked healthy. A rejected credential has to surface as THAT instance's
    // error, naming the credential, without taking the working host's numbers with it.
    stubPiholeApi([PRIMARY, SECONDARY], { authStatus: { [SECONDARY]: 401 } });

    const handler = await loadDnsStatus();
    const stats = statsOf(await handler({}));

    expect(stats.instances[0].ok).toBe(true);
    expect(stats.instances[1].ok).toBe(false);
    expect(stats.instances[1].error).toMatch(/auth failed/i);
    expect(stats.instances[1].error).toContain('PIHOLE_API_TOKEN');
    expect(stats.queriesToday).toBe(100);
  });

  it('logs in at most once per host under concurrent fan-out', async () => {
    // One get_dns_status run fans out several parallel requests per host (summary, top-domains
    // x2, query types, messages). Without per-host single-flight each of them fires its own
    // POST /api/auth and re-arms FTL's limiter (#48); with a global one, a single session gets
    // reused for the other host. And the primary must be fetched once per run — not once by
    // getFullStats and again by the fan-out — so 3 summary requests would fail this too.
    const api = stubPiholeApi([PRIMARY, SECONDARY]);

    const handler = await loadDnsStatus();
    const stats = statsOf(await handler({}));

    expect(stats.instancesResponded).toBe(2);
    const authCalls = api.authCalls();
    const summaryCalls = api.summaryCalls();
    expect(authCalls).toHaveLength(2);
    expect(summaryCalls).toHaveLength(2);
  });

  it('keeps single-instance behaviour when PIHOLE_URLS is unset', async () => {
    // `delete` rather than stubbing undefined: vitest stringifies an `undefined` stub value.
    delete process.env.PIHOLE_URLS;
    // Only the primary is configured; a request to any other host throws, so a host invented out
    // of nothing would fail the run rather than go unnoticed.
    const api = stubPiholeApi([PRIMARY], { unconfigured: [SECONDARY] });

    const handler = await loadDnsStatus();
    const stats = statsOf(await handler({}));

    const authCalls = api.authCalls();
    const requestedUrls = api.requestedUrls();
    expect(authCalls).toHaveLength(1);
    expect(stats.instancesTotal).toBe(1);
    expect(stats.instancesResponded).toBe(1);
    expect(stats.queriesToday).toBe(100);
    expect(requestedUrls.some((u) => u.includes('pihole-secondary'))).toBe(false);
  });

  it('fails over to statsError when the primary Pi-hole is unreachable', async () => {
    // A primary outage must not be disguised as a measured zero: rejecting keeps the tool on
    // today's statsError path instead of reporting "0 queries today" for a network it did not see.
    vi.stubEnv('PIHOLE_URLS', [PRIMARY, SECONDARY].join(','));
    stubPiholeApi([PRIMARY, SECONDARY], { authStatus: { [PRIMARY]: 500 } });

    const { getStatsInstances } = await loadClient();

    await expect(getStatsInstances()).rejects.toThrow(/http:\/\/pihole-primary\.test/);
  });

  it('prefers PIHOLE_URLS over PIHOLE_URL and ignores empty entries', async () => {
    // (a) PIHOLE_URLS wins even while PIHOLE_URL is set, its entries are trimmed, and empty ones
    // are dropped — so the blank entry and the trailing comma create no phantom host, and
    // PIHOLE_URL's host is not contacted once the list exists.
    vi.stubEnv('PIHOLE_URL', SECONDARY);
    vi.stubEnv('PIHOLE_URLS', ` ${PRIMARY} , , ${THIRD} , `);
    const api = stubPiholeApi([PRIMARY, THIRD], { unconfigured: [SECONDARY] });
    const authCallsTo = api.authCallsTo;

    const { getAllSummaries } = await loadClient();
    const summaries = await getAllSummaries();
    const authCalls = api.authCalls();

    expect(summaries.map((s) => s.url)).toEqual(['http://pihole-primary.test', 'http://pihole-third.test']);
    expect(authCalls).toHaveLength(2);
    expect(authCallsTo('http://pihole-secondary.test')).toHaveLength(0);

    // (b) A PIHOLE_URLS with no usable entry falls back to PIHOLE_URL rather than yielding [''].
    // The stub starts a fresh log here, so the single login below belongs to this phase alone.
    vi.stubEnv('PIHOLE_URLS', ' , ');
    vi.stubEnv('PIHOLE_URL', PRIMARY);
    api.configure([PRIMARY], { freshLog: true });

    const fallbackClient = await loadClient();
    const fallbackSummaries = await fallbackClient.getAllSummaries();

    expect(fallbackSummaries.map((s) => s.url)).toEqual(['http://pihole-primary.test']);
    expect(authCallsTo('http://pihole-primary.test')).toHaveLength(1);
  });
});
