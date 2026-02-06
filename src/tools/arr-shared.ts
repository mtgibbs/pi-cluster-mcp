import type { Tool } from './index.js';
import * as sonarr from '../clients/sonarr.js';
import * as radarr from '../clients/radarr.js';
import { validationError } from '../utils/errors.js';

const getQualityProfile: Tool = {
  name: 'get_quality_profile',
  description: 'View quality profiles in Sonarr or Radarr to understand what quality levels are being targeted.',
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', enum: ['sonarr', 'radarr'], description: 'Which service to get profiles from' },
    },
    required: ['service'],
  },
  handler: async (params) => {
    const service = params.service as 'sonarr' | 'radarr';

    if (!['sonarr', 'radarr'].includes(service)) {
      return validationError('service must be "sonarr" or "radarr"');
    }

    try {
      const profiles = service === 'sonarr'
        ? await sonarr.getQualityProfiles()
        : await radarr.getQualityProfiles();

      return {
        service,
        profiles: profiles.map((p) => ({
          id: p.id,
          name: p.name,
          cutoff: p.cutoff,
          allowedQualities: p.items
            .filter((i) => i.allowed && i.quality)
            .map((i) => i.quality?.name),
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unknown ${service} error`;
      return { error: true, code: `${service.toUpperCase()}_ERROR`, message };
    }
  },
};

const rejectAndSearch: Tool = {
  name: 'reject_and_search',
  description: 'Reject a queued item in Sonarr or Radarr (optionally blocklisting it) and trigger a new search. Useful when wrong quality or release was grabbed.',
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', enum: ['sonarr', 'radarr'], description: 'Which service the queue item is in' },
      queueId: { type: 'number', description: 'Queue item ID to reject' },
      blocklist: { type: 'boolean', description: 'Add release to blocklist to prevent re-grabbing (default: true)', default: true },
      searchAgain: { type: 'boolean', description: 'Trigger a new search after rejection (default: true)', default: true },
    },
    required: ['service', 'queueId'],
  },
  handler: async (params) => {
    const service = params.service as 'sonarr' | 'radarr';
    const queueId = params.queueId as number;
    const blocklist = params.blocklist !== false;
    const searchAgain = params.searchAgain !== false;

    if (!['sonarr', 'radarr'].includes(service)) {
      return validationError('service must be "sonarr" or "radarr"');
    }
    if (!Number.isInteger(queueId) || queueId <= 0) {
      return validationError('queueId must be a positive integer');
    }

    try {
      // First, get the queue item details so we can search again
      const queue = service === 'sonarr'
        ? await sonarr.getQueue()
        : await radarr.getQueue();

      const item = queue.records.find((r) => r.id === queueId);
      if (!item) {
        return {
          error: true,
          code: 'NOT_FOUND',
          message: `Queue item ${queueId} not found in ${service}`,
        };
      }

      // Delete the queue item
      if (service === 'sonarr') {
        await sonarr.deleteQueueItem(queueId, { removeFromClient: true, blocklist });
      } else {
        await radarr.deleteQueueItem(queueId, { removeFromClient: true, blocklist });
      }

      const result: Record<string, unknown> = {
        success: true,
        message: `Rejected queue item ${queueId}`,
        service,
        queueId,
        blocklisted: blocklist,
        title: item.title,
      };

      // Trigger new search if requested
      if (searchAgain) {
        try {
          if (service === 'sonarr' && 'episodeId' in item) {
            await sonarr.searchEpisode(item.episodeId);
            result.searchTriggered = true;
            result.searchTarget = `episode ${item.episodeId}`;
          } else if (service === 'radarr' && 'movieId' in item) {
            await radarr.searchMovie(item.movieId);
            result.searchTriggered = true;
            result.searchTarget = `movie ${item.movieId}`;
          }
        } catch (searchError) {
          result.searchTriggered = false;
          result.searchError = searchError instanceof Error ? searchError.message : 'Search failed';
        }
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unknown ${service} error`;
      return { error: true, code: `${service.toUpperCase()}_ERROR`, message };
    }
  },
};

export const arrSharedTools = [getQualityProfile, rejectAndSearch];
