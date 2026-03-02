import type { Tool } from './index.js';
import { listPods, execInPod, getReadyPod, readPodLog } from '../clients/kubernetes.js';
import { getFullStats, getMessages, updateGravity, getWhitelist, getRecentQueries } from '../clients/pihole.js';
import { k8sError, notFoundError } from '../utils/errors.js';

const PIHOLE_NAMESPACE = 'pihole';
const PIHOLE_LABEL = 'app=pihole';
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

      // Fetch Pi-hole stats and diagnostics if requested and Pi-hole is healthy
      if (includeStats && piholePods.some((p) => p.ready)) {
        try {
          const [stats, messages] = await Promise.all([
            getFullStats(5),
            getMessages(),
          ]);
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
          if (messages.length > 0) {
            result.diagnostics = messages.map((msg) => ({
              type: msg.type,
              message: msg.message,
              details: [msg.blob1, msg.blob2, msg.blob3, msg.blob4, msg.blob5].filter((b) => b),
              timestamp: new Date(msg.timestamp * 1000).toISOString(),
            }));
          }
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
  description: 'Test DNS resolution by running dig against Pi-hole. Verify if internal/external DNS resolution is working from within the cluster.',
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

const updatePiholeGravity: Tool = {
  name: 'update_pihole_gravity',
  description: 'Trigger a Pi-hole gravity update to re-download blocklists and rebuild the database',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const output = await updateGravity();
      return {
        success: true,
        message: 'Gravity update triggered',
        output: output.trim(),
      };
    } catch (error) {
      return {
        error: true,
        code: 'PIHOLE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to update gravity',
      };
    }
  },
};

const getPiholeWhitelist: Tool = {
  name: 'get_pihole_whitelist',
  description: 'List all whitelisted domains in Pi-hole',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const entries = await getWhitelist();
      return {
        total: entries.length,
        domains: entries.map((e) => ({
          domain: e.domain,
          enabled: e.enabled === 1,
          comment: e.comment || undefined,
          type: e.type === 0 ? 'exact' : 'regex',
          addedAt: new Date(e.date_added * 1000).toISOString(),
        })),
      };
    } catch (error) {
      return {
        error: true,
        code: 'PIHOLE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to fetch whitelist',
      };
    }
  },
};

const getPiholeQueries: Tool = {
  name: 'get_pihole_queries',
  description: 'Get recent DNS queries from Pi-hole query log',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Number of recent queries to return (default: 50, max: 500)' },
    },
  },
  handler: async (params) => {
    const count = Math.min(Math.max((params.count as number) || 50, 1), 500);

    try {
      const queries = await getRecentQueries(count);
      return {
        total: queries.length,
        queries: queries.map((q) => ({
          timestamp: q[0] ? new Date(parseInt(q[0]) * 1000).toISOString() : undefined,
          type: q[1],
          domain: q[2],
          client: q[3],
          status: q[4],
        })),
      };
    } catch (error) {
      return {
        error: true,
        code: 'PIHOLE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to fetch queries',
      };
    }
  },
};

