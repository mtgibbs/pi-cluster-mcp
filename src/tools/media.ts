import type { Tool } from './index.js';
import { listPods } from '../clients/kubernetes.js';
import { searchItems, refreshItemMetadata, formatItemName, getJellyfinStats } from '../clients/jellyfin.js';
import { getImmichStats } from '../clients/immich.js';
import { getAllowedPaths } from '../clients/synology.js';
import { k8sError } from '../utils/errors.js';
import * as k8s from '@kubernetes/client-node';

const getMediaStatus: Tool = {
  name: 'get_media_status',
  description: 'Get media services health (Jellyfin, Immich) including library stats and active sessions. Check this if media services are down.',
  inputSchema: {
    type: 'object',
    properties: {
      includeStats: { type: 'boolean', description: 'Include library statistics from APIs', default: true },
    },
  },
  handler: async (params) => {
    const includeStats = params.includeStats !== false;

    try {
      const [jellyfinPods, immichPods] = await Promise.all([
        listPods('jellyfin'),
        listPods('immich'),
      ]);

      const formatPod = (pod: k8s.V1Pod): { name: string | undefined; ready: boolean; phase: string | undefined; restarts: number; volumes: { name: string; type: string; source: string | undefined }[] | undefined } => ({
        name: pod.metadata?.name,
        ready: pod.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
        phase: pod.status?.phase,
        restarts: pod.status?.containerStatuses?.[0]?.restartCount || 0,
        volumes: pod.spec?.volumes
          ?.filter((v) => v.nfs || v.persistentVolumeClaim)
          .map((v) => ({
            name: v.name,
            type: v.nfs ? 'nfs' : 'pvc',
            source: v.nfs ? `${v.nfs.server}:${v.nfs.path}` : v.persistentVolumeClaim?.claimName,
          })),
      });

      const jellyfin = jellyfinPods.map(formatPod);
      const immich = immichPods.map(formatPod);

      const result: Record<string, unknown> = {
        jellyfin: {
          pods: jellyfin,
          healthy: jellyfin.every((p) => p.ready),
        },
        immich: {
          pods: immich,
          healthy: immich.every((p) => p.ready),
        },
        summary: {
          allHealthy: jellyfin.every((p) => p.ready) && immich.every((p) => p.ready),
          jellyfinPods: jellyfin.length,
          immichPods: immich.length,
        },
      };

      // Fetch stats if requested and services are healthy
      if (includeStats) {
        const statsPromises: Promise<void>[] = [];

        if (jellyfin.some((p) => p.ready)) {
          statsPromises.push(
            getJellyfinStats()
              .then((stats) => {
                (result.jellyfin as Record<string, unknown>).stats = stats;
              })
              .catch((error) => {
                (result.jellyfin as Record<string, unknown>).statsError =
                  error instanceof Error ? error.message : 'Failed to fetch Jellyfin stats';
              })
          );
        }

        if (immich.some((p) => p.ready)) {
          statsPromises.push(
            getImmichStats()
              .then((stats) => {
                (result.immich as Record<string, unknown>).stats = stats;
              })
              .catch((error) => {
                (result.immich as Record<string, unknown>).statsError =
                  error instanceof Error ? error.message : 'Failed to fetch Immich stats';
              })
          );
        }

        await Promise.all(statsPromises);
      }

      return result;
    } catch (error) {
      return k8sError(error);
    }
  },
};

const fixJellyfinMetadata: Tool = {
  name: 'fix_jellyfin_metadata',
  description: 'Search for a media item in Jellyfin and trigger a metadata refresh. Use this when media items have incorrect or missing info.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the media item to search for and refresh' },
      itemId: { type: 'string', description: 'Direct item ID to refresh (skips search)' },
      replaceAll: { type: 'boolean', description: 'Replace all existing metadata and images', default: false },
    },
  },
  handler: async (params) => {
    const searchName = params.name as string | undefined;
    const directItemId = params.itemId as string | undefined;
    const replaceAll = (params.replaceAll as boolean) || false;

    if (!searchName && !directItemId) {
      return {
        error: true,
        code: 'MISSING_PARAM',
        message: 'Either "name" or "itemId" must be provided',
      };
    }

    try {
      let itemId: string;
      let itemName: string;

      if (directItemId) {
        itemId = directItemId;
        itemName = directItemId;
      } else {
        // Search for the item
        const items = await searchItems(searchName!, 5);

        if (items.length === 0) {
          return {
            error: true,
            code: 'NOT_FOUND',
            message: `No items found matching "${searchName}"`,
          };
        }

        if (items.length > 1) {
          return {
            error: true,
            code: 'MULTIPLE_MATCHES',
            message: `Multiple items found matching "${searchName}". Please be more specific or use itemId.`,
            matches: items.map((item) => ({
              id: item.Id,
              name: formatItemName(item),
              type: item.Type,
              path: item.Path,
            })),
          };
        }

        itemId = items[0].Id;
        itemName = formatItemName(items[0]);
      }

      // Trigger metadata refresh
      await refreshItemMetadata(itemId, {
        replaceAllMetadata: replaceAll,
        replaceAllImages: replaceAll,
      });

      return {
        success: true,
        message: `Triggered metadata refresh for "${itemName}"`,
        itemId,
        replaceAll,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Jellyfin error';
      return {
        error: true,
        code: 'JELLYFIN_ERROR',
        message,
      };
    }
  },
};

const touchNasPath: Tool = {
  name: 'touch_nas_path',
  description: `SSH to Synology NAS and touch a path to update timestamps. Restricted to: ${getAllowedPaths().join(', ')}`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: `Absolute path on NAS (must start with ${getAllowedPaths().join(' or ')})` },
    },
    required: ['path'],
  },
  handler: async (params) => {
    const path = params.path as string;

    try {
      const { touchPath } = await import('../clients/synology.js');
      await touchPath(path);
      return {
        success: true,
        message: `Touched path: ${path}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SSH error';
      return {
        error: true,
        code: 'SSH_ERROR',
        message,
      };
    }
  },
};

export const mediaTools = [getMediaStatus, fixJellyfinMetadata, touchNasPath];
