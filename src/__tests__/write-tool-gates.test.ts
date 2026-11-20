import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

const sshExec = vi.fn();
vi.mock('node-ssh', () => ({
  NodeSSH: class {
    connect = vi.fn();
    isConnected = (): boolean => true;
    execCommand = sshExec;
  },
}));

const patchCustom = vi.fn();
const getCustom = vi.fn();
const listCustom = vi.fn();
vi.mock('../clients/kubernetes.js', () => ({
  getCustomObjectsApi: (): unknown => ({
    patchNamespacedCustomObject: patchCustom,
    getNamespacedCustomObject: getCustom,
    listClusterCustomObject: listCustom,
  }),
  getCoreApi: (): unknown => ({}),
  getKubeConfig: (): unknown => ({ makeApiClient: (): unknown => ({}) }),
  listPods: vi.fn(),
  execInPod: vi.fn(),
  getReadyPod: vi.fn(),
  readPodLog: vi.fn(),
}));

const refreshItemMetadata = vi.fn();
vi.mock('../clients/jellyfin.js', () => ({
  searchItems: vi.fn(),
  refreshItemMetadata,
  formatItemName: (i: { Name: string }): string => i.Name,
  getJellyfinStats: vi.fn(),
}));

const updateGravity = vi.fn();
vi.mock('../clients/pihole.js', () => ({
  updateGravity,
  getFullStats: vi.fn(),
  getMessages: vi.fn(),
  getWhitelist: vi.fn(),
  getRecentQueries: vi.fn(),
}));

// The NAS allowlist is read at module load, so set it before importing.
process.env.NAS_ALLOWED_PATHS = '/volume1/media/movies,/volume1/media/tv/';
process.env.NAS_HOST = 'nas';
process.env.NAS_USER = 'u';
process.env.NAS_PRIVATE_KEY = 'k';
const { validateNasPath, touchPath } = await import('../clients/synology.js');
const { tools } = await import('../tools/index.js');
const handler = (name: string): ((p: Record<string, unknown>) => Promise<unknown>) =>
  tools.find((t) => t.name === name)!.handler;

describe('validateNasPath (touch_nas_path)', () => {
  it('accepts normal paths inside an allowed prefix, including quotes and spaces', () => {
    expect(validateNasPath('/volume1/media/movies/Heat (1995)')).toBe('/volume1/media/movies/Heat (1995)');
    expect(validateNasPath("/volume1/media/tv/Bob's Burgers")).toBe("/volume1/media/tv/Bob's Burgers");
    expect(validateNasPath('/volume1/media/movies')).toBe('/volume1/media/movies');
  });

  it('rejects quote breakouts, newlines and other control characters', () => {
    expect(() => validateNasPath('/volume1/media/movies/a\nrm -rf /volume1')).toThrow(/control/);
    expect(() => validateNasPath('/volume1/media/movies/a\u0000b')).toThrow(/control/);
  });

  it('rejects traversal and unnormalized paths', () => {
    expect(() => validateNasPath('/volume1/media/movies/../../homes')).toThrow(/normalized/);
    expect(() => validateNasPath('/volume1/media/movies/./x')).toThrow(/normalized/);
    expect(() => validateNasPath('/volume1/media/movies//x')).toThrow(/normalized/);
    expect(() => validateNasPath('volume1/media/movies/x')).toThrow(/absolute/);
  });

  it('matches prefixes on whole path segments only', () => {
    expect(() => validateNasPath('/volume1/media/movies-private/x')).toThrow(/not allowed/);
    expect(() => validateNasPath('/volume1/media/tvshows')).toThrow(/not allowed/);
    expect(() => validateNasPath('/volume1/homes')).toThrow(/not allowed/);
  });

  it('rejects non-strings and oversized input', () => {
    expect(() => validateNasPath(42)).toThrow();
    expect(() => validateNasPath('')).toThrow();
    expect(() => validateNasPath(`/volume1/media/movies/${'a'.repeat(1100)}`)).toThrow();
  });
});

describe('touchPath shell command', () => {
  beforeEach(() => sshExec.mockReset().mockResolvedValue({ stdout: '', stderr: '' }));

  // Feed the generated command to a real sh, with `touch` swapped for printf, and check the shell
  // sees exactly one argument equal to the input path.
  const argsSeenByShell = (command: string): string[] =>
    execFileSync('sh', ['-c', command.replace(/^touch --/, "printf '%s\\n'")]).toString().split('\n').slice(0, -1);

  it.each([
    '/volume1/media/movies/a" "/etc/passwd',
    "/volume1/media/movies/it's'; rm -rf '/volume1",
    '/volume1/media/movies/$(id) `id` ; & | !',
  ])('passes %s to the shell as a single literal argument', async (path) => {
    await touchPath(path);
    expect(argsSeenByShell((sshExec.mock.calls as string[][])[0][0])).toEqual([path]);
  });
});

