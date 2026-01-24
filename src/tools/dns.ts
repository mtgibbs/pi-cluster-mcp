import type { Tool } from './index.js';
import { listPods } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';

const getDnsStatus: Tool = {
  name: 'get_dns_status',
  description: 'Get Pi-hole and Unbound DNS service health',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const pods = await listPods('pihole');

      const piholePods = pods
        .filter((p) => p.metadata?.name?.includes('pihole'))
        .map((pod) => ({
          name: pod.metadata?.name,
          ready: pod.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
          phase: pod.status?.phase,
          restarts: pod.status?.containerStatuses?.[0]?.restartCount || 0,
        }));

      const unboundPods = pods
        .filter((p) => p.metadata?.name?.includes('unbound'))
        .map((pod) => ({
          name: pod.metadata?.name,
          ready: pod.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
          phase: pod.status?.phase,
          restarts: pod.status?.containerStatuses?.[0]?.restartCount || 0,
        }));

      return {
        pihole: piholePods,
        unbound: unboundPods,
        healthy: piholePods.every((p) => p.ready) && unboundPods.every((p) => p.ready),
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const testDnsQuery: Tool = {
  name: 'test_dns_query',
  description: 'Test DNS resolution through Pi-hole',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Domain to query' },
      type: { type: 'string', description: 'DNS record type (A, AAAA, MX, etc.)', default: 'A' },
    },
    required: ['domain'],
  },
  handler: (params) => {
    const domain = params.domain as string;
    const queryType = (params.type as string) || 'A';

    // TODO: Implement actual DNS query via pod exec
    return Promise.resolve({
      domain,
      type: queryType,
      message: 'DNS query implementation pending - requires pod exec capability',
    });
  },
};

export const dnsTools = [getDnsStatus, testDnsQuery];
