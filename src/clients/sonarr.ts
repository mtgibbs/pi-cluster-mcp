// Sonarr v3 API client
// API docs: https://sonarr.tv/docs/api/

const SONARR_URL = process.env.SONARR_URL || 'http://sonarr.media.svc.cluster.local:8989';
const SONARR_API_KEY = process.env.SONARR_API_KEY;

async function sonarrFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!SONARR_API_KEY) {
    throw new Error('SONARR_API_KEY environment variable not set');
  }

  const url = `${SONARR_URL}/api/v3${path}`;
  const headers = {
    'X-Api-Key': SONARR_API_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    throw new Error(`Sonarr API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// Types based on Sonarr API

export interface QueueItem {
  id: number;
  seriesId: number;
  episodeId: number;
  title: string;
  status: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title: string; messages: string[] }[];
  sizeleft: number;
  size: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  downloadClient?: string;
  indexer?: string;
  quality: { quality: { name: string } };
}

export interface QueueResponse {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: QueueItem[];
}

export interface HistoryItem {
  id: number;
  seriesId: number;
  episodeId: number;
  sourceTitle: string;
  date: string;
  eventType: string;
  quality: { quality: { name: string } };
  data: Record<string, string>;
}

export interface HistoryResponse {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: HistoryItem[];
}

export interface Release {
  guid: string;
  title: string;
  indexer: string;
  size: number;
  quality: { quality: { name: string } };
  seeders?: number;
  leechers?: number;
  age: number;
  ageHours: number;
  rejected: boolean;
  rejections?: string[];
}

export interface QualityProfile {
  id: number;
  name: string;
  cutoff: number;
  items: { quality?: { name: string }; allowed: boolean }[];
}

export async function getQueue(): Promise<QueueResponse> {
  return sonarrFetch<QueueResponse>('/queue?pageSize=50&includeUnknownSeriesItems=true');
}

export async function getHistory(seriesId?: number, limit = 50): Promise<HistoryResponse> {
  const params = new URLSearchParams({
    pageSize: limit.toString(),
    sortKey: 'date',
    sortDirection: 'descending',
  });
  if (seriesId) {
    params.set('seriesId', seriesId.toString());
  }
  return sonarrFetch<HistoryResponse>(`/history?${params.toString()}`);
}

export async function searchEpisode(episodeId: number): Promise<Release[]> {
  return sonarrFetch<Release[]>(`/release?episodeId=${episodeId}`);
}

export async function searchSeason(seriesId: number, seasonNumber: number): Promise<Release[]> {
  // Trigger a season search command
  await sonarrFetch('/command', {
    method: 'POST',
    body: JSON.stringify({
      name: 'SeasonSearch',
      seriesId,
      seasonNumber,
    }),
  });
  return []; // Command triggers async search
}

export async function getQualityProfiles(): Promise<QualityProfile[]> {
  return sonarrFetch<QualityProfile[]>('/qualityprofile');
}

export async function deleteQueueItem(id: number, options?: {
  removeFromClient?: boolean;
  blocklist?: boolean;
}): Promise<void> {
  const params = new URLSearchParams();
  if (options?.removeFromClient) params.set('removeFromClient', 'true');
  if (options?.blocklist) params.set('blocklist', 'true');

  await sonarrFetch(`/queue/${id}?${params.toString()}`, { method: 'DELETE' });
}
