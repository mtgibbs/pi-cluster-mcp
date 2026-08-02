import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression tests for pi-cluster-mcp#44.
//
// Two distinct defects produced the same misleading symptom — `get_dns_status` reporting
// `statsError: 401` — and between them they hid a stale Pi-hole credential for months:
//
//   1. `stats/summary` was fetched with `requiresAuth = false`. That was true in Pi-hole v5;
//      v6 requires a session, so the call 401'd no matter how valid the credential was.
//   2. `authenticate()` swallowed auth failures and returned null, silently downgrading the
//      caller to an unauthenticated request — so a WRONG PASSWORD also surfaced as a 401 from
//      the endpoint rather than as an auth error.
//
// Both are easy to reintroduce and invisible without a live Pi-hole, hence these tests.

const PIHOLE_URL = 'http://pihole.test';
const SID = 'test-session-id';

function authOk() {
  return new Response(
    JSON.stringify({ session: { valid: true, totp: false, sid: SID, validity: 300 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function statsOk() {
  return new Response(
    JSON.stringify({
      queries: {
        total: 100, blocked: 10, percent_blocked: 10, unique_domains: 5,
        forwarded: 80, cached: 20, frequency: 1,
        types: { A: 60, AAAA: 40 }, status: {}, replies: {},
      },
      clients: { active: 3, total: 7 },
      gravity: { domains_being_blocked: 1000, last_update: Math.floor(Date.now() / 1000) },
      took: 0.001,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Import the client fresh — it reads env into module-level consts at import time. */
async function loadClient() {
  vi.resetModules();
  return import('../clients/pihole.js');
}

describe('pihole client — authentication', () => {
  beforeEach(() => {
    vi.stubEnv('PIHOLE_URL', PIHOLE_URL);
    vi.stubEnv('PIHOLE_API_TOKEN', 'the-web-password');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends a session id on stats/summary (v6 requires auth — see #44)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(url.includes('/api/auth') ? authOk() : statsOk());
    }));

    const { getSummary } = await loadClient();
    await getSummary();

    const statsCall = seen.find((c) => c.url.includes('stats/summary'));
    expect(statsCall, 'stats/summary should have been requested').toBeDefined();
    // The actual regression: this header was absent, so Pi-hole v6 answered 401.
    expect(statsCall?.headers.sid).toBe(SID);
  });

  it('throws a diagnosable error when the password is wrong, rather than silently degrading', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/auth')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { key: 'unauthorized' } }), { status: 401 }),
        );
      }
      // If auth were swallowed, the client would land here unauthenticated and get a 401
      // that looks like a broken stats endpoint. Failing loudly is the point.
      return Promise.resolve(
        new Response(JSON.stringify({ error: { key: 'unauthorized' } }), { status: 401 }),
      );
    }));

    const { getSummary } = await loadClient();

    await expect(getSummary()).rejects.toThrow(/auth failed/i);
    // The message must point at the credential, not at the endpoint.
    await expect(getSummary()).rejects.toThrow(/PIHOLE_API_TOKEN/);
  });

  it('reuses a cached session instead of re-authenticating on every call', async () => {
    const fetchMock = vi.fn((input: string | URL) =>
      Promise.resolve(String(input).includes('/api/auth') ? authOk() : statsOk()));
    vi.stubGlobal('fetch', fetchMock);

    const { getSummary } = await loadClient();
    await getSummary();
    await getSummary();

    const authCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/auth'));
    expect(authCalls).toHaveLength(1);
  });

  it('still allows unauthenticated calls when no password is configured', async () => {
    vi.stubEnv('PIHOLE_API_TOKEN', '');
    vi.stubEnv('PIHOLE_PASSWORD', '');

    const seen: Array<string> = [];
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      seen.push(String(input));
      return Promise.resolve(statsOk());
    }));

    const { getSummary } = await loadClient();
    await getSummary();

    // No password configured is a legitimate deployment, not an error: no auth attempt.
    expect(seen.some((u) => u.includes('/api/auth'))).toBe(false);
    expect(seen.some((u) => u.includes('stats/summary'))).toBe(true);
  });
});
