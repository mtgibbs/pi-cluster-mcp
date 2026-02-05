import type { Tool } from './index.js';
import { getKubeConfig, getCoreApi } from '../clients/kubernetes.js';
import { validationError, k8sError } from '../utils/errors.js';
import * as k8s from '@kubernetes/client-node';

const DNS_1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

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

const getBackupStatus: Tool = {
  name: 'get_backup_status',
  description: 'Get backup CronJob status including schedules and last run times',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const kc = getKubeConfig();
      const batchApi = kc.makeApiClient(k8s.BatchV1Api);

      const response = await batchApi.listCronJobForAllNamespaces();

      const backupJobs = response.body.items
        .filter((cj: k8s.V1CronJob) =>
          cj.metadata?.name?.includes('backup') ||
          cj.metadata?.labels?.['app.kubernetes.io/component'] === 'backup'
        )
        .map((cj: k8s.V1CronJob) => ({
          name: cj.metadata?.name,
          namespace: cj.metadata?.namespace,
          schedule: cj.spec?.schedule,
          suspended: cj.spec?.suspend || false,
          lastScheduleTime: cj.status?.lastScheduleTime,
          lastSuccessfulTime: cj.status?.lastSuccessfulTime,
          activeJobs: cj.status?.active?.length || 0,
        }));

      return {
        cronJobs: backupJobs,
        summary: {
          total: backupJobs.length,
          suspended: backupJobs.filter((j: { suspended: boolean }) => j.suspended).length,
          active: backupJobs.filter((j: { activeJobs: number }) => j.activeJobs > 0).length,
        },
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const triggerBackup: Tool = {
  name: 'trigger_backup',
  description: 'Manually trigger a backup by creating a Job from a CronJob',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Kubernetes namespace' },
      cronjob: { type: 'string', description: 'CronJob name to create Job from' },
    },
    required: ['namespace', 'cronjob'],
  },
  handler: async (params) => {
    const namespace = params.namespace as string;
    const cronjobName = params.cronjob as string;

    try {
      const kc = getKubeConfig();
      const batchApi = kc.makeApiClient(k8s.BatchV1Api);

      const cronjobResp = await batchApi.readNamespacedCronJob(cronjobName, namespace);
      const cronjob = cronjobResp.body;

      const jobName = `${cronjobName}-manual-${Date.now()}`;

      const job: k8s.V1Job = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace,
          labels: {
            'job-origin': 'manual-trigger',
            'cronjob-name': cronjobName,
          },
        },
        spec: cronjob.spec?.jobTemplate?.spec,
      };

      await batchApi.createNamespacedJob(namespace, job);

      return {
        success: true,
        message: `Created backup job ${jobName} from CronJob ${cronjobName}`,
        jobName,
        namespace,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const getCronjobDetails: Tool = {
  name: 'get_cronjob_details',
  description: 'Get detailed information about a specific CronJob including schedule, job template, containers, volumes, and recent job history. Secret env values are redacted.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'CronJob namespace' },
      cronjob: { type: 'string', description: 'CronJob name' },
    },
    required: ['namespace', 'cronjob'],
  },
  handler: async (params) => {
    const namespace = params.namespace as string;
    const cronjobName = params.cronjob as string;

    if (!DNS_1123_RE.test(namespace)) {
      return validationError('Invalid namespace. Must match DNS-1123 format (lowercase alphanumeric and hyphens)');
    }
    if (!DNS_1123_RE.test(cronjobName)) {
      return validationError('Invalid cronjob name. Must match DNS-1123 format (lowercase alphanumeric and hyphens)');
    }

    try {
      const kc = getKubeConfig();
      const batchApi = kc.makeApiClient(k8s.BatchV1Api);

      const response = await batchApi.readNamespacedCronJob(cronjobName, namespace);
      const cj = response.body;

      const jobTemplate = cj.spec?.jobTemplate?.spec;
      const podSpec = jobTemplate?.template?.spec;

      const containers = (podSpec?.containers ?? []).map((c) => ({
        name: c.name,
        image: c.image,
        command: c.command,
        args: c.args,
        env: sanitizeEnvVars(c.env),
        envFrom: sanitizeEnvFrom(c.envFrom),
        volumeMounts: c.volumeMounts?.map((vm) => ({
          name: vm.name,
          mountPath: vm.mountPath,
          readOnly: vm.readOnly,
        })),
      }));

      const volumes = (podSpec?.volumes ?? []).map((v) => {
        const vol: Record<string, unknown> = { name: v.name };
        if (v.persistentVolumeClaim) vol.pvc = v.persistentVolumeClaim.claimName;
        if (v.nfs) vol.nfs = `${v.nfs.server}:${v.nfs.path}`;
        if (v.configMap) vol.configMap = v.configMap.name;
        if (v.secret) vol.secret = '(redacted)';
        if (v.emptyDir) vol.emptyDir = true;
        if (v.hostPath) vol.hostPath = v.hostPath.path;
        return vol;
      });

      return {
        name: cj.metadata?.name,
        namespace: cj.metadata?.namespace,
        schedule: cj.spec?.schedule,
        suspend: cj.spec?.suspend ?? false,
        concurrencyPolicy: cj.spec?.concurrencyPolicy,
        successfulJobsHistoryLimit: cj.spec?.successfulJobsHistoryLimit,
        failedJobsHistoryLimit: cj.spec?.failedJobsHistoryLimit,
        lastScheduleTime: cj.status?.lastScheduleTime,
        lastSuccessfulTime: cj.status?.lastSuccessfulTime,
        activeJobs: cj.status?.active?.length ?? 0,
        jobTemplate: {
          restartPolicy: podSpec?.restartPolicy,
          containers,
          volumes,
        },
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

const getJobLogs: Tool = {
  name: 'get_job_logs',
  description: 'Get logs from all pods belonging to a specific Job. Useful for checking backup job output or debugging failed jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Job namespace' },
      job: { type: 'string', description: 'Job name' },
      lines: { type: 'number', description: 'Number of log lines per pod (default: 100, max: 1000)', default: 100 },
    },
    required: ['namespace', 'job'],
  },
  handler: async (params) => {
    const namespace = params.namespace as string;
    const jobName = params.job as string;
    const lines = Math.min(Math.max((params.lines as number) || 100, 1), 1000);

    if (!DNS_1123_RE.test(namespace)) {
      return validationError('Invalid namespace. Must match DNS-1123 format (lowercase alphanumeric and hyphens)');
    }
    if (!DNS_1123_RE.test(jobName) && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(-\d+)?$/.test(jobName)) {
      return validationError('Invalid job name');
    }

    try {
      const api = getCoreApi();
      const podsResp = await api.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
      const pods = podsResp.body.items;

      const podLogs = await Promise.all(
        pods.map(async (pod) => {
          const podName = pod.metadata?.name ?? 'unknown';
          try {
            const logResp = await api.readNamespacedPodLog(podName, namespace, undefined, undefined, undefined, undefined, undefined, undefined, undefined, lines);
            return {
              pod: podName,
              phase: pod.status?.phase,
              logs: logResp.body ?? '',
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to read logs';
            return {
              pod: podName,
              phase: pod.status?.phase,
              logs: `(error: ${msg})`,
            };
          }
        })
      );

      return {
        namespace,
        job: jobName,
        podCount: pods.length,
        pods: podLogs,
      };
    } catch (error) {
      return k8sError(error);
    }
  },
};

export const backupTools = [getBackupStatus, triggerBackup, getCronjobDetails, getJobLogs];
