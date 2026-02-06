// Radarr v3 API client
// API docs: https://radarr.video/docs/api/

const RADARR_URL = process.env.RADARR_URL || 'http://radarr.media.svc.cluster.local:7878';
const RADARR_API_KEY = process.env.RADARR_API_KEY;

async function radarrFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!RADARR_API_KEY) {
    throw new Error('RADARR_API_KEY environment variable not set');
  }

  const url = `${RADARR_URL}/api/v3${path}`;
  const headers = {
    'X-Api-Key': RADARR_API_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    throw new Error(`Radarr API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// Types based on Radarr API

export interface QueueItem {
  id: number;
  movieId: number;
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
  movieId: number;
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
  return radarrFetch<QueueResponse>('/queue?pageSize=50&includeUnknownMovieItems=true');
}

export async function getHistory(movieId?: number, limit = 50): Promise<HistoryResponse> {
  const params = new URLSearchParams({
    pageSize: limit.toString(),
    sortKey: 'date',
    sortDirection: 'descending',
  });
  if (movieId) {
    params.set('movieId', movieId.toString());
  }
  return radarrFetch<HistoryResponse>(`/history?${params.toString()}`);
}

export async function searchMovie(movieId: number): Promise<Release[]> {
  return radarrFetch<Release[]>(`/release?movieId=${movieId}`);
}

export async function getQualityProfiles(): Promise<QualityProfile[]> {
  return radarrFetch<QualityProfile[]>('/qualityprofile');
}

export async function deleteQueueItem(id: number, options?: {
  removeFromClient?: boolean;
  blocklist?: boolean;
}): Promise<void> {
  const params = new URLSearchParams();
  if (options?.removeFromClient) params.set('removeFromClient', 'true');
  if (options?.blocklist) params.set('blocklist', 'true');

  await radarrFetch(`/queue/${id}?${params.toString()}`, { method: 'DELETE' });
}
