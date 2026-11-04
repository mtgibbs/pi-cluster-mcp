import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateGate, gates } from '../utils/rate-gate.js';

type ClientMock = (...args: unknown[]) => Promise<never>;

// Every client call fails fast: these tests only care whether the gate lets a call reach the client.
const fail = (): ClientMock => vi.fn().mockRejectedValue(new Error('client not under test'));
const clients = vi.hoisted(() => ({ calls: 0 }));
const counted = (): ClientMock =>
  vi.fn((): Promise<never> => {
    clients.calls += 1;
    return Promise.reject(new Error('client not under test'));
  });

vi.mock('../clients/sonarr.js', () => ({
  searchEpisode: counted(), getQueue: counted(), deleteQueueItem: counted(),
  getHistory: fail(), getQualityProfiles: fail(),
}));
vi.mock('../clients/radarr.js', () => ({
  searchMovie: counted(), getQueue: counted(), deleteQueueItem: counted(),
  getHistory: fail(), getQualityProfiles: fail(),
}));
vi.mock('../clients/bazarr.js', () => ({
  searchSubtitles: counted(), getSubtitleHistory: fail(), getSubtitleStatus: fail(),
}));
vi.mock('../clients/sabnzbd.js', () => ({
  retryDownload: counted(), pauseItem: counted(), resumeItem: counted(),
  pauseQueue: counted(), resumeQueue: counted(),
  check: fail(), getHistory: fail(), getQueue: fail(),
}));
vi.mock('../clients/mealie.js', () => ({
  importRecipeFromUrl: counted(), getRecipeRaw: counted(), parseIngredients: counted(),
  updateRecipeRaw: counted(), recipeUrl: (s: string): string => `https://mealie/${s}`,
  getAbout: fail(), getStatistics: fail(), searchRecipes: fail(), getRecipe: fail(),
  searchFoods: fail(), searchUnits: fail(), createFood: fail(), createUnit: fail(),
}));

const { tools } = await import('../tools/index.js');
const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
  try {
    return await tools.find((t) => t.name === name)!.handler(args);
  } catch (e) {
    return { thrown: String(e) };
  }
};

const NZO = 'SABnzbd_nzo_abc123';
const CASES: Array<[keyof typeof gates, Record<string, unknown>, Record<string, unknown>]> = [
  ['search_sonarr_episode', { episodeId: 7 }, { episodeId: 8 }],
  ['search_radarr_movie', { movieId: 7 }, { movieId: 8 }],
  ['search_subtitles', { type: 'movie', id: 7 }, { type: 'episode', id: 7 }],
  ['reject_and_search', { service: 'sonarr', queueId: 7 }, { service: 'radarr', queueId: 7 }],
  ['retry_sabnzbd_download', { nzoId: NZO }, { nzoId: `${NZO}x` }],
  ['pause_resume_sabnzbd', { action: 'pause', nzoId: NZO }, { action: 'pause' }],
  ['import_mealie_recipe_url', { url: 'https://example.com/r/1' }, { url: 'https://example.com/r/2' }],
  ['parse_mealie_recipe_ingredients', { slug: 'soup' }, { slug: 'stew' }],
];

describe('RateGate', () => {
  it('refuses the same target inside its cooldown, then allows it after', () => {
    const g = new RateGate('t', { perTargetCooldownMs: 1000, maxPerHour: 100 });
    expect(g.check('a', 0)).toBeNull();
    expect(g.check('a', 999)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(g.check('b', 999)).toBeNull();
    expect(g.check('a', 1000)).toBeNull();
  });

  it('caps total calls per rolling hour', () => {
    const g = new RateGate('t', { perTargetCooldownMs: 0, maxPerHour: 2 });
    expect(g.check('a', 0)).toBeNull();
    expect(g.check('b', 1)).toBeNull();
    expect(g.check('c', 2)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(g.check('c', 60 * 60 * 1000 + 1)).toBeNull();
  });

  it('does not count a refused call against the hourly cap', () => {
    const g = new RateGate('t', { perTargetCooldownMs: 1000, maxPerHour: 2 });
    g.check('a', 0);
    g.check('a', 1); // refused: cooldown
    expect(g.check('b', 2)).toBeNull();
  });
});

describe.each(CASES)('%s is gated', (name, args, otherTarget) => {
  beforeEach(() => {
    Object.values(gates).forEach((g) => g.reset());
    clients.calls = 0;
  });

  it('refuses an immediate repeat on the same target before reaching the client', async () => {
    await call(name, args);
    const reached = clients.calls;
    expect(reached).toBeGreaterThan(0);
    expect(await call(name, args)).toMatchObject({ error: true, code: 'RATE_LIMITED' });
    expect(clients.calls).toBe(reached);
  });

  it('still allows a different target', async () => {
    await call(name, args);
    expect(await call(name, otherTarget)).not.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('SABnzbd ids', () => {
  beforeEach(() => Object.values(gates).forEach((g) => g.reset()));

  it('rejects ids that are not SABnzbd nzo ids', async () => {
    for (const nzoId of ['', 'abc', 'SABnzbd_nzo_a&mode=shutdown', 42]) {
      expect(await call('retry_sabnzbd_download', { nzoId })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await call('pause_resume_sabnzbd', { action: 'pause', nzoId })).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });
});
