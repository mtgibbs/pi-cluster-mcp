import type { Tool } from './index.js';
import { listNodes, listPods, listEvents, patchDeployment } from '../clients/kubernetes.js';
import { isDeploymentAllowed, getAllowedDeployments } from '../utils/whitelist.js';
import { notAllowedError, k8sError } from '../utils/errors.js';

const getClusterHealth: Tool = {
  name: 'get_cluster_health',
  description: 'Get overall cluster health including nodes, resource usage, problem pods, and warning events. Use this as a starting point to diagnose cluster issues.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const [nodes, pods, events] = await Promise.all([
        listNodes(),
        listPods(),
        listEvents(),
      ]);

      const nodeStatus = nodes.map((node) => ({
        name: node.metadata?.name,
        ready: node.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
        roles: Object.keys(node.metadata?.labels || {})
          .filter((l) => l.startsWith('node-role.kubernetes.io/'))
          .map((l) => l.replace('node-role.kubernetes.io/', '')),
      }));

      const problemPods = pods
        .filter((pod) => {
          const phase = pod.status?.phase;
          return phase !== 'Running' && phase !== 'Succeeded';
        })
        .map((pod) => ({
          namespace: pod.metadata?.namespace,
          name: pod.metadata?.name,
          phase: pod.status?.phase,
          reason: pod.status?.reason,
        }));

      const warningEvents = events
        .filter((e) => e.type === 'Warning')
        .slice(-20)
        .map((e) => ({
          namespace: e.metadata?.namespace,
          name: e.involvedObject?.name,
          reason: e.reason,
          message: e.message,
          lastTimestamp: e.lastTimestamp,
        }));

      return {
        nodes: nodeStatus,
        totalPods: pods.length,
        problemPods,
        recentWarnings: warningEvents,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const restartDeployment: Tool = {
  name: 'restart_deployment',
  description: `Perform a rolling restart of a whitelisted deployment. Use this to fix stuck pods or apply config changes manually. Allowed: ${getAllowedDeployments().join(', ')}`,
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      deployment: { type: 'string', description: 'Deployment name' },
    },
    required: ['namespace', 'deployment'],
  },
  handler: async (params) => {
    const namespace = params.namespace as string;
    const deployment = params.deployment as string;

    if (!isDeploymentAllowed(namespace, deployment)) {
      return notAllowedError(
        `Restarting ${namespace}/${deployment}. Allowed: ${getAllowedDeployments().join(', ')}`
      );
    }

    try {
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
              },
            },
          },
        },
      };

      await patchDeployment(namespace, deployment, patch);

      return {
        success: true,
        message: `Triggered rolling restart of ${namespace}/${deployment}`,
        restartedAt: patch.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'],
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const clusterTools = [getClusterHealth, restartDeployment];
