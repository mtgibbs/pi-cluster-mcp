import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';

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

const EXEC_TIMEOUT_MS = 30000; // 30 second timeout for exec

export async function execInPod(
  namespace: string,
  podName: string,
  container: string,
  command: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const kc = getKubeConfig();
  const exec = new k8s.Exec(kc);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`exec timed out after ${EXEC_TIMEOUT_MS}ms for ${namespace}/${podName}/${container}`));
      }
    }, EXEC_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timeout);
    };

    // Use passthrough streams that collect output
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    stdoutStream.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    stderrStream.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    exec.exec(
      namespace,
      podName,
      container,
      command,
      stdoutStream,
      stderrStream,
      null,
      false,
      (status: k8s.V1Status) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        const exitCode = status.status === 'Success' ? 0 : 1;
        resolve({ stdout, stderr, exitCode });
      }
    ).then((websocket) => {
      // Handle WebSocket events for better error detection
      if (websocket) {
        websocket.on('error', (err: Error) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          reject(new Error(`exec WebSocket error for ${namespace}/${podName}/${container}: ${err.message}`));
        });

        websocket.on('close', (code: number, reason: string) => {
          // If we haven't resolved yet and the connection closed, something went wrong
          if (!resolved && code !== 1000) {
            resolved = true;
            cleanup();
            reject(new Error(`exec WebSocket closed unexpectedly for ${namespace}/${podName}/${container}: code=${code} reason=${reason || 'unknown'}`));
          }
        });
      }
    }).catch((err) => {
      // DEBUG: Log raw error before transformation to diagnose WebSocket failures
      console.error(`[execInPod] Raw error for ${namespace}/${podName}/${container}:`, JSON.stringify(err, Object.getOwnPropertyNames(err || {}), 2));
      console.error(`[execInPod] Error type: ${typeof err}, constructor: ${err?.constructor?.name}`);

      if (resolved) return;
      resolved = true;
      cleanup();

      // Enhance error message with context
      // K8s client errors may be objects with nested structure, not Error instances
      let errMsg: string;
      if (err instanceof Error) {
        errMsg = err.message;
      } else if (err && typeof err === 'object') {
        // Check for empty object - common WebSocket failure mode
        const errObj = err as Record<string, unknown>;
        const keys = Object.keys(errObj);
        if (keys.length === 0) {
          errMsg = 'WebSocket connection failed (empty error - check network policies and RBAC)';
        } else {
          // K8s client often returns { response: { body: { message: '...' } } }
          const asRecord = err as Record<string, unknown>;
          if (asRecord.response && typeof asRecord.response === 'object') {
            const resp = asRecord.response as Record<string, unknown>;
            if (resp.body && typeof resp.body === 'object') {
              const body = resp.body as Record<string, unknown>;
              if (typeof body.message === 'string') {
                errMsg = body.message;
              } else {
                errMsg = JSON.stringify(resp.body);
              }
            } else if (typeof resp.body === 'string') {
              errMsg = resp.body;
            } else {
              errMsg = JSON.stringify(err);
            }
          } else if (asRecord.message) {
            errMsg = String(asRecord.message);
          } else {
            errMsg = JSON.stringify(err);
          }
        }
      } else {
        errMsg = String(err);
      }
      reject(new Error(`exec failed for ${namespace}/${podName}/${container}: ${errMsg}`));
    });
  });
}

export async function getReadyPod(namespace: string, labelSelector: string): Promise<k8s.V1Pod | null> {
  const api = getCoreApi();
  const response = await api.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);

  const readyPod = response.body.items.find((pod) =>
    pod.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True'
  );

  return readyPod || null;
}

export async function getReadyPodOnNode(
  namespace: string,
  labelSelector: string,
  nodeName: string
): Promise<k8s.V1Pod | null> {
  const api = getCoreApi();
  const response = await api.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);

  const pod = response.body.items.find(
    (p) =>
      p.spec?.nodeName === nodeName &&
      p.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True'
  );

  return pod || null;
}

export interface PodLogOptions {
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  previous?: boolean;
}

export async function readPodLog(
  namespace: string,
  podName: string,
  options: PodLogOptions = {}
): Promise<string> {
  const api = getCoreApi();
  const response = await api.readNamespacedPodLog(
    podName,
    namespace,
    options.container,
    undefined,
    undefined,
    undefined,
    undefined,
    options.previous,
    options.sinceSeconds,
    options.tailLines
  );
  // response.body can be undefined/null for empty logs
  return response.body ?? '';
}
