import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isCronjobTriggerable, TRIGGERABLE_LABEL } from '../utils/whitelist.js';

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

const cronjob = (labels?: Record<string, string>): unknown => ({
  body: { metadata: { name: 'pvc-backup', labels }, spec: { jobTemplate: { spec: { template: {} } } } },
});

describe('isCronjobTriggerable', () => {
  it('accepts only the exact opt-in label value', () => {
    expect(isCronjobTriggerable({ [TRIGGERABLE_LABEL]: 'true' })).toBe(true);
    expect(isCronjobTriggerable(undefined)).toBe(false);
    expect(isCronjobTriggerable({})).toBe(false);
    expect(isCronjobTriggerable({ [TRIGGERABLE_LABEL]: 'false' })).toBe(false);
    expect(isCronjobTriggerable({ [TRIGGERABLE_LABEL]: 'TRUE' })).toBe(false);
  });
});

describe('trigger_backup opt-in gate', () => {
  beforeEach(() => {
    readCronJob.mockReset();
    createJob.mockReset().mockResolvedValue({});
  });

  it('refuses a CronJob without the triggerable label and creates no Job', async () => {
    readCronJob.mockResolvedValue(cronjob({ app: 'renovate' }));
    const res = await triggerBackup({ namespace: 'renovate', cronjob: 'renovate' });
    expect(res).toMatchObject({ error: true, code: 'NOT_TRIGGERABLE' });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('creates a Job from a labelled CronJob', async () => {
    readCronJob.mockResolvedValue(cronjob({ [TRIGGERABLE_LABEL]: 'true' }));
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: 'pvc-backup' });
    expect(res).toMatchObject({ success: true, namespace: 'backup-jobs' });
    expect(createJob).toHaveBeenCalledOnce();
  });

  it('rejects names that are not DNS-1123 before calling the API', async () => {
    const res = await triggerBackup({ namespace: 'backup-jobs', cronjob: '../etc' });
    expect(res).toMatchObject({ error: true, code: 'VALIDATION_ERROR' });
    expect(readCronJob).not.toHaveBeenCalled();
  });
});
