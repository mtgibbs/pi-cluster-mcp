import type { Tool } from './index.js';
import { getCustomObjectsApi } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';

interface ExternalSecret {
  metadata: {
    name: string;
    namespace: string;
  };
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    refreshTime?: string;
    syncedResourceVersion?: string;
  };
}

interface ExternalSecretList {
  items: ExternalSecret[];
}

const getSecretsStatus: Tool = {
  name: 'get_secrets_status',
  description: 'Get External Secrets sync status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const api = getCustomObjectsApi();

      const response = await api.listClusterCustomObject('external-secrets.io', 'v1beta1', 'externalsecrets');
      const externalSecrets = response.body as ExternalSecretList;

      const secrets = externalSecrets.items.map((es) => {
        const readyCondition = es.status?.conditions?.find((c) => c.type === 'Ready');
        return {
          name: es.metadata.name,
          namespace: es.metadata.namespace,
          ready: readyCondition?.status === 'True',
          message: readyCondition?.message,
          lastRefresh: es.status?.refreshTime,
          syncedVersion: es.status?.syncedResourceVersion,
        };
      });

      const failedSecrets = secrets.filter((s) => !s.ready);

      return {
        externalSecrets: secrets,
        summary: {
          total: secrets.length,
          synced: secrets.filter((s) => s.ready).length,
          failed: failedSecrets.length,
        },
        failures: failedSecrets,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const refreshSecret: Tool = {
  name: 'refresh_secret',
  description: 'Force an ExternalSecret to resync from the secret store',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'ExternalSecret name' },
    },
    required: ['namespace', 'name'],
  },
  handler: async (params) => {
    const namespace = params.namespace as string;
    const name = params.name as string;

    try {
      const api = getCustomObjectsApi();
      const now = new Date().toISOString();

      const patch = {
        metadata: {
          annotations: {
            'force-sync': now,
          },
        },
      };

      await api.patchNamespacedCustomObject(
        'external-secrets.io', 'v1beta1', namespace, 'externalsecrets', name, patch,
        undefined, undefined, undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );

      return {
        success: true,
        message: `Triggered refresh of ExternalSecret ${namespace}/${name}`,
        requestedAt: now,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const secretsTools = [getSecretsStatus, refreshSecret];
