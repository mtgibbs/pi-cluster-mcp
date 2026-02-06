import type { Tool } from './index.js';
import * as bazarr from '../clients/bazarr.js';
import { validationError } from '../utils/errors.js';

const getSubtitleStatus: Tool = {
  name: 'get_subtitle_status',
  description: 'Get wanted/missing subtitle counts for series and movies. Shows which episodes and movies still need subtitles.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const status = await bazarr.getSubtitleStatus();

      return {
        summary: {
          wantedEpisodes: status.episodesCount,
          wantedMovies: status.moviesCount,
        },
        episodes: status.wantedEpisodes.slice(0, 20).map((ep) => ({
          series: ep.seriesTitle,
          episode: `S${ep.season.toString().padStart(2, '0')}E${ep.episode.toString().padStart(2, '0')}`,
          title: ep.episodeTitle,
          missingLanguages: ep.missing_subtitles,
          sonarrEpisodeId: ep.sonarrEpisodeId,
        })),
        movies: status.wantedMovies.slice(0, 20).map((movie) => ({
          title: movie.title,
          missingLanguages: movie.missing_subtitles,
          radarrId: movie.radarrId,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Bazarr error';
      return { error: true, code: 'BAZARR_ERROR', message };
    }
  },
};

const getSubtitleHistory: Tool = {
  name: 'get_subtitle_history',
  description: 'Get recent subtitle download history showing what was found, which provider, and what language.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Number of history items to return (default: 20, max: 50)', default: 20 },
    },
  },
  handler: async (params) => {
    const limit = Math.min(Math.max((params.limit as number) || 20, 1), 50);

    try {
      const history = await bazarr.getSubtitleHistory(limit);

      return {
        count: history.length,
        items: history.map((item) => ({
          action: item.action,
          language: item.language,
          provider: item.provider,
          title: item.title || `${item.seriesTitle} - ${item.episodeTitle}`,
          timestamp: item.timestamp,
          score: item.score,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Bazarr error';
      return { error: true, code: 'BAZARR_ERROR', message };
    }
  },
};

const searchSubtitles: Tool = {
  name: 'search_subtitles',
  description: 'Trigger a manual subtitle search for a specific episode or movie. Use get_subtitle_status first to find the IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['episode', 'movie'], description: 'Type of media to search subtitles for' },
      id: { type: 'number', description: 'Sonarr episode ID or Radarr movie ID' },
    },
    required: ['type', 'id'],
  },
  handler: async (params) => {
    const type = params.type as 'episode' | 'movie';
    const id = params.id as number;

    if (!['episode', 'movie'].includes(type)) {
      return validationError('Type must be "episode" or "movie"');
    }
    if (!Number.isInteger(id) || id <= 0) {
      return validationError('ID must be a positive integer');
    }

    try {
      const result = await bazarr.searchSubtitles(type, id);
      return {
        success: true,
        message: result.message,
        type,
        id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Bazarr error';
      return { error: true, code: 'BAZARR_ERROR', message };
    }
  },
};

export const bazarrTools = [getSubtitleStatus, getSubtitleHistory, searchSubtitles];
