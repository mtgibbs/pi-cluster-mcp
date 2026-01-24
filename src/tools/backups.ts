import type { Tool } from './index.js';
import { getKubeConfig } from '../clients/kubernetes.js';
import { k8sError } from '../utils/errors.js';
import * as k8s from '@kubernetes/client-node';

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

export const backupTools = [getBackupStatus, triggerBackup];
