import type { Tool } from './index.js';
import { getCustomObjectsApi } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';

interface Certificate {
  metadata: {
    name: string;
    namespace: string;
  };
  spec: {
    dnsNames?: string[];
    secretName?: string;
  };
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    notAfter?: string;
    notBefore?: string;
    renewalTime?: string;
  };
}

interface CertificateList {
  items: Certificate[];
}

const getCertificateStatus: Tool = {
  name: 'get_certificate_status',
  description: 'Get TLS certificate status from cert-manager including expiry and pending challenges',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const api = getCustomObjectsApi();

      const response = await api.listClusterCustomObject('cert-manager.io', 'v1', 'certificates');
      const certificates = response.body as CertificateList;

      const certs = certificates.items.map((cert) => {
        const readyCondition = cert.status?.conditions?.find((c) => c.type === 'Ready');
        const notAfter = cert.status?.notAfter ? new Date(cert.status.notAfter) : null;
        const now = new Date();
        const daysUntilExpiry = notAfter
          ? Math.floor((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null;

        return {
          name: cert.metadata.name,
          namespace: cert.metadata.namespace,
          dnsNames: cert.spec.dnsNames,
          secretName: cert.spec.secretName,
          ready: readyCondition?.status === 'True',
          message: readyCondition?.message,
          notAfter: cert.status?.notAfter,
          daysUntilExpiry,
          renewalTime: cert.status?.renewalTime,
        };
      });

      const expiringCerts = certs.filter(
        (c) => c.daysUntilExpiry !== null && c.daysUntilExpiry < 30
      );

      const notReadyCerts = certs.filter((c) => !c.ready);

      return {
        certificates: certs,
        summary: {
          total: certs.length,
          ready: certs.filter((c) => c.ready).length,
          expiringSoon: expiringCerts.length,
          notReady: notReadyCerts.length,
        },
        warnings: {
          expiringSoon: expiringCerts,
          notReady: notReadyCerts,
        },
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const certificateTools = [getCertificateStatus];
