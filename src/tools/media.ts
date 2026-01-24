import type { Tool } from './index.js';
import { listPods } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';
import * as k8s from '@kubernetes/client-node';

const getMediaStatus: Tool = {
  name: 'get_media_status',
  description: 'Get media services health (Jellyfin, Immich) including NFS mount status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
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

      return {
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
    } catch (error) {
      return k8sError(error);
    }
  },
};

const fixJellyfinMetadata: Tool = {
  name: 'fix_jellyfin_metadata',
  description: 'Find an item in Jellyfin and trigger a metadata refresh',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the media item to refresh' },
    },
    required: ['name'],
  },
  handler: (params) => {
    const itemName = params.name as string;

    // TODO: Implement Jellyfin API call to search and refresh metadata
    // Requires JELLYFIN_API_KEY and pod exec or direct API access
    return Promise.resolve({
      message: `Metadata refresh for "${itemName}" - implementation pending`,
      note: 'Requires Jellyfin API key and API endpoint configuration',
    });
  },
};

const touchNasPath: Tool = {
  name: 'touch_nas_path',
  description: 'SSH to Synology NAS and touch a path to update timestamps',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path on NAS to touch' },
    },
    required: ['path'],
  },
  handler: async (params) => {
    const path = params.path as string;

    // Import dynamically to avoid issues when SSH is not configured
    const { touchPath } = await import('../clients/synology.js');

    try {
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
