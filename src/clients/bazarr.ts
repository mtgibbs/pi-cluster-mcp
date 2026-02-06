// Bazarr API client
// API docs: https://wiki.bazarr.media/Additional-Configuration/Settings/#api

const BAZARR_URL = process.env.BAZARR_URL || 'http://bazarr.media.svc.cluster.local:6767';
const BAZARR_API_KEY = process.env.BAZARR_API_KEY;

async function bazarrFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!BAZARR_API_KEY) {
    throw new Error('BAZARR_API_KEY environment variable not set');
  }

  const url = `${BAZARR_URL}/api${path}`;
  const headers = {
    'X-API-KEY': BAZARR_API_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    throw new Error(`Bazarr API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// Types based on Bazarr API

export interface WantedEpisode {
  sonarrSeriesId: number;
  sonarrEpisodeId: number;
  seriesTitle: string;
  episodeTitle: string;
  season: number;
  episode: number;
  missing_subtitles: string[];
}

export interface WantedMovie {
  radarrId: number;
  title: string;
  missing_subtitles: string[];
}

export interface SubtitleHistoryItem {
  action: string;
  language: string;
  provider: string;
  seriesTitle?: string;
  episodeTitle?: string;
  title?: string;
  timestamp: string;
  score?: number;
}

export interface SubtitleStatus {
  wantedEpisodes: WantedEpisode[];
  wantedMovies: WantedMovie[];
  episodesCount: number;
  moviesCount: number;
}

export async function getSubtitleStatus(): Promise<SubtitleStatus> {
  const [wantedEpisodes, wantedMovies] = await Promise.all([
    bazarrFetch<{ data: WantedEpisode[]; total: number }>('/episodes/wanted?length=50'),
    bazarrFetch<{ data: WantedMovie[]; total: number }>('/movies/wanted?length=50'),
  ]);

  return {
    wantedEpisodes: wantedEpisodes.data,
    wantedMovies: wantedMovies.data,
    episodesCount: wantedEpisodes.total,
    moviesCount: wantedMovies.total,
  };
}

export async function getSubtitleHistory(limit = 50): Promise<SubtitleHistoryItem[]> {
  const response = await bazarrFetch<{ data: SubtitleHistoryItem[] }>(`/history/series?length=${limit}`);
  const movieHistory = await bazarrFetch<{ data: SubtitleHistoryItem[] }>(`/history/movies?length=${limit}`);

  // Combine and sort by timestamp
  const combined = [...response.data, ...movieHistory.data];
  combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return combined.slice(0, limit);
}

export async function searchSubtitles(
  type: 'episode' | 'movie',
  id: number
): Promise<{ message: string }> {
  if (type === 'episode') {
    await bazarrFetch(`/episodes/subtitles?id=${id}`, { method: 'PATCH' });
  } else {
    await bazarrFetch(`/movies/subtitles?id=${id}`, { method: 'PATCH' });
  }
  return { message: `Subtitle search triggered for ${type} ${id}` };
}
