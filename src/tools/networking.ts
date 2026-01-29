import type { Tool } from './index.js';
import { execOnNode } from '../utils/debug-agent.js';
import { validateNodeName } from '../utils/node-validation.js';
import { validationError, k8sError } from '../utils/errors.js';
import { parseIptablesSave, parseConntrack, parsePing } from '../utils/parsers.js';

const DNS_1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const getNodeNetworking: Tool = {
  name: 'get_node_networking',
  description: 'Get network interfaces, addresses, routes, and routing rules for a cluster node',
  inputSchema: {
    type: 'object',
    properties: {
      node: { type: 'string', description: 'Node name to inspect' },
    },
    required: ['node'],
  },
  handler: async (params) => {
    const node = params.node as string;

    const nodeError = await validateNodeName(node);
    if (nodeError) return validationError(nodeError);

    try {
      const separator = '---MCP_SEPARATOR---';
      const result = await execOnNode(node, [
        'sh', '-c',
        [
          'ip -j link show',
          `echo '${separator}'`,
          'ip -j addr show',
          `echo '${separator}'`,
          'ip -j route show',
          `echo '${separator}'`,
          'ip -j rule show',
        ].join(' && '),
      ]);

      const sections = result.stdout.split(separator).map((s) => s.trim());

      const parseSection = (section: string): unknown => {
        try {
          return JSON.parse(section);
        } catch {
          return section;
        }
      };

      return {
        node,
        interfaces: parseSection(sections[0] || '[]'),
        addresses: parseSection(sections[1] || '[]'),
        routes: parseSection(sections[2] || '[]'),
        rules: parseSection(sections[3] || '[]'),
        exitCode: result.exitCode,
        ...(result.stderr && { stderr: result.stderr.trim() }),
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const VALID_TABLES = ['filter', 'nat', 'mangle', 'raw'] as const;
const CHAIN_RE = /^[A-Z][A-Z0-9_-]*$/;

const getIptablesRules: Tool = {
  name: 'get_iptables_rules',
  description: 'Get iptables rules for a specific table on a cluster node',
  inputSchema: {
    type: 'object',
    properties: {
      node: { type: 'string', description: 'Node name to inspect' },
      table: {
        type: 'string',
        description: 'iptables table (filter, nat, mangle, raw)',
        enum: ['filter', 'nat', 'mangle', 'raw'],
        default: 'filter',
      },
      chain: { type: 'string', description: 'Filter to a specific chain (e.g. FORWARD, POSTROUTING)' },
      ipv6: { type: 'boolean', description: 'Use ip6tables instead of iptables', default: false },
    },
    required: ['node'],
  },
  handler: async (params) => {
    const node = params.node as string;
    const table = (params.table as string) || 'filter';
    const chain = params.chain as string | undefined;
    const ipv6 = params.ipv6 === true;

    const nodeError = await validateNodeName(node);
    if (nodeError) return validationError(nodeError);

    if (!VALID_TABLES.includes(table as typeof VALID_TABLES[number])) {
      return validationError(`Invalid table '${table}'. Valid tables: ${VALID_TABLES.join(', ')}`);
    }

    if (chain && !CHAIN_RE.test(chain)) {
      return validationError('Invalid chain name. Must match /^[A-Z][A-Z0-9_-]*$/');
    }

    try {
      const cmd = ipv6 ? 'ip6tables-save' : 'iptables-save';
      const result = await execOnNode(node, [cmd, '-t', table]);

      const parsed = parseIptablesSave(result.stdout);

      if (chain) {
        parsed.chains = parsed.chains.filter((c) => c.name === chain);
      }

      return {
        node,
        ipVersion: ipv6 ? 6 : 4,
        ...parsed,
        exitCode: result.exitCode,
        ...(result.stderr && { stderr: result.stderr.trim() }),
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const CONNTRACK_FILTER_RE = /^[a-zA-Z0-9.:/]+$/;

const getConntrackEntries: Tool = {
  name: 'get_conntrack_entries',
  description: 'Get connection tracking entries from a cluster node',
  inputSchema: {
    type: 'object',
    properties: {
      node: { type: 'string', description: 'Node name to inspect' },
      filter: { type: 'string', description: 'Filter by source or destination IP/CIDR' },
      limit: { type: 'number', description: 'Max entries to return (default: 50, max: 200)', default: 50 },
    },
    required: ['node'],
  },
  handler: async (params) => {
    const node = params.node as string;
    const filter = params.filter as string | undefined;
    const limit = Math.min(Math.max((params.limit as number) || 50, 1), 200);

    const nodeError = await validateNodeName(node);
    if (nodeError) return validationError(nodeError);

    if (filter && !CONNTRACK_FILTER_RE.test(filter)) {
      return validationError('Invalid filter. Must match /^[a-zA-Z0-9.:/]+$/');
    }

    try {
      const cmd: string[] = ['conntrack', '-L'];
      if (filter) {
        // Detect if it's likely a source or destination and use appropriate flag
        cmd.push('-s', filter);
      }

      const result = await execOnNode(node, cmd);
      let entries = parseConntrack(result.stdout);

      // If source filter returned nothing, try destination filter
      if (filter && entries.length === 0) {
        const retryResult = await execOnNode(node, ['conntrack', '-L', '-d', filter]);
        entries = parseConntrack(retryResult.stdout);
      }

      const truncated = entries.length > limit;
      entries = entries.slice(0, limit);

      return {
        node,
        total: entries.length,
        truncated,
        ...(filter && { filter }),
        entries,
        exitCode: result.exitCode,
        ...(result.stderr && !result.stderr.includes('conntrack ') && { stderr: result.stderr.trim() }),
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const curlIngress: Tool = {
  name: 'curl_ingress',
  description: 'Test HTTP(S) connectivity to an ingress URL from within the cluster',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to test (http or https)' },
      timeout: { type: 'number', description: 'Request timeout in seconds (default: 10, max: 30)', default: 10 },
      fromNode: { type: 'string', description: 'Specific node to curl from (optional, uses any node if omitted)' },
    },
    required: ['url'],
  },
  handler: async (params) => {
    const urlStr = params.url as string;
    const timeout = Math.min(Math.max((params.timeout as number) || 10, 1), 30);
    const fromNode = params.fromNode as string | undefined;

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      return validationError('Invalid URL format');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return validationError('URL scheme must be http or https');
    }

    if (fromNode) {
      const nodeError = await validateNodeName(fromNode);
      if (nodeError) return validationError(nodeError);
    }

    try {
      // Determine which node to use
      let targetNode = fromNode;
      if (!targetNode) {
        const { getValidNodeNames } = await import('../utils/node-validation.js');
        const nodes = await getValidNodeNames();
        if (nodes.length === 0) {
          return validationError('No cluster nodes available');
        }
        targetNode = nodes[0];
      }

      const writeFormat = JSON.stringify({
        statusCode: '%{http_code}',
        totalTime: '%{time_total}',
        dnsTime: '%{time_namelookup}',
        connectTime: '%{time_connect}',
        tlsTime: '%{time_appconnect}',
        startTransfer: '%{time_starttransfer}',
        remoteIp: '%{remote_ip}',
        remotePort: '%{remote_port}',
        sizeDownload: '%{size_download}',
      });

      const result = await execOnNode(targetNode, [
        'curl', '-sk', '-o', '/dev/null',
        '-w', writeFormat,
        '--max-time', timeout.toString(),
        urlStr,
      ]);

      // Parse curl -w output (values are strings, convert numbers)
      let curlData: Record<string, string> = {};
      try {
        curlData = JSON.parse(result.stdout.trim()) as Record<string, string>;
      } catch {
        return {
          url: urlStr,
          node: targetNode,
          error: true,
          code: 'CURL_PARSE_ERROR',
          message: 'Failed to parse curl output',
          rawOutput: result.stdout.trim(),
          stderr: result.stderr?.trim(),
        };
      }

      return {
        url: urlStr,
        node: targetNode,
        statusCode: parseInt(curlData.statusCode, 10) || 0,
        timing: {
          totalSeconds: parseFloat(curlData.totalTime) || 0,
          dnsSeconds: parseFloat(curlData.dnsTime) || 0,
          connectSeconds: parseFloat(curlData.connectTime) || 0,
          tlsSeconds: parseFloat(curlData.tlsTime) || 0,
          firstByteSeconds: parseFloat(curlData.startTransfer) || 0,
        },
        remote: {
          ip: curlData.remoteIp || null,
          port: parseInt(curlData.remotePort, 10) || null,
        },
        sizeBytes: parseInt(curlData.sizeDownload, 10) || 0,
        exitCode: result.exitCode,
        ...(result.stderr && { stderr: result.stderr.trim() }),
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

const testPodConnectivity: Tool = {
  name: 'test_pod_connectivity',
  description: 'Test network connectivity from a cluster node to a target using ping and optional port check',
  inputSchema: {
    type: 'object',
    properties: {
      sourceNode: { type: 'string', description: 'Node to test from' },
      target: { type: 'string', description: 'Target IP address or hostname' },
      port: { type: 'number', description: 'Port to test with TCP connection (optional)' },
    },
    required: ['sourceNode', 'target'],
  },
  handler: async (params) => {
    const sourceNode = params.sourceNode as string;
    const target = params.target as string;
    const port = params.port as number | undefined;

    const nodeError = await validateNodeName(sourceNode);
    if (nodeError) return validationError(nodeError);

    // Validate target
    if (!IP_RE.test(target) && !IPV6_RE.test(target) && !HOSTNAME_RE.test(target)) {
      return validationError('Invalid target. Must be an IP address or hostname');
    }

    if (!DNS_1123_RE.test(target) && !IP_RE.test(target) && !IPV6_RE.test(target)) {
      // Additional check: allow dotted hostnames
      if (!HOSTNAME_RE.test(target)) {
        return validationError('Invalid target format');
      }
    }

    if (port !== undefined && (port < 1 || port > 65535 || !Number.isInteger(port))) {
      return validationError('Port must be an integer between 1 and 65535');
    }

    try {
      // Run ping
      const pingResult = await execOnNode(sourceNode, [
        'ping', '-c', '3', '-W', '2', target,
      ]);

      const ping = parsePing(pingResult.stdout + pingResult.stderr);

      const response: Record<string, unknown> = {
        sourceNode,
        target,
        ping: {
          transmitted: ping.transmitted,
          received: ping.received,
          lossPercent: ping.lossPercent,
          rttMinMs: ping.rttMin,
          rttAvgMs: ping.rttAvg,
          rttMaxMs: ping.rttMax,
          reachable: ping.received > 0,
        },
      };

      // Optional TCP port check
      if (port !== undefined) {
        const ncResult = await execOnNode(sourceNode, [
          'nc', '-z', '-w', '3', target, port.toString(),
        ]);

        response.tcpConnect = {
          port,
          open: ncResult.exitCode === 0,
          ...(ncResult.stderr && { detail: ncResult.stderr.trim() }),
        };
      }

      return response;
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const networkingTools = [
  getNodeNetworking,
  getIptablesRules,
  getConntrackEntries,
  curlIngress,
  testPodConnectivity,
];
