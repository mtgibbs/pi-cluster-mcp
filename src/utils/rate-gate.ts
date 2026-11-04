import { rateLimitedError, type ToolError } from './errors.js';

// Gate for write tools whose input is already validated but whose risk is volume: an agent in a
// loop re-searching an indexer, re-importing a URL, or toggling the SABnzbd queue. Two limits:
//   perTargetCooldownMs  the same target (episode, movie, URL, nzo id) can't repeat inside it
//   maxPerHour           total calls to the tool in any rolling hour
// In-memory and per-process: a restart resets it, which is fine for a volume guard.
export interface RateGateOptions {
  perTargetCooldownMs: number;
  maxPerHour: number;
}

const HOUR_MS = 60 * 60 * 1000;

export class RateGate {
  private readonly lastByTarget = new Map<string, number>();
  private calls: number[] = [];

  constructor(
    private readonly tool: string,
    private readonly opts: RateGateOptions
  ) {}

  // Records the call and returns null if allowed; returns the error to send back if not.
  check(target: string, now = Date.now()): ToolError | null {
    this.calls = this.calls.filter((t) => now - t < HOUR_MS);
    if (this.calls.length >= this.opts.maxPerHour) {
      return rateLimitedError(`${this.tool} is limited to ${this.opts.maxPerHour} calls per hour`);
    }
    const last = this.lastByTarget.get(target);
    if (last !== undefined && now - last < this.opts.perTargetCooldownMs) {
      const waitS = Math.ceil((this.opts.perTargetCooldownMs - (now - last)) / 1000);
      return rateLimitedError(`${this.tool} already ran for ${target}; try again in ${waitS}s`);
    }
    this.calls.push(now);
    this.lastByTarget.set(target, now);
    return null;
  }

  reset(): void {
    this.lastByTarget.clear();
    this.calls = [];
  }
}

const MIN = 60 * 1000;

// One gate per tool. Searches spend indexer quota, so they get the longest cooldown.
export const gates = {
  search_sonarr_episode: new RateGate('search_sonarr_episode', { perTargetCooldownMs: 10 * MIN, maxPerHour: 20 }),
  search_radarr_movie: new RateGate('search_radarr_movie', { perTargetCooldownMs: 10 * MIN, maxPerHour: 20 }),
  search_subtitles: new RateGate('search_subtitles', { perTargetCooldownMs: 10 * MIN, maxPerHour: 20 }),
  reject_and_search: new RateGate('reject_and_search', { perTargetCooldownMs: 10 * MIN, maxPerHour: 20 }),
  retry_sabnzbd_download: new RateGate('retry_sabnzbd_download', { perTargetCooldownMs: 2 * MIN, maxPerHour: 30 }),
  pause_resume_sabnzbd: new RateGate('pause_resume_sabnzbd', { perTargetCooldownMs: 10 * 1000, maxPerHour: 60 }),
  import_mealie_recipe_url: new RateGate('import_mealie_recipe_url', { perTargetCooldownMs: 10 * MIN, maxPerHour: 20 }),
  parse_mealie_recipe_ingredients: new RateGate('parse_mealie_recipe_ingredients', { perTargetCooldownMs: MIN, maxPerHour: 30 }),
} as const;