describe('fix_jellyfin_metadata itemId', () => {
  beforeEach(() => refreshItemMetadata.mockReset().mockResolvedValue(undefined));

  it('refuses an itemId that is not a GUID, without calling Jellyfin', async () => {
    for (const itemId of ['../System/Restart', 'abc', '0123456789abcdef0123456789abcdef/x']) {
      expect(await handler('fix_jellyfin_metadata')({ itemId })).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(refreshItemMetadata).not.toHaveBeenCalled();
  });

  it('accepts plain and dashed GUIDs', async () => {
    await handler('fix_jellyfin_metadata')({ itemId: '0123456789abcdef0123456789ABCDEF' });
    await handler('fix_jellyfin_metadata')({ itemId: '01234567-89ab-cdef-0123-456789abcdef' });
    expect(refreshItemMetadata).toHaveBeenCalledTimes(2);
  });
});

describe('refresh_secret gates', () => {
  beforeEach(() => {
    patchCustom.mockReset().mockResolvedValue({});
    getCustom.mockReset().mockResolvedValue({ body: { metadata: { labels: { 'kustomize.toolkit.fluxcd.io/name': 'media' } } } });
  });

  it('refuses an ExternalSecret not applied by Flux', async () => {
    getCustom.mockResolvedValue({ body: { metadata: { labels: {} } } });
    expect(await handler('refresh_secret')({ namespace: 'default', name: 'handmade' })).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(patchCustom).not.toHaveBeenCalled();
  });

  it('refuses non-DNS-1123 names without patching', async () => {
    expect(await handler('refresh_secret')({ namespace: 'media', name: '../x' })).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await handler('refresh_secret')({ namespace: 'Media', name: 'x' })).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(patchCustom).not.toHaveBeenCalled();
  });

  it('patches a valid ExternalSecret', async () => {
    expect(await handler('refresh_secret')({ namespace: 'media', name: 'sonarr' })).toMatchObject({ success: true });
    expect(patchCustom).toHaveBeenCalledOnce();
  });
});

describe('update_pihole_gravity rate gate', () => {
  it('runs once, then refuses repeats inside the cooldown', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-04T00:00:00Z') });
    updateGravity.mockReset().mockResolvedValue('Gravity update triggered');
    try {
      expect(await handler('update_pihole_gravity')({})).toMatchObject({ success: true });
      expect(await handler('update_pihole_gravity')({})).toMatchObject({ code: 'RATE_LIMITED' });
      expect(updateGravity).toHaveBeenCalledOnce();

      vi.setSystemTime(new Date('2026-11-04T00:05:01Z'));
      expect(await handler('update_pihole_gravity')({})).toMatchObject({ success: true });
      expect(updateGravity).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconcile_flux scope gate', () => {
  const reconcile = (resource?: string): Promise<unknown> =>
    handler('reconcile_flux')(resource ? { resource } : {});
  beforeEach(() => {
    patchCustom.mockReset().mockResolvedValue({});
    getCustom.mockReset();
    listCustom.mockReset();
  });

  it('only reconciles Kustomizations in flux-system', async () => {
    expect(await reconcile('kustomization/media/sonarr')).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(patchCustom).not.toHaveBeenCalled();
    expect(await reconcile('kustomization/flux-system/media')).toMatchObject({ success: true });
    expect(patchCustom).toHaveBeenCalledOnce();
  });

  it('only reconciles HelmReleases applied by a Flux Kustomization', async () => {
    getCustom.mockResolvedValueOnce({ body: { metadata: { labels: {} } } });
    expect(await reconcile('helmrelease/default/handmade')).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(patchCustom).not.toHaveBeenCalled();

    getCustom.mockResolvedValueOnce({ body: { metadata: { labels: { 'kustomize.toolkit.fluxcd.io/name': 'monitoring' } } } });
    expect(await reconcile('helmrelease/monitoring/kube-prometheus-stack')).toMatchObject({ success: true });
    expect(patchCustom).toHaveBeenCalledOnce();
  });

  it('reconcile-all skips Kustomizations outside flux-system', async () => {
    listCustom.mockResolvedValue({
      body: { items: [
        { metadata: { namespace: 'flux-system', name: 'a' } },
        { metadata: { namespace: 'rogue', name: 'b' } },
      ] },
    });
    expect(await reconcile()).toMatchObject({ success: true, reconciled: ['flux-system/a'] });
    expect(patchCustom).toHaveBeenCalledOnce();
  });
});
