import type { Tool } from './index.js';
import { readPodLog, listPods } from '../clients/kubernetes.js';
import { validationError, k8sError, notFoundError } from '../utils/errors.js';

const DNS_1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SINCE_RE = /^(\d+)(s|m|h|d)$/;
const MAX_LOG_BYTES = 50 * 1024; // 50KB

function parseSinceToSeconds(since: string): number | null {
  const match = since.match(SINCE_RE);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return null;
  }
}

const getPodLogs: Tool = {
  name: 'get_pod_logs',
  description: 'Get logs from a pod, with support for container selection, line limits, time filtering, and previous container logs. Essential for debugging application errors. Supports fuzzy matching for pod names.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Pod namespace' },
      pod: { type: 'string', description: 'Pod name (exact or prefix match)' },
      container: { type: 'string', description: 'Container name (optional, defaults to first container)' },
      lines: { type: 'number', description: 'Number of lines to return (default: 100, max: 1000)', default: 100 },
      since: { type: 'string', description: 'Show logs since duration (e.g. "5m", "1h", "30s")' },
      previous: { type: 'boolean', description: 'Get logs from previous container instance', default: false },
    },
    required: ['namespace', 'pod'],
  },
  handler: async (params) => {
    const namespace = params.namespace as string;
    const podInput = params.pod as string;
    const container = params.container as string | undefined;
    const lines = Math.min(Math.max((params.lines as number) || 100, 1), 1000);
    const since = params.since as string | undefined;
    const previous = params.previous === true;

    // Validate namespace
    if (!DNS_1123_RE.test(namespace)) {
      return validationError('Invalid namespace. Must match DNS-1123 format (lowercase alphanumeric and hyphens)');
    }

    // Validate since format
    let sinceSeconds: number | undefined;
    if (since) {
      const parsed = parseSinceToSeconds(since);
      if (parsed === null) {
        return validationError('Invalid since format. Use format like "30s", "5m", "1h", "2d"');
      }
      sinceSeconds = parsed;
    }

    try {
      // Find the pod — support prefix matching
      let podName = podInput;

      if (!DNS_1123_RE.test(podInput)) {
        // Try prefix match if it doesn't look like an exact pod name
        const pods = await listPods(namespace);
        const match = pods.find((p) => p.metadata?.name?.startsWith(podInput));
        if (!match || !match.metadata?.name) {
          return notFoundError(`Pod matching '${podInput}' in namespace '${namespace}'`);
        }
        podName = match.metadata.name;
      } else {
        // Even for valid names, check if it's a prefix
        const pods = await listPods(namespace);
        const exact = pods.find((p) => p.metadata?.name === podInput);
        if (!exact) {
          const prefix = pods.find((p) => p.metadata?.name?.startsWith(podInput));
          if (prefix?.metadata?.name) {
            podName = prefix.metadata.name;
          }
          // If neither found, try anyway — the K8s API will return a clear error
        }
      }

      const logText = await readPodLog(namespace, podName, {
        container,
        tailLines: lines,
        sinceSeconds,
        previous,
      });

      // Truncate to prevent response bloat
      let output = logText || '';
      let truncated = false;
      if (output.length > MAX_LOG_BYTES) {
        output = output.substring(output.length - MAX_LOG_BYTES);
        truncated = true;
      }

      const logLines = output.split('\n').filter((l) => l.length > 0);

      return {
        namespace,
        pod: podName,
        ...(container && { container }),
        ...(previous && { previous: true }),
        lineCount: logLines.length,
        truncated,
        logs: output,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const logsTools = [getPodLogs];
