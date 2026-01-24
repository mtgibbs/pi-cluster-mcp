import type { Tool } from './index.js';
import { getKubeConfig } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';
import * as k8s from '@kubernetes/client-node';

const getIngressStatus: Tool = {
  name: 'get_ingress_status',
  description: 'Get ingress status including hosts, TLS configuration, and backend health',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const kc = getKubeConfig();
      const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);

      const response = await networkingApi.listIngressForAllNamespaces();

      const ingressList = response.body.items.map((ing: k8s.V1Ingress) => {
        const hosts = ing.spec?.rules?.map((r: k8s.V1IngressRule) => r.host) || [];
        const tlsHosts = ing.spec?.tls?.flatMap((t: k8s.V1IngressTLS) => t.hosts || []) || [];

        return {
          name: ing.metadata?.name,
          namespace: ing.metadata?.namespace,
          hosts,
          tlsEnabled: tlsHosts.length > 0,
          tlsHosts,
          loadBalancer: ing.status?.loadBalancer?.ingress?.map((lb: k8s.V1LoadBalancerIngress) => lb.ip || lb.hostname),
          rules: ing.spec?.rules?.map((rule: k8s.V1IngressRule) => ({
            host: rule.host,
            paths: rule.http?.paths?.map((p: k8s.V1HTTPIngressPath) => ({
              path: p.path,
              pathType: p.pathType,
              backend: p.backend?.service?.name,
              port: p.backend?.service?.port?.number || p.backend?.service?.port?.name,
            })),
          })),
        };
      });

      return {
        ingresses: ingressList,
        summary: {
          total: ingressList.length,
          withTls: ingressList.filter((i) => i.tlsEnabled).length,
          uniqueHosts: [...new Set(ingressList.flatMap((i) => i.hosts).filter((h): h is string => !!h))],
        },
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const ingressTools = [getIngressStatus];
