import type { Tool } from './index.js';
import { getCustomObjectsApi } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';

interface FluxResource {
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
  };
}

interface FluxListResponse {
  items: FluxResource[];
}

const getFluxStatus: Tool = {
  name: 'get_flux_status',
  description: 'Get Flux GitOps sync status for Kustomizations and HelmReleases',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const api = getCustomObjectsApi();

      const [kustomizationsResp, helmReleasesResp] = await Promise.all([
        api.listClusterCustomObject('kustomize.toolkit.fluxcd.io', 'v1', 'kustomizations'),
        api.listClusterCustomObject('helm.toolkit.fluxcd.io', 'v2', 'helmreleases'),
      ]);

      const kustomizations = kustomizationsResp.body as FluxListResponse;
      const helmReleases = helmReleasesResp.body as FluxListResponse;

      const formatResource = (r: FluxResource): { name: string; namespace: string; ready: boolean; message: string | undefined; lastTransition: string | undefined } => {
        const readyCondition = r.status?.conditions?.find((c) => c.type === 'Ready');
        return {
          name: r.metadata.name,
          namespace: r.metadata.namespace,
          ready: readyCondition?.status === 'True',
          message: readyCondition?.message,
          lastTransition: readyCondition?.lastTransitionTime,
        };
      };

      return {
        kustomizations: kustomizations.items.map(formatResource),
        helmReleases: helmReleases.items.map(formatResource),
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const reconcileFlux: Tool = {
  name: 'reconcile_flux',
  description: 'Trigger Flux reconciliation for a specific resource or all resources',
  inputSchema: {
    type: 'object',
    properties: {
      resource: {
        type: 'string',
        description: 'Resource to reconcile in format "type/namespace/name" (e.g., "kustomization/flux-system/cluster"). Omit to reconcile all.',
      },
    },
  },
  handler: async (params) => {
    const resource = params.resource as string | undefined;

    try {
      const api = getCustomObjectsApi();
      const now = new Date().toISOString();

      if (resource) {
        const [type, namespace, name] = resource.split('/');
        const plural = type === 'kustomization' ? 'kustomizations' : 'helmreleases';
        const group = type === 'kustomization'
          ? 'kustomize.toolkit.fluxcd.io'
          : 'helm.toolkit.fluxcd.io';
        const version = type === 'kustomization' ? 'v1' : 'v2';

        const patch = {
          metadata: {
            annotations: {
              'reconcile.fluxcd.io/requestedAt': now,
            },
          },
        };

        await api.patchNamespacedCustomObject(
          group, version, namespace, plural, name, patch,
          undefined, undefined, undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );

        return {
          success: true,
          message: `Triggered reconciliation of ${resource}`,
          requestedAt: now,
        };
      }

      // Reconcile all kustomizations
      const kustomizationsResp = await api.listClusterCustomObject(
        'kustomize.toolkit.fluxcd.io', 'v1', 'kustomizations'
      );
      const kustomizations = kustomizationsResp.body as FluxListResponse;

      const results = [];
      for (const ks of kustomizations.items) {
        const patch = {
          metadata: {
            annotations: {
              'reconcile.fluxcd.io/requestedAt': now,
            },
          },
        };

        await api.patchNamespacedCustomObject(
          'kustomize.toolkit.fluxcd.io', 'v1', ks.metadata.namespace, 'kustomizations', ks.metadata.name, patch,
          undefined, undefined, undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
        results.push(`${ks.metadata.namespace}/${ks.metadata.name}`);
      }

      return {
        success: true,
        message: `Triggered reconciliation of ${results.length} kustomizations`,
        reconciled: results,
        requestedAt: now,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const fluxTools = [getFluxStatus, reconcileFlux];
