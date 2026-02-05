import type { Tool } from './index.js';
import { getCoreApi, getAppsApi } from '../clients/kubernetes.js';
import { validationError, k8sError } from '../utils/errors.js';
import * as k8s from '@kubernetes/client-node';

const DNS_1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const VALID_KINDS = ['deployment', 'statefulset', 'daemonset', 'pod', 'service', 'configmap'] as const;
type ResourceKind = typeof VALID_KINDS[number];

function sanitizeEnvVars(envVars: k8s.V1EnvVar[] | undefined): Array<{ name: string; value: string }> {
  if (!envVars) return [];
  return envVars.map((env) => {
    if (env.valueFrom?.secretKeyRef) {
      return { name: env.name, value: 'secret (redacted)' };
    }
    return { name: env.name, value: env.value ?? '(from configMap/field ref)' };
  });
}

function sanitizeEnvFrom(envFrom: k8s.V1EnvFromSource[] | undefined): Array<{ type: string; name: string }> {
  if (!envFrom) return [];
  return envFrom.map((source) => {
    if (source.secretRef) {
      return { type: 'secret (redacted)', name: source.secretRef.name ?? 'unknown' };
    }
    if (source.configMapRef) {
      return { type: 'configMap', name: source.configMapRef.name ?? 'unknown' };
    }
    return { type: 'unknown', name: 'unknown' };
  });
}

function sanitizeContainerSpec(container: k8s.V1Container): Record<string, unknown> {
  return {
    name: container.name,
    image: container.image,
    command: container.command,
    args: container.args,
    ports: container.ports?.map((p) => ({
      containerPort: p.containerPort,
      protocol: p.protocol,
      name: p.name,
    })),
    env: sanitizeEnvVars(container.env),
    envFrom: sanitizeEnvFrom(container.envFrom),
    resources: container.resources,
    volumeMounts: container.volumeMounts?.map((vm) => ({
      name: vm.name,
      mountPath: vm.mountPath,
      readOnly: vm.readOnly,
      subPath: vm.subPath,
    })),
    livenessProbe: summarizeProbe(container.livenessProbe),
    readinessProbe: summarizeProbe(container.readinessProbe),
    startupProbe: summarizeProbe(container.startupProbe),
  };
}

function summarizeProbe(probe: k8s.V1Probe | undefined): unknown {
  if (!probe) return undefined;
  const result: Record<string, unknown> = {};
  if (probe.httpGet) result.httpGet = `${probe.httpGet.scheme ?? 'HTTP'}://:${probe.httpGet.port}${probe.httpGet.path ?? '/'}`;
  if (probe.tcpSocket) result.tcpSocket = probe.tcpSocket.port;
  if (probe.exec) result.exec = probe.exec.command;
  if (probe.initialDelaySeconds) result.initialDelaySeconds = probe.initialDelaySeconds;
  if (probe.periodSeconds) result.periodSeconds = probe.periodSeconds;
  if (probe.timeoutSeconds) result.timeoutSeconds = probe.timeoutSeconds;
  if (probe.failureThreshold) result.failureThreshold = probe.failureThreshold;
  return result;
}

function sanitizeVolume(volume: k8s.V1Volume): Record<string, unknown> {
  const vol: Record<string, unknown> = { name: volume.name };
  if (volume.persistentVolumeClaim) vol.pvc = volume.persistentVolumeClaim.claimName;
  if (volume.nfs) vol.nfs = `${volume.nfs.server}:${volume.nfs.path}`;
  if (volume.configMap) vol.configMap = volume.configMap.name;
  if (volume.secret) vol.secret = '(redacted)';
  if (volume.emptyDir) vol.emptyDir = true;
  if (volume.hostPath) vol.hostPath = volume.hostPath.path;
  if (volume.projected) vol.projected = true;
  if (volume.downwardAPI) vol.downwardAPI = true;
  return vol;
}

// List mode helpers
function summarizeDeployment(d: k8s.V1Deployment): Record<string, unknown> {
  return {
    name: d.metadata?.name,
    replicas: d.spec?.replicas ?? 0,
    readyReplicas: d.status?.readyReplicas ?? 0,
    images: d.spec?.template?.spec?.containers?.map((c) => c.image) ?? [],
  };
}

function summarizeStatefulSet(s: k8s.V1StatefulSet): Record<string, unknown> {
  return {
    name: s.metadata?.name,
    replicas: s.spec?.replicas ?? 0,
    readyReplicas: s.status?.readyReplicas ?? 0,
    images: s.spec?.template?.spec?.containers?.map((c) => c.image) ?? [],
  };
}

