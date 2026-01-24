import type { Tool } from './index.js';
import { getCustomObjectsApi, listPods } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';

interface TailscaleConnector {
  metadata: {
    name: string;
    namespace: string;
  };
  spec?: {
    hostname?: string;
    subnetRouter?: {
      advertiseRoutes?: string[];
    };
    exitNode?: boolean;
  };
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      message?: string;
    }>;
    isExitNode?: boolean;
    subnetRoutes?: string[];
  };
}

interface TailscaleConnectorList {
  items: TailscaleConnector[];
}

const getTailscaleStatus: Tool = {
  name: 'get_tailscale_status',
  description: 'Get Tailscale connector status including exit node and routes',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const api = getCustomObjectsApi();

      let connectors: TailscaleConnector[] = [];
      try {
        const response = await api.listClusterCustomObject('tailscale.com', 'v1alpha1', 'connectors');
        const result = response.body as TailscaleConnectorList;
        connectors = result.items;
      } catch {
        // Tailscale CRDs may not be installed
      }

      const tailscalePods = await listPods('tailscale');

      const pods = tailscalePods.map((pod) => ({
        name: pod.metadata?.name,
        ready: pod.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
        phase: pod.status?.phase,
        nodeName: pod.spec?.nodeName,
      }));

      const connectorStatus = connectors.map((c) => {
        const readyCondition = c.status?.conditions?.find((cond) => cond.type === 'Ready');
        return {
          name: c.metadata.name,
          namespace: c.metadata.namespace,
          hostname: c.spec?.hostname,
          isExitNode: c.status?.isExitNode || c.spec?.exitNode || false,
          advertisedRoutes: c.spec?.subnetRouter?.advertiseRoutes || [],
          activeRoutes: c.status?.subnetRoutes || [],
          ready: readyCondition?.status === 'True',
          message: readyCondition?.message,
        };
      });

      return {
        connectors: connectorStatus,
        pods,
        summary: {
          totalConnectors: connectors.length,
          exitNodes: connectorStatus.filter((c) => c.isExitNode).length,
          healthyPods: pods.filter((p) => p.ready).length,
          totalPods: pods.length,
        },
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const tailscaleTools = [getTailscaleStatus];
