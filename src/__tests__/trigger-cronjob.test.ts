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
const triggerCronjobTool = tools.find((t) => t.name === 'trigger_cronjob')!;
const triggerCronjob = triggerCronjobTool.handler;

const cronjob = (opts: { labelled?: boolean; activeRuns?: number } = {}): unknown => ({
  body: {
    metadata: { name: 'renovate', labels: opts.labelled === false ? {} : { 'homelab.mcp/triggerable': 'true' } },
    spec: { jobTemplate: { spec: { template: {} } } },
    status: { active: Array.from({ length: opts.activeRuns ?? 0 }, () => ({ name: 'scheduled' })) },
  },
});
const jobs = (...active: number[]): unknown => ({ body: { items: active.map((a) => ({ status: { active: a } })) } });

describe('trigger_cronjob gates', () => {
  beforeEach(() => {
    readCronJob.mockReset().mockResolvedValue(cronjob());
    listJobs.mockReset().mockResolvedValue(jobs());
    createJob.mockReset().mockResolvedValue({});
  });

  it('is declared as a mutating tool', () => {
    expect(triggerCronjobTool.readOnly).toBe(false);
  });

  it('rejects a namespace or cronjob name that is not DNS-1123 without touching the API', async () => {
    expect(await triggerCronjob({ namespace: '../etc', cronjob: 'renovate' })).toMatchObject({
      error: true,
      code: 'VALIDATION_ERROR',
    });
    expect(await triggerCronjob({ namespace: 'renovate', cronjob: 'Bad_Name' })).toMatchObject({
      error: true,
      code: 'VALIDATION_ERROR',
    });
    expect(readCronJob).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it('refuses a CronJob without the triggerable label', async () => {
    readCronJob.mockResolvedValue(cronjob({ labelled: false }));
    const res = await triggerCronjob({ namespace: 'renovate', cronjob: 'renovate' });
    expect(res).toMatchObject({ error: true, code: 'NOT_TRIGGERABLE' });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('refuses while a scheduled run is active', async () => {
    readCronJob.mockResolvedValue(cronjob({ activeRuns: 1 }));
    const res = await triggerCronjob({ namespace: 'renovate', cronjob: 'renovate' });
    expect(res).toMatchObject({ error: true, code: 'ALREADY_RUNNING' });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('refuses while an earlier manual run is active, but not for finished ones', async () => {
    listJobs.mockResolvedValue(jobs(0, 1));
    const res = await triggerCronjob({ namespace: 'renovate', cronjob: 'renovate' });
    expect(res).toMatchObject({ error: true, code: 'ALREADY_RUNNING' });
    expect(listJobs).toHaveBeenCalledWith('renovate', undefined, undefined, undefined, undefined, 'cronjob-name=renovate');
    expect(createJob).not.toHaveBeenCalled();
  });

  it('creates a Job in any namespace for an opted-in, idle CronJob', async () => {
    listJobs.mockResolvedValue(jobs(0, 0));
    const res = await triggerCronjob({ namespace: 'renovate', cronjob: 'renovate' });
    expect(res).toMatchObject({ success: true, namespace: 'renovate', cronjob: 'renovate' });
    expect(createJob).toHaveBeenCalledOnce();
  });
});
