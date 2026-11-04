import { describe, it, expect, vi, beforeEach } from 'vitest';

const readCronJob = vi.fn();
const createJob = vi.fn();
vi.mock('../clients/kubernetes.js', () => ({
  getKubeConfig: (): unknown => ({
    makeApiClient: (): unknown => ({ readNamespacedCronJob: readCronJob, createNamespacedJob: createJob }),
  }),
  getCoreApi: (): unknown => ({}),
}));

const { tools } = await import('../tools/index.js');
const triggerBackup = tools.find((t) => t.name === 'trigger_backup')!.handler;

describe('trigger_backup scope gate', () => {
  beforeEach(() => {
    readCronJob.mockReset().mockResolvedValue({
      body: { metadata: { name: 'x' }, spec: { jobTemplate: { spec: { template: {} } } } },
    });
    createJob.mockReset().mockResolvedValue({});
  });

  it('refuses a CronJob outside backup-jobs without touching the API', async () => {
    const res = await triggerBackup({ namespace: 'renovate', cronjob: 'renovate' });
    expect(res).toMatchObject({ error: true, code: 'NOT_ALLOWED' });
    expect(readCronJob).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it('creates a Job from a CronJob in backup-jobs', async () => {
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: 'pvc-backup' });
    expect(res).toMatchObject({ success: true, namespace: 'backup-jobs' });
    expect(createJob).toHaveBeenCalledOnce();
  });

  it('rejects a cronjob name that is not DNS-1123', async () => {
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: '../etc' });
    expect(res).toMatchObject({ error: true, code: 'VALIDATION_ERROR' });
    expect(readCronJob).not.toHaveBeenCalled();
  });
});
