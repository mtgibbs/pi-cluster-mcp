const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin.jellyfin.svc.cluster.local:8096';
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;

interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  Path?: string;
  ParentId?: string;
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
}

interface SearchResult {
  Items: JellyfinItem[];
  TotalRecordCount: number;
}

async function jellyfinFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!JELLYFIN_API_KEY) {
    throw new Error('JELLYFIN_API_KEY environment variable not set');
  }

  const url = `${JELLYFIN_URL}${path}`;
  const headers = {
    'X-Emby-Token': JELLYFIN_API_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    throw new Error(`Jellyfin API error: ${response.status} ${response.statusText}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

export async function searchItems(searchTerm: string, limit = 10): Promise<JellyfinItem[]> {
  const params = new URLSearchParams({
    searchTerm,
    Limit: limit.toString(),
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series,Episode,MusicAlbum,MusicArtist',
  });

  const result = await jellyfinFetch<SearchResult>(`/Items?${params.toString()}`);
  return result.Items;
}

export async function refreshItemMetadata(itemId: string, options?: {
  replaceAllMetadata?: boolean;
  replaceAllImages?: boolean;
}): Promise<void> {
  const params = new URLSearchParams({
    MetadataRefreshMode: 'FullRefresh',
    ImageRefreshMode: 'FullRefresh',
    ReplaceAllMetadata: (options?.replaceAllMetadata ?? false).toString(),
    ReplaceAllImages: (options?.replaceAllImages ?? false).toString(),
  });

  await jellyfinFetch(`/Items/${itemId}/Refresh?${params.toString()}`, {
    method: 'POST',
  });
}

export async function getItemById(itemId: string): Promise<JellyfinItem> {
  return jellyfinFetch<JellyfinItem>(`/Items/${itemId}`);
}

export function formatItemName(item: JellyfinItem): string {
  if (item.Type === 'Episode' && item.SeriesName) {
    const season = item.ParentIndexNumber ? `S${item.ParentIndexNumber.toString().padStart(2, '0')}` : '';
    const episode = item.IndexNumber ? `E${item.IndexNumber.toString().padStart(2, '0')}` : '';
    return `${item.SeriesName} ${season}${episode} - ${item.Name}`;
  }
  return item.Name;
}

interface LibraryCounts {
  MovieCount: number;
  SeriesCount: number;
  EpisodeCount: number;
  ArtistCount: number;
  ProgramCount: number;
  TrailerCount: number;
  SongCount: number;
  AlbumCount: number;
  MusicVideoCount: number;
  BoxSetCount: number;
  BookCount: number;
  ItemCount: number;
}

interface SystemInfo {
  ServerName: string;
  Version: string;
  OperatingSystem: string;
  HasPendingRestart: boolean;
  HasUpdateAvailable: boolean;
}

interface SessionInfo {
  Id: string;
  UserName: string;
  Client: string;
  DeviceName: string;
  NowPlayingItem?: JellyfinItem;
  PlayState?: {
    IsPaused: boolean;
    PositionTicks: number;
  };
}

export async function getLibraryCounts(): Promise<LibraryCounts> {
  return jellyfinFetch<LibraryCounts>('/Items/Counts');
}

export async function getSystemInfo(): Promise<SystemInfo> {
  return jellyfinFetch<SystemInfo>('/System/Info');
}

export async function getActiveSessions(): Promise<SessionInfo[]> {
  return jellyfinFetch<SessionInfo[]>('/Sessions');
}

export interface JellyfinStats {
  system: {
    serverName: string;
    version: string;
    hasPendingRestart: boolean;
    hasUpdateAvailable: boolean;
  };
  library: {
    movies: number;
    series: number;
    episodes: number;
    songs: number;
    albums: number;
    artists: number;
  };
  activeSessions: {
    userName: string;
    client: string;
    device: string;
    nowPlaying?: string;
    isPaused?: boolean;
  }[];
}

export async function getJellyfinStats(): Promise<JellyfinStats> {
  const [systemInfo, counts, sessions] = await Promise.all([
    getSystemInfo(),
    getLibraryCounts(),
    getActiveSessions(),
  ]);

  return {
    system: {
      serverName: systemInfo.ServerName,
      version: systemInfo.Version,
      hasPendingRestart: systemInfo.HasPendingRestart,
      hasUpdateAvailable: systemInfo.HasUpdateAvailable,
    },
    library: {
      movies: counts.MovieCount,
      series: counts.SeriesCount,
      episodes: counts.EpisodeCount,
      songs: counts.SongCount,
      albums: counts.AlbumCount,
      artists: counts.ArtistCount,
    },
    activeSessions: sessions
      .filter((s) => s.NowPlayingItem)
      .map((s) => ({
        userName: s.UserName,
        client: s.Client,
        device: s.DeviceName,
        nowPlaying: s.NowPlayingItem ? formatItemName(s.NowPlayingItem) : undefined,
        isPaused: s.PlayState?.IsPaused,
      })),
  };
}
