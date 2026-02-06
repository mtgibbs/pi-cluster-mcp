import type { Tool } from './index.js';
import * as sonarr from '../clients/sonarr.js';
import { validationError } from '../utils/errors.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const getSonarrQueue: Tool = {
  name: 'get_sonarr_queue',
  description: 'Get current download queue in Sonarr showing what is downloading, stuck, or failed.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const queue = await sonarr.getQueue();

      return {
        totalRecords: queue.totalRecords,
        items: queue.records.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          trackedStatus: item.trackedDownloadStatus,
          trackedState: item.trackedDownloadState,
          quality: item.quality.quality.name,
          size: formatBytes(item.size),
          sizeLeft: formatBytes(item.sizeleft),
          timeLeft: item.timeleft,
          downloadClient: item.downloadClient,
          indexer: item.indexer,
          messages: item.statusMessages?.flatMap((m) => m.messages),
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Sonarr error';
      return { error: true, code: 'SONARR_ERROR', message };
    }
  },
};

const getSonarrHistory: Tool = {
  name: 'get_sonarr_history',
  description: 'Get recent grab/download/import history for TV series in Sonarr.',
  inputSchema: {
    type: 'object',
    properties: {
      seriesId: { type: 'number', description: 'Filter by specific series ID (optional)' },
      limit: { type: 'number', description: 'Number of history items (default: 20, max: 50)', default: 20 },
    },
  },
  handler: async (params) => {
    const seriesId = params.seriesId as number | undefined;
    const limit = Math.min(Math.max((params.limit as number) || 20, 1), 50);

    try {
      const history = await sonarr.getHistory(seriesId, limit);

      return {
        totalRecords: history.totalRecords,
        items: history.records.map((item) => ({
          id: item.id,
          sourceTitle: item.sourceTitle,
          eventType: item.eventType,
          quality: item.quality.quality.name,
          date: item.date,
          seriesId: item.seriesId,
          episodeId: item.episodeId,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Sonarr error';
      return { error: true, code: 'SONARR_ERROR', message };
    }
  },
};

const searchSonarrEpisode: Tool = {
  name: 'search_sonarr_episode',
  description: 'Trigger a manual interactive search for an episode in Sonarr. Returns available releases with quality, size, and indexer info. Useful when auto-grab picked wrong quality.',
  inputSchema: {
    type: 'object',
    properties: {
      episodeId: { type: 'number', description: 'Episode ID to search for' },
    },
    required: ['episodeId'],
  },
  handler: async (params) => {
    const episodeId = params.episodeId as number;

    if (!Number.isInteger(episodeId) || episodeId <= 0) {
      return validationError('episodeId must be a positive integer');
    }

    try {
      const releases = await sonarr.searchEpisode(episodeId);

      return {
        episodeId,
        releaseCount: releases.length,
        releases: releases.slice(0, 25).map((r) => ({
          title: r.title,
          indexer: r.indexer,
          quality: r.quality.quality.name,
          size: formatBytes(r.size),
          age: `${r.age}d`,
          seeders: r.seeders,
          rejected: r.rejected,
          rejections: r.rejections,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Sonarr error';
      return { error: true, code: 'SONARR_ERROR', message };
    }
  },
};

export const sonarrTools = [getSonarrQueue, getSonarrHistory, searchSonarrEpisode];
