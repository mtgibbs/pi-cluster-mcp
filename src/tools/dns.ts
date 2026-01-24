import type { Tool } from './index.js';
import { listPods, execInPod, getReadyPod } from '../clients/kubernetes.js';
import { getFullStats } from '../clients/pihole.js';
import { k8sError, notFoundError } from '../utils/errors.js';

const PIHOLE_NAMESPACE = 'pihole';
const PIHOLE_LABEL = 'app.kubernetes.io/name=pihole';
const PIHOLE_CONTAINER = 'pihole';

const getDnsStatus: Tool = {
  name: 'get_dns_status',
  description: 'Get Pi-hole and Unbound DNS service health including query statistics',
  inputSchema: {
    type: 'object',
    properties: {
      includeStats: { type: 'boolean', description: 'Include Pi-hole query statistics', default: true },
    },
  },
  handler: async (params) => {
    const includeStats = params.includeStats !== false;

    try {
      const pods = await listPods(PIHOLE_NAMESPACE);

      const piholePods = pods
        .filter((p) => p.metadata?.name?.includes('pihole') && !p.metadata?.name?.includes('unbound'))
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

      const result: Record<string, unknown> = {
        pihole: piholePods,
        unbound: unboundPods,
        healthy: piholePods.every((p) => p.ready) && unboundPods.every((p) => p.ready),
      };

      // Fetch Pi-hole stats if requested and Pi-hole is healthy
      if (includeStats && piholePods.some((p) => p.ready)) {
        try {
          const stats = await getFullStats(5);
          result.stats = {
            status: stats.summary.status,
            queriesToday: stats.summary.dns_queries_today,
            blockedToday: stats.summary.ads_blocked_today,
            blockedPercentage: stats.summary.ads_percentage_today,
            domainsBlocked: stats.summary.domains_being_blocked,
            uniqueDomains: stats.summary.unique_domains,
            queriesForwarded: stats.summary.queries_forwarded,
            queriesCached: stats.summary.queries_cached,
            uniqueClients: stats.summary.unique_clients,
            gravityUpdated: stats.summary.gravity_last_updated?.relative
              ? `${stats.summary.gravity_last_updated.relative.days}d ${stats.summary.gravity_last_updated.relative.hours}h ago`
              : 'unknown',
            topQueries: stats.topQueries,
            topBlocked: stats.topBlocked,
          };
        } catch (statsError) {
          result.statsError = statsError instanceof Error ? statsError.message : 'Failed to fetch Pi-hole stats';
        }
      }

      return result;
    } catch (error) {
      return k8sError(error);
    }
  },
};

const testDnsQuery: Tool = {
  name: 'test_dns_query',
  description: 'Test DNS resolution by running dig against Pi-hole',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Domain to query' },
      type: { type: 'string', description: 'DNS record type (A, AAAA, MX, TXT, CNAME, NS)', default: 'A' },
    },
    required: ['domain'],
  },
  handler: async (params) => {
    const domain = params.domain as string;
    const queryType = (params.type as string) || 'A';

    // Validate query type
    const validTypes = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR'];
    if (!validTypes.includes(queryType.toUpperCase())) {
      return {
        error: true,
        code: 'INVALID_TYPE',
        message: `Invalid DNS record type. Valid types: ${validTypes.join(', ')}`,
      };
    }

    // Validate domain (basic check)
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(domain)) {
      return {
        error: true,
        code: 'INVALID_DOMAIN',
        message: 'Invalid domain format',
      };
    }

    try {
      // Find a ready Pi-hole pod
      const piholePod = await getReadyPod(PIHOLE_NAMESPACE, PIHOLE_LABEL);

      if (!piholePod || !piholePod.metadata?.name) {
        return notFoundError('Ready Pi-hole pod');
      }

      // Run dig command
      const result = await execInPod(
        PIHOLE_NAMESPACE,
        piholePod.metadata.name,
        PIHOLE_CONTAINER,
        ['dig', '+short', '+time=5', '+tries=2', queryType.toUpperCase(), domain]
      );

      const answers = result.stdout.trim().split('\n').filter((line) => line.length > 0);

      return {
        domain,
        type: queryType.toUpperCase(),
        answers,
        resolved: answers.length > 0,
        executedOn: piholePod.metadata.name,
        exitCode: result.exitCode,
        ...(result.stderr && { stderr: result.stderr.trim() }),
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const dnsTools = [getDnsStatus, testDnsQuery];