const diagnoseDns: Tool = {
  name: 'diagnose_dns',
  description:
    'Run a full DNS diagnostic for a domain, testing the complete resolution path: Pi-hole cache, Unbound primary, Unbound secondary, and checking for DNSSEC issues. Use this FIRST when a user reports a domain is unreachable.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Domain to diagnose' },
      type: {
        type: 'string',
        description: 'DNS record type (A, AAAA, MX, TXT, CNAME, NS)',
        default: 'A',
      },
    },
    required: ['domain'],
  },
  handler: async (params) => {
    const domain = params.domain as string;
    const queryType = ((params.type as string) || 'A').toUpperCase();

    // Validate query type
    const validTypes = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR'];
    if (!validTypes.includes(queryType)) {
      return {
        error: true,
        code: 'INVALID_TYPE',
        message: `Invalid DNS record type. Valid types: ${validTypes.join(', ')}`,
      };
    }

    // Validate domain format
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(domain)) {
      return {
        error: true,
        code: 'INVALID_DOMAIN',
        message: 'Invalid domain format',
      };
    }

    try {
      // Find a ready Pi-hole pod to run dig commands from
      const piholePod = await getReadyPod(PIHOLE_NAMESPACE, PIHOLE_LABEL);
      if (!piholePod || !piholePod.metadata?.name) {
        return notFoundError('Ready Pi-hole pod');
      }
      const podName = piholePod.metadata.name;

      // Helper to run dig and parse results
      const runDig = async (args: string[]) => {
        const result = await execInPod(PIHOLE_NAMESPACE, podName, PIHOLE_CONTAINER, ['dig', ...args]);
        const answers = result.stdout
          .trim()
          .split('\n')
          .filter((line: string) => line.length > 0);
        return {
          answers,
          resolved: answers.length > 0,
          exitCode: result.exitCode,
          stderr: result.stderr?.trim(),
        };
      };

      // Step 1: Query Pi-hole (may return cached result)
      const pihole = await runDig(['+short', '+time=5', '+tries=2', queryType, domain]);

      // Step 2: Query Unbound primary directly (bypass Pi-hole cache)
      const unboundPrimary = await runDig([
        '+short',
        '+time=5',
        '+tries=2',
        queryType,
        domain,
        '@unbound.pihole.svc.cluster.local',
        '-p',
        '5335',
      ]);

      // Step 3: Query Unbound secondary directly
      const unboundSecondary = await runDig([
        '+short',
        '+time=5',
        '+tries=2',
        queryType,
        domain,
        '@unbound-secondary.pihole.svc.cluster.local',
        '-p',
        '5335',
      ]);

      // Step 4: If either Unbound failed, test with DNSSEC checking disabled (+cd)
      let dnssecDiagnosis: Record<string, unknown> | null = null;
      if (!unboundPrimary.resolved || !unboundSecondary.resolved) {
        const primaryCd = !unboundPrimary.resolved
          ? await runDig([
              '+short',
              '+cd',
              '+time=5',
              '+tries=2',
              queryType,
              domain,
              '@unbound.pihole.svc.cluster.local',
              '-p',
              '5335',
            ])
          : null;
        const secondaryCd = !unboundSecondary.resolved
          ? await runDig([
              '+short',
              '+cd',
              '+time=5',
              '+tries=2',
              queryType,
              domain,
              '@unbound-secondary.pihole.svc.cluster.local',
              '-p',
              '5335',
            ])
          : null;

        const primaryDnssecIssue = primaryCd?.resolved === true;
        const secondaryDnssecIssue = secondaryCd?.resolved === true;

        dnssecDiagnosis = {
          primaryDnssecFailure: primaryDnssecIssue,
          secondaryDnssecFailure: secondaryDnssecIssue,
          ...(primaryCd && { primaryWithCdDisabled: primaryCd }),
          ...(secondaryCd && { secondaryWithCdDisabled: secondaryCd }),
        };
      }

      // Step 5: Fetch Unbound logs filtered for the queried domain
      let unboundLogs: Record<string, string[]> = {};
      try {
        const pods = await listPods(PIHOLE_NAMESPACE);
        const unboundPodList = pods.filter((p) => p.metadata?.name?.includes('unbound'));

        for (const pod of unboundPodList) {
          const name = pod.metadata?.name;
          if (!name) continue;
          try {
            const logText = await readPodLog(PIHOLE_NAMESPACE, name, { tailLines: 50 });
            const logs = logText.split('\n');
            const relevant = logs.filter((line: string) => line.toLowerCase().includes(domain.toLowerCase()));
            if (relevant.length > 0) {
              unboundLogs[name] = relevant;
            }
          } catch {
            /* pod may not be ready */
          }
        }
      } catch {
        /* non-critical — log retrieval failure should not block diagnosis */
      }

      // Build diagnosis summary
      const issues: string[] = [];
      if (pihole.resolved && !unboundPrimary.resolved && !unboundSecondary.resolved) {
        issues.push(
          'Pi-hole returned cached result but BOTH Unbounds are failing — stale cache masking upstream failure'
        );
      }
      if (!unboundPrimary.resolved) issues.push('Unbound primary SERVFAIL');
      if (!unboundSecondary.resolved) issues.push('Unbound secondary SERVFAIL');
      if (dnssecDiagnosis?.primaryDnssecFailure || dnssecDiagnosis?.secondaryDnssecFailure) {
        issues.push(
          'DNSSEC validation failure — domain resolves with checking disabled (+cd). Domain likely has broken DNSSEC. Fix: add domain-insecure exception to Unbound conf.d'
        );
      }
      if (issues.length === 0 && pihole.resolved) {
        issues.push('All resolution paths healthy');
      }

      return {
        domain,
        type: queryType,
        pihole: { ...pihole, note: 'May be cached (serve-expired: yes, TTL up to 24h)' },
        unboundPrimary,
        unboundSecondary,
        ...(dnssecDiagnosis && { dnssec: dnssecDiagnosis }),
        ...(Object.keys(unboundLogs).length > 0 && { unboundLogs }),
        diagnosis: issues,
        executedOn: podName,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const dnsTools = [getDnsStatus, testDnsQuery, diagnoseDns, updatePiholeGravity, getPiholeWhitelist, getPiholeQueries];
