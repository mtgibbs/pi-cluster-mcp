import type { Tool } from './index.js';
import * as radarr from '../clients/radarr.js';
import { validationError } from '../utils/errors.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const getRadarrQueue: Tool = {
  name: 'get_radarr_queue',
  description: 'Get current download queue in Radarr showing what is downloading, stuck, or failed.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const queue = await radarr.getQueue();

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
      const message = error instanceof Error ? error.message : 'Unknown Radarr error';
      return { error: true, code: 'RADARR_ERROR', message };
    }
  },
};

const getRadarrHistory: Tool = {
  name: 'get_radarr_history',
  description: 'Get recent grab/download/import history for movies in Radarr.',
  inputSchema: {
    type: 'object',
    properties: {
      movieId: { type: 'number', description: 'Filter by specific movie ID (optional)' },
      limit: { type: 'number', description: 'Number of history items (default: 20, max: 50)', default: 20 },
    },
  },
  handler: async (params) => {
    const movieId = params.movieId as number | undefined;
    const limit = Math.min(Math.max((params.limit as number) || 20, 1), 50);

    try {
      const history = await radarr.getHistory(movieId, limit);

      return {
        totalRecords: history.totalRecords,
        items: history.records.map((item) => ({
          id: item.id,
          sourceTitle: item.sourceTitle,
          eventType: item.eventType,
          quality: item.quality.quality.name,
          date: item.date,
          movieId: item.movieId,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Radarr error';
      return { error: true, code: 'RADARR_ERROR', message };
    }
  },
};

const searchRadarrMovie: Tool = {
  name: 'search_radarr_movie',
  description: 'Trigger a manual interactive search for a movie in Radarr. Returns available releases with quality, size, and indexer info.',
  inputSchema: {
    type: 'object',
    properties: {
      movieId: { type: 'number', description: 'Movie ID to search for' },
    },
    required: ['movieId'],
  },
  handler: async (params) => {
    const movieId = params.movieId as number;

    if (!Number.isInteger(movieId) || movieId <= 0) {
      return validationError('movieId must be a positive integer');
    }

    try {
      const releases = await radarr.searchMovie(movieId);

      return {
        movieId,
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
      const message = error instanceof Error ? error.message : 'Unknown Radarr error';
      return { error: true, code: 'RADARR_ERROR', message };
    }
  },
};

export const radarrTools = [getRadarrQueue, getRadarrHistory, searchRadarrMovie];