function summarizeDaemonSet(ds: k8s.V1DaemonSet): Record<string, unknown> {
  return {
    name: ds.metadata?.name,
    desired: ds.status?.desiredNumberScheduled ?? 0,
    ready: ds.status?.numberReady ?? 0,
  };
}

function summarizePod(p: k8s.V1Pod): Record<string, unknown> {
  const containerStatuses = p.status?.containerStatuses ?? [];
  const readyCount = containerStatuses.filter((cs) => cs.ready).length;
  const totalCount = containerStatuses.length;
  const restarts = containerStatuses.reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0);
  return {
    name: p.metadata?.name,
    phase: p.status?.phase,
    ready: `${readyCount}/${totalCount}`,
    restarts,
    node: p.spec?.nodeName,
  };
}

function summarizeService(svc: k8s.V1Service): Record<string, unknown> {
  return {
    name: svc.metadata?.name,
    type: svc.spec?.type,
    clusterIP: svc.spec?.clusterIP,
    ports: svc.spec?.ports?.map((p) => ({
      port: p.port,
      targetPort: p.targetPort,
      protocol: p.protocol,
      name: p.name,
    })),
  };
}

function summarizeConfigMap(cm: k8s.V1ConfigMap): Record<string, unknown> {
  return {
    name: cm.metadata?.name,
    dataKeys: Object.keys(cm.data ?? {}),
  };
}

// Detail mode helpers
function detailPodSpec(podSpec: k8s.V1PodSpec | undefined): Record<string, unknown> | undefined {
  if (!podSpec) return undefined;
  return {
    containers: podSpec.containers.map(sanitizeContainerSpec),
    initContainers: podSpec.initContainers?.map(sanitizeContainerSpec),
    volumes: podSpec.volumes?.map(sanitizeVolume),
    nodeSelector: podSpec.nodeSelector,
    tolerations: podSpec.tolerations?.map((t) => ({
      key: t.key,
      operator: t.operator,
      value: t.value,
      effect: t.effect,
    })),
    serviceAccountName: podSpec.serviceAccountName,
    restartPolicy: podSpec.restartPolicy,
  };
}

function commonMeta(meta: k8s.V1ObjectMeta | undefined): Record<string, unknown> {
  return {
    name: meta?.name,
    namespace: meta?.namespace,
    labels: meta?.labels,
    annotations: meta?.annotations,
    creationTimestamp: meta?.creationTimestamp,
  };
}

async function listResources(kind: ResourceKind, namespace: string): Promise<Record<string, unknown>> {
  const coreApi = getCoreApi();
  const appsApi = getAppsApi();

  switch (kind) {
    case 'deployment': {
      const resp = await appsApi.listNamespacedDeployment(namespace);
      return { kind, namespace, items: resp.body.items.map(summarizeDeployment) };
    }
    case 'statefulset': {
      const resp = await appsApi.listNamespacedStatefulSet(namespace);
      return { kind, namespace, items: resp.body.items.map(summarizeStatefulSet) };
    }
    case 'daemonset': {
      const resp = await appsApi.listNamespacedDaemonSet(namespace);
      return { kind, namespace, items: resp.body.items.map(summarizeDaemonSet) };
    }
    case 'pod': {
      const resp = await coreApi.listNamespacedPod(namespace);
      return { kind, namespace, items: resp.body.items.map(summarizePod) };
    }
    case 'service': {
      const resp = await coreApi.listNamespacedService(namespace);
      return { kind, namespace, items: resp.body.items.map(summarizeService) };
    }
    case 'configmap': {
      const resp = await coreApi.listNamespacedConfigMap(namespace);
      return { kind, namespace, items: resp.body.items.map(summarizeConfigMap) };
    }
  }
}

