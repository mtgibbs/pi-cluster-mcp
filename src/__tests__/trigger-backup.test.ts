import { describe, it, expect, vi, beforeEach } from 'vitest';

const readCronJob = vi.fn();
const listJobs = vi.fn();
const createJob = vi.fn();
vi.mock('../clients/kubernetes.js', () => ({
  getKubeConfig: (): unknown => ({
    makeApiClient: (): unknown => ({
      readNamespacedCronJob: readCronJob,
      listNamespacedJob: listJobs,
      createNamespacedJob: createJob,
    }),
  }),
  getCoreApi: (): unknown => ({}),
}));

const { tools } = await import('../tools/index.js');
const triggerBackup = tools.find((t) => t.name === 'trigger_backup')!.handler;

const cronjob = (activeRuns = 0): unknown => ({
  body: {
    metadata: { name: 'pvc-backup' },
    spec: { jobTemplate: { spec: { template: {} } } },
    status: { active: Array.from({ length: activeRuns }, () => ({ name: 'scheduled' })) },
  },
});
const jobs = (...active: number[]): unknown => ({ body: { items: active.map((a) => ({ status: { active: a } })) } });

describe('trigger_backup gates', () => {
  beforeEach(() => {
    readCronJob.mockReset().mockResolvedValue(cronjob());
    listJobs.mockReset().mockResolvedValue(jobs());
    createJob.mockReset().mockResolvedValue({});
  });

  it('refuses a CronJob outside backup-jobs without touching the API', async () => {
    const res = await triggerBackup({ namespace: 'renovate', cronjob: 'renovate' });
    expect(res).toMatchObject({ error: true, code: 'NOT_ALLOWED' });
    expect(readCronJob).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it('rejects a cronjob name that is not DNS-1123', async () => {
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: '../etc' });
    expect(res).toMatchObject({ error: true, code: 'VALIDATION_ERROR' });
    expect(readCronJob).not.toHaveBeenCalled();
  });

  it('refuses while a scheduled run is active', async () => {
    readCronJob.mockResolvedValue(cronjob(1));
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: 'pvc-backup' });
    expect(res).toMatchObject({ error: true, code: 'ALREADY_RUNNING' });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('refuses while an earlier manual run is active, but not for finished ones', async () => {
    listJobs.mockResolvedValue(jobs(0, 1));
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: 'pvc-backup' });
    expect(res).toMatchObject({ error: true, code: 'ALREADY_RUNNING' });
    expect(listJobs).toHaveBeenCalledWith('backup-jobs', undefined, undefined, undefined, undefined, 'cronjob-name=pvc-backup');
    expect(createJob).not.toHaveBeenCalled();
  });

  it('creates a Job when nothing is running', async () => {
    listJobs.mockResolvedValue(jobs(0, 0));
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: 'pvc-backup' });
    expect(res).toMatchObject({ success: true, namespace: 'backup-jobs' });
    expect(createJob).toHaveBeenCalledOnce();
  });
});
