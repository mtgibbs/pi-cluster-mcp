import type { Tool } from './index.js';
import { getCoreApi } from '../clients/kubernetes.js';
import { validationError, k8sError } from '../utils/errors.js';

const DNS_1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const getPvcs: Tool = {
  name: 'get_pvcs',
  description: 'List PersistentVolumeClaims with status, capacity, storage class, and bound volume info. Useful for diagnosing storage issues like pending or lost PVCs.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to list PVCs from (omit for all namespaces)' },
    },
  },
  handler: async (params) => {
    const namespace = params.namespace as string | undefined;

    if (namespace && !DNS_1123_RE.test(namespace)) {
      return validationError('Invalid namespace. Must match DNS-1123 format (lowercase alphanumeric and hyphens)');
    }

    try {
      const api = getCoreApi();
      const response = namespace
        ? await api.listNamespacedPersistentVolumeClaim(namespace)
        : await api.listPersistentVolumeClaimForAllNamespaces();

      const pvcs = response.body.items.map((pvc) => ({
        name: pvc.metadata?.name,
        namespace: pvc.metadata?.namespace,
        status: pvc.status?.phase,
        capacity: pvc.status?.capacity?.['storage'],
        requestedCapacity: pvc.spec?.resources?.requests?.['storage'],
        accessModes: pvc.spec?.accessModes,
        storageClass: pvc.spec?.storageClassName,
        volumeName: pvc.spec?.volumeName,
        volumeMode: pvc.spec?.volumeMode,
        creationTimestamp: pvc.metadata?.creationTimestamp,
      }));

      const summary = {
        total: pvcs.length,
        bound: pvcs.filter((p) => p.status === 'Bound').length,
        pending: pvcs.filter((p) => p.status === 'Pending').length,
        lost: pvcs.filter((p) => p.status === 'Lost').length,
      };

      return { pvcs, summary };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const storageTools = [getPvcs];
