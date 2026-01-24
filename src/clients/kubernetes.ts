import * as k8s from '@kubernetes/client-node';

let coreApi: k8s.CoreV1Api;
let appsApi: k8s.AppsV1Api;
let customObjectsApi: k8s.CustomObjectsApi;
let metricsClient: k8s.Metrics;
let kc: k8s.KubeConfig;

export function initKubeClient(): void {
  kc = new k8s.KubeConfig();

  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }

  coreApi = kc.makeApiClient(k8s.CoreV1Api);
  appsApi = kc.makeApiClient(k8s.AppsV1Api);
  customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
  metricsClient = new k8s.Metrics(kc);
}

export function getKubeConfig(): k8s.KubeConfig {
  if (!kc) initKubeClient();
  return kc;
}

export function getCoreApi(): k8s.CoreV1Api {
  if (!coreApi) initKubeClient();
  return coreApi;
}

export function getAppsApi(): k8s.AppsV1Api {
  if (!appsApi) initKubeClient();
  return appsApi;
}

export function getCustomObjectsApi(): k8s.CustomObjectsApi {
  if (!customObjectsApi) initKubeClient();
  return customObjectsApi;
}

export function getMetricsClient(): k8s.Metrics {
  if (!metricsClient) initKubeClient();
  return metricsClient;
}

export async function listPods(namespace?: string): Promise<k8s.V1Pod[]> {
  const api = getCoreApi();
  const response = namespace
    ? await api.listNamespacedPod(namespace)
    : await api.listPodForAllNamespaces();
  return response.body.items;
}

export async function listNodes(): Promise<k8s.V1Node[]> {
  const api = getCoreApi();
  const response = await api.listNode();
  return response.body.items;
}

export async function listEvents(namespace?: string): Promise<k8s.CoreV1Event[]> {
  const api = getCoreApi();
  const response = namespace
    ? await api.listNamespacedEvent(namespace)
    : await api.listEventForAllNamespaces();
  return response.body.items;
}

export async function listDeployments(namespace?: string): Promise<k8s.V1Deployment[]> {
  const api = getAppsApi();
  const response = namespace
    ? await api.listNamespacedDeployment(namespace)
    : await api.listDeploymentForAllNamespaces();
  return response.body.items;
}

export async function patchDeployment(
  namespace: string,
  name: string,
  patch: object
): Promise<k8s.V1Deployment> {
  const api = getAppsApi();
  const options = { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } };
  const response = await api.patchNamespacedDeployment(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, options);
  return response.body;
}

export async function getCustomResource(
  group: string,
  version: string,
  plural: string,
  namespace?: string
): Promise<unknown> {
  const api = getCustomObjectsApi();
  if (namespace) {
    const response = await api.listNamespacedCustomObject(group, version, namespace, plural);
    return response.body;
  }
  const response = await api.listClusterCustomObject(group, version, plural);
  return response.body;
}
