// Summary-first responses: tools do the counting, grouping and filtering so the
// caller (often a small local model) relays a verdict instead of computing one.
// Every list tool that adopts this takes `detail`: "summary" (default) returns
// totals plus only the items needing attention; "full" returns every item.

export type Detail = 'summary' | 'full';

export const DETAIL_PARAM = {
  detail: {
    type: 'string',
    enum: ['summary', 'full'],
    default: 'summary',
    description:
      '"summary" (default): pre-computed counts plus only the items needing attention — healthy items are counted, not listed. "full": every item.',
  },
};

export function getDetail(params: Record<string, unknown>): Detail {
  return params.detail === 'full' ? 'full' : 'summary';
}

export const OMITTED_NOTE = 'Healthy items are counted, not listed. Call again with detail:"full" to list every item.';

export interface Capped<T> {
  items: T[];
  truncated?: { shown: number; total: number; hint: string };
}

/** Cap a list so no single response blows a small model's context. */
export function capList<T>(items: T[], max: number, hint = 'Call again with detail:"full" to see all.'): Capped<T> {
  if (items.length <= max) return { items };
  return { items: items.slice(0, max), truncated: { shown: max, total: items.length, hint } };
}

const UNIT: Record<string, number> = {
  '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
};

/** Parse a Kubernetes quantity ("500Gi", "1Ti", "100Mi") to bytes; NaN if unparseable. */
export function parseQuantity(q: string | undefined): number {
  const m = /^([0-9.]+)([A-Za-z]*)$/.exec(q ?? '');
  if (!m || !(m[2] in UNIT)) return NaN;
  return parseFloat(m[1]) * UNIT[m[2]];
}

export interface QueueItemLike {
  id: number;
  title: string;
  status?: string;
  trackedStatus?: string;
  trackedState?: string;
  messages?: string[];
}

export interface QueueGroup {
  title: string;
  count: number;
  trackedState?: string;
  trackedStatus?: string;
  reason?: string;
  queueIds: number[];
}

/**
 * Collapse a Sonarr/Radarr queue into groups of identical (title, state, reason),
 * largest first. Duplicate grabs of the same release show up as one row with a
 * count instead of N near-identical items for the caller to tally.
 */
export function summarizeQueue(items: QueueItemLike[], maxGroups = 25): {
  summary: { total: number; needsAttention: number; byState: Record<string, number> };
  groups: QueueGroup[];
  truncated?: Capped<QueueGroup>['truncated'];
} {
  const byState: Record<string, number> = {};
  const groups = new Map<string, QueueGroup>();
  let needsAttention = 0;

  for (const item of items) {
    const state = item.trackedState ?? item.status ?? 'unknown';
    byState[state] = (byState[state] ?? 0) + 1;
    if (item.trackedStatus && item.trackedStatus !== 'ok') needsAttention++;

    const reason = item.messages?.[0];
    const key = JSON.stringify([item.title, state, item.trackedStatus, reason]);
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.queueIds.push(item.id);
    } else {
      groups.set(key, {
        title: item.title, count: 1, trackedState: state,
        trackedStatus: item.trackedStatus, reason, queueIds: [item.id],
      });
    }
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  const capped = capList(sorted, maxGroups);
  return {
    summary: { total: items.length, needsAttention, byState },
    groups: capped.items,
    ...(capped.truncated ? { truncated: capped.truncated } : {}),
  };
}
