import { describe, it, expect, vi, beforeEach } from 'vitest';
import { summarizeQueue, parseQuantity, capList, getDetail } from '../utils/summary.js';

const listCluster = vi.fn();
const listPvcs = vi.fn();
vi.mock('../clients/kubernetes.js', () => ({
  getCustomObjectsApi: (): unknown => ({ listClusterCustomObject: listCluster }),
  getCoreApi: (): unknown => ({ listPersistentVolumeClaimForAllNamespaces: listPvcs }),
}));

const sonarrQueue = vi.fn();
vi.mock('../clients/sonarr.js', () => ({ getQueue: (): unknown => sonarrQueue() as unknown }));

interface Named { name: string }
interface FluxSummary {
  summary: { kustomizations: { total: number; ready: number; notReady: number } };
  allReady?: boolean;
  notReady?: { kustomizations: Named[] };
  kustomizations?: Named[];
}
interface PvcSummary { largest: Named[]; allBound: boolean; notBound: Named[]; pvcs?: unknown[] }
interface QueueResult { summary: { byState: Record<string, number> }; groups: Array<{ count: number }>; items?: unknown[] }

const { tools } = await import('../tools/index.js');
const tool = (name: string): (p: Record<string, unknown>) => Promise<unknown> => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.handler;
};

// Shape of the Sonarr queue seen live on 2026-09-27: the same ReBoot season
// pack queued 13 times, plus 13 distinct Bleach episodes and one odd one out.
// A small model tallied this as 21 pending / 5 blocked (actual 13 / 14).
function liveShapedQueue(): Array<{ id: number; title: string; trackedStatus: string; trackedState: string; messages: string[] }> {
  const items = [];
  let id = 1;
  for (let i = 0; i < 13; i++) {
    items.push({ id: id++, title: 'ReBoot.S01.1080p.WEB-DL.h264', trackedStatus: 'warning', trackedState: 'importBlocked',
      messages: ['Single episode file contains all episodes in seasons. Review file name or manually import'] });
  }
  for (let e = 1; e <= 13; e++) {
    items.push({ id: id++, title: `BLEACH Thousand-Year Blood War - S01E${String(e).padStart(2, '0')}`, trackedStatus: 'warning',
      trackedState: 'importPending', messages: [`Episode 17x${String(e).padStart(2, '0')} was not found in the grabbed release`] });
  }
  items.push({ id: id++, title: '[Erai-raws] Bleach - 05', trackedStatus: 'warning', trackedState: 'importBlocked',
    messages: ['Found matching series via grab history, but release was matched to series by ID.'] });
  return items;
}

describe('summarizeQueue', () => {
  it('counts states itself and collapses duplicate grabs into one group', () => {
    const r = summarizeQueue(liveShapedQueue());
    expect(r.summary).toEqual({ total: 27, needsAttention: 27, byState: { importBlocked: 14, importPending: 13 } });
    expect(r.groups[0]).toMatchObject({ title: 'ReBoot.S01.1080p.WEB-DL.h264', count: 13, trackedState: 'importBlocked' });
    expect(r.groups[0].queueIds).toHaveLength(13);
    expect(r.groups).toHaveLength(15); // 1 ReBoot + 13 Bleach + 1 Erai
  });

  it('does not count ok items as needing attention', () => {
    const r = summarizeQueue([{ id: 1, title: 'x', trackedStatus: 'ok', trackedState: 'downloading' }]);
    expect(r.summary.needsAttention).toBe(0);
  });

  it('caps groups and says how to see the rest', () => {
    const r = summarizeQueue(liveShapedQueue(), 5);
    expect(r.groups).toHaveLength(5);
    expect(r.truncated).toMatchObject({ shown: 5, total: 15 });
  });
});

describe('helpers', () => {
  it('parseQuantity orders binary and decimal units', () => {
    expect(parseQuantity('1Ti')).toBeGreaterThan(parseQuantity('500Gi'));
    expect(parseQuantity('100Mi')).toBe(100 * 1024 ** 2);
    expect(parseQuantity('2G')).toBe(2e9);
    expect(parseQuantity('bogus')).toBeNaN();
    expect(parseQuantity(undefined)).toBeNaN();
  });

  it('capList leaves short lists alone', () => {
    expect(capList([1, 2], 5)).toEqual({ items: [1, 2] });
  });

  it('getDetail defaults to summary', () => {
    expect(getDetail({})).toBe('summary');
    expect(getDetail({ detail: 'nonsense' })).toBe('summary');
    expect(getDetail({ detail: 'full' })).toBe('full');
  });
});

