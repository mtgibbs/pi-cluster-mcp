// SABnzbd API client
// API docs: https://sabnzbd.org/wiki/advanced/api

const SABNZBD_URL = process.env.SABNZBD_URL || 'http://sabnzbd.media.svc.cluster.local:8080';
const SABNZBD_API_KEY = process.env.SABNZBD_API_KEY;

async function sabnzbdFetch<T>(mode: string, params: Record<string, string> = {}): Promise<T> {
  if (!SABNZBD_API_KEY) {
    throw new Error('SABNZBD_API_KEY environment variable not set');
  }

  const urlParams = new URLSearchParams({
    mode,
    apikey: SABNZBD_API_KEY,
    output: 'json',
    ...params,
  });

  const url = `${SABNZBD_URL}/api?${urlParams.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`SABnzbd API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as T & { error?: string };
  if (data.error) {
    throw new Error(`SABnzbd error: ${data.error}`);
  }

  return data;
}

// Types based on SABnzbd API

export interface QueueSlot {
  nzo_id: string;
  filename: string;
  status: string;
  mb: string;
  mbleft: string;
  percentage: string;
  timeleft: string;
  eta: string;
  cat: string;
  priority: string;
  avg_age: string;
}

export interface QueueResponse {
  queue: {
    status: string;
    speedlimit: string;
    speed: string;
    size: string;
    sizeleft: string;
    timeleft: string;
    noofslots: number;
    slots: QueueSlot[];
    paused: boolean;
    diskspace1: string;
    diskspace2: string;
  };
}

export interface HistorySlot {
  nzo_id: string;
  name: string;
  status: string;
  category: string;
  bytes: number;
  size: string;
  completed: number;
  fail_message: string;
  storage: string;
  action_line: string;
}

export interface HistoryResponse {
  history: {
    noofslots: number;
    slots: HistorySlot[];
    total_size: string;
    month_size: string;
    week_size: string;
  };
}

export interface StatusResponse {
  status: {
    version: string;
    paused: boolean;
    speed: string;
    diskspace1: string;
    diskspace2: string;
    noofslots: number;
    noofslots_total: number;
  };
}

export async function getQueue(): Promise<QueueResponse> {
  return sabnzbdFetch<QueueResponse>('queue', { limit: '50' });
}

export async function getHistory(limit = 50): Promise<HistoryResponse> {
  return sabnzbdFetch<HistoryResponse>('history', { limit: limit.toString() });
}

export async function getStatus(): Promise<StatusResponse> {
  return sabnzbdFetch<StatusResponse>('qstatus');
}

export async function pauseQueue(): Promise<{ status: boolean }> {
  return sabnzbdFetch<{ status: boolean }>('pause');
}

export async function resumeQueue(): Promise<{ status: boolean }> {
  return sabnzbdFetch<{ status: boolean }>('resume');
}

export async function pauseItem(nzoId: string): Promise<{ status: boolean }> {
  return sabnzbdFetch<{ status: boolean }>('queue', { name: 'pause', value: nzoId });
}

export async function resumeItem(nzoId: string): Promise<{ status: boolean }> {
  return sabnzbdFetch<{ status: boolean }>('queue', { name: 'resume', value: nzoId });
}

export async function retryDownload(nzoId: string): Promise<{ status: boolean }> {
  return sabnzbdFetch<{ status: boolean }>('retry', { value: nzoId });
}

export async function deleteHistoryItem(nzoId: string): Promise<{ status: boolean }> {
  return sabnzbdFetch<{ status: boolean }>('history', { name: 'delete', value: nzoId });
}