async function getResourceDetail(kind: ResourceKind, namespace: string, name: string): Promise<Record<string, unknown>> {
  const coreApi = getCoreApi();
  const appsApi = getAppsApi();

  switch (kind) {
    case 'deployment': {
      const resp = await appsApi.readNamespacedDeployment(name, namespace);
      const d = resp.body;
      return {
        kind,
        ...commonMeta(d.metadata),
        replicas: d.spec?.replicas,
        readyReplicas: d.status?.readyReplicas,
        updatedReplicas: d.status?.updatedReplicas,
        availableReplicas: d.status?.availableReplicas,
        conditions: d.status?.conditions?.map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
        strategy: d.spec?.strategy?.type,
        ...detailPodSpec(d.spec?.template?.spec),
      };
    }
    case 'statefulset': {
      const resp = await appsApi.readNamespacedStatefulSet(name, namespace);
      const s = resp.body;
      return {
        kind,
        ...commonMeta(s.metadata),
        replicas: s.spec?.replicas,
        readyReplicas: s.status?.readyReplicas,
        currentReplicas: s.status?.currentReplicas,
        conditions: s.status?.conditions?.map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
        serviceName: s.spec?.serviceName,
        volumeClaimTemplates: s.spec?.volumeClaimTemplates?.map((v) => ({
          name: v.metadata?.name,
          storageClass: v.spec?.storageClassName,
          accessModes: v.spec?.accessModes,
          storage: v.spec?.resources?.requests?.['storage'],
        })),
        ...detailPodSpec(s.spec?.template?.spec),
      };
    }
    case 'daemonset': {
      const resp = await appsApi.readNamespacedDaemonSet(name, namespace);
      const ds = resp.body;
      return {
        kind,
        ...commonMeta(ds.metadata),
        desired: ds.status?.desiredNumberScheduled,
        ready: ds.status?.numberReady,
        available: ds.status?.numberAvailable,
        conditions: ds.status?.conditions?.map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
        ...detailPodSpec(ds.spec?.template?.spec),
      };
    }
    case 'pod': {
      const resp = await coreApi.readNamespacedPod(name, namespace);
      const p = resp.body;
      return {
        kind,
        ...commonMeta(p.metadata),
        phase: p.status?.phase,
        nodeName: p.spec?.nodeName,
        podIP: p.status?.podIP,
        hostIP: p.status?.hostIP,
        conditions: p.status?.conditions?.map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
        containerStatuses: p.status?.containerStatuses?.map((cs) => ({
          name: cs.name,
          ready: cs.ready,
          restartCount: cs.restartCount,
          state: cs.state,
        })),
        ...detailPodSpec(p.spec),
      };
    }
    case 'service': {
      const resp = await coreApi.readNamespacedService(name, namespace);
      const svc = resp.body;
      return {
        kind,
        ...commonMeta(svc.metadata),
        type: svc.spec?.type,
        clusterIP: svc.spec?.clusterIP,
        externalIPs: svc.spec?.externalIPs,
        ports: svc.spec?.ports?.map((p) => ({
          name: p.name,
          port: p.port,
          targetPort: p.targetPort,
          protocol: p.protocol,
          nodePort: p.nodePort,
        })),
        selector: svc.spec?.selector,
      };
    }
    case 'configmap': {
      const resp = await coreApi.readNamespacedConfigMap(name, namespace);
      const cm = resp.body;
      // Preview values (first 200 chars) to avoid dumping large configs
      const dataPreview: Record<string, string> = {};
      for (const [key, value] of Object.entries(cm.data ?? {})) {
        dataPreview[key] = value.length > 200 ? `${value.substring(0, 200)}... (${value.length} chars)` : value;
      }
      return {
        kind,
        ...commonMeta(cm.metadata),
        data: dataPreview,
        binaryDataKeys: Object.keys(cm.binaryData ?? {}),
      };
    }
  }
}

const describeResource: Tool = {
  name: 'describe_resource',
  description: 'Inspect Kubernetes resources. Without a name, lists all resources of that kind in a namespace. With a name, returns detailed spec including containers, volumes, probes, and status. Secret env values are redacted. Supported kinds: deployment, statefulset, daemonset, pod, service, configmap.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description: 'Resource kind',
        enum: [...VALID_KINDS],
      },
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      name: { type: 'string', description: 'Resource name (omit to list all of this kind in the namespace)' },
    },
    required: ['kind', 'namespace'],
  },
  handler: async (params) => {
    const kind = params.kind as string;
    const namespace = params.namespace as string;
    const name = params.name as string | undefined;

    if (!VALID_KINDS.includes(kind as ResourceKind)) {
      return validationError(`Invalid kind '${kind}'. Must be one of: ${VALID_KINDS.join(', ')}`);
    }
    if (!DNS_1123_RE.test(namespace)) {
      return validationError('Invalid namespace. Must match DNS-1123 format (lowercase alphanumeric and hyphens)');
    }
    if (name && !DNS_1123_RE.test(name) && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
      return validationError('Invalid resource name. Must match DNS-1123 format (lowercase alphanumeric and hyphens)');
    }

    try {
      if (name) {
        return await getResourceDetail(kind as ResourceKind, namespace, name);
      }
      return await listResources(kind as ResourceKind, namespace);
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const resourceTools = [describeResource];