function fluxItems(names: string[], notReady: string[] = []): { body: { items: unknown[] } } {
  return { body: { items: names.map((n) => ({
    metadata: { name: n, namespace: 'flux-system' },
    status: { conditions: [{ type: 'Ready', status: notReady.includes(n) ? 'False' : 'True', message: notReady.includes(n) ? 'kustomize build failed' : 'Applied' }] },
  })) } };
}

describe('get_flux_status', () => {
  beforeEach(() => listCluster.mockReset());
  const ks = Array.from({ length: 41 }, (_, i) => `ks-${i}`);

  it('summary: counts computed server-side, only not-Ready listed', async () => {
    listCluster.mockImplementation((_g: string, _v: string, plural: string) =>
      Promise.resolve(plural === 'kustomizations' ? fluxItems(ks, ['ks-7']) : fluxItems(['hr-a', 'hr-b'])));
    const r = await tool('get_flux_status')({}) as FluxSummary;
    expect(r.summary.kustomizations).toEqual({ total: 41, ready: 40, notReady: 1 });
    expect(r.allReady).toBe(false);
    expect(r.notReady?.kustomizations).toHaveLength(1);
    expect(r.notReady?.kustomizations[0].name).toBe('ks-7');
    expect(r.kustomizations).toBeUndefined();
  });

  it('full: still returns every resource (positive control)', async () => {
    listCluster.mockImplementation((_g: string, _v: string, plural: string) =>
      Promise.resolve(plural === 'kustomizations' ? fluxItems(ks) : fluxItems(['hr-a'])));
    const r = await tool('get_flux_status')({ detail: 'full' }) as FluxSummary;
    expect(r.kustomizations).toHaveLength(41);
    expect(r.summary.kustomizations.total).toBe(41);
  });
});

describe('get_pvcs', () => {
  beforeEach(() => listPvcs.mockReset());
  const pvc = (name: string, cap: string, phase = 'Bound'): unknown => ({
    metadata: { name, namespace: 'media' }, spec: { storageClassName: 'nfs' }, status: { phase, capacity: { storage: cap } },
  });

  it('summary: largest sorted by real size, not string order', async () => {
    listPvcs.mockResolvedValue({ body: { items: [pvc('small', '100Mi'), pvc('big', '1Ti'), pvc('mid', '500Gi'), pvc('stuck', '2Gi', 'Pending')] } });
    const r = await tool('get_pvcs')({}) as PvcSummary;
    expect(r.largest.map((p) => p.name)).toEqual(['big', 'mid', 'stuck', 'small']);
    expect(r.allBound).toBe(false);
    expect(r.notBound.map((p) => p.name)).toEqual(['stuck']);
    expect(r.pvcs).toBeUndefined();
  });
});

describe('get_sonarr_queue', () => {
  it('summary groups the queue; full keeps raw items', async () => {
    const records = liveShapedQueue().map((i) => ({
      ...i, status: 'completed', trackedDownloadStatus: i.trackedStatus, trackedDownloadState: i.trackedState,
      quality: { quality: { name: 'WEBDL-1080p' } }, size: 1024, sizeleft: 0, timeleft: '00:00:00',
      downloadClient: 'SABnzbd', indexer: 'x', statusMessages: [{ messages: i.messages }],
    }));
    sonarrQueue.mockResolvedValue({ totalRecords: 27, records });

    const s = await tool('get_sonarr_queue')({}) as QueueResult;
    expect(s.summary.byState).toEqual({ importBlocked: 14, importPending: 13 });
    expect(s.groups[0].count).toBe(13);
    expect(s.items).toBeUndefined();

    const f = await tool('get_sonarr_queue')({ detail: 'full' }) as QueueResult;
    expect(f.items).toHaveLength(27);
  });
});
