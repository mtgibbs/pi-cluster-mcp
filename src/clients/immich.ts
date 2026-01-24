const IMMICH_URL = process.env.IMMICH_URL || 'http://immich-server.immich.svc.cluster.local:3001';
const IMMICH_API_KEY = process.env.IMMICH_API_KEY;

interface ServerStats {
  photos: number;
  videos: number;
  usage: number;
  usageByUser: {
    usagePhotos: number;
    usageVideos: number;
    photos: number;
    videos: number;
    userName: string;
  }[];
}

interface ServerInfo {
  diskSize: string;
  diskUse: string;
  diskAvailable: string;
  diskSizeRaw: number;
  diskUseRaw: number;
  diskAvailableRaw: number;
  diskUsagePercentage: number;
}

interface ServerVersion {
  major: number;
  minor: number;
  patch: number;
}

async function immichFetch<T>(path: string): Promise<T> {
  if (!IMMICH_API_KEY) {
    throw new Error('IMMICH_API_KEY environment variable not set');
  }

  const url = `${IMMICH_URL}/api${path}`;
  const headers = {
    'x-api-key': IMMICH_API_KEY,
    'Content-Type': 'application/json',
  };

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Immich API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function getServerStats(): Promise<ServerStats> {
  return immichFetch<ServerStats>('/server-info/statistics');
}

export async function getServerInfo(): Promise<ServerInfo> {
  return immichFetch<ServerInfo>('/server-info/storage');
}

export async function getServerVersion(): Promise<ServerVersion> {
  return immichFetch<ServerVersion>('/server-info/version');
}

export interface ImmichStats {
  version: string;
  storage: {
    total: string;
    used: string;
    available: string;
    usagePercentage: number;
  };
  library: {
    photos: number;
    videos: number;
    totalAssets: number;
  };
}

export async function getImmichStats(): Promise<ImmichStats> {
  const [version, storage, stats] = await Promise.all([
    getServerVersion(),
    getServerInfo(),
    getServerStats(),
  ]);

  return {
    version: `${version.major}.${version.minor}.${version.patch}`,
    storage: {
      total: storage.diskSize,
      used: storage.diskUse,
      available: storage.diskAvailable,
      usagePercentage: storage.diskUsagePercentage,
    },
    library: {
      photos: stats.photos,
      videos: stats.videos,
      totalAssets: stats.photos + stats.videos,
    },
  };
}
