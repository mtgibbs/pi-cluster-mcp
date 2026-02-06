import type { Tool } from './index.js';
import * as sabnzbd from '../clients/sabnzbd.js';
import { validationError } from '../utils/errors.js';

const getSabnzbdQueue: Tool = {
  name: 'get_sabnzbd_queue',
  description: 'Get active download queue from SABnzbd showing item name, status, speed, ETA, category (books/tv/movies), size, and priority.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const response = await sabnzbd.getQueue();
      const queue = response.queue;

      return {
        status: queue.status,
        paused: queue.paused,
        speed: queue.speed,
        sizeLeft: queue.sizeleft,
        timeLeft: queue.timeleft,
        diskSpace: {
          primary: queue.diskspace1,
          secondary: queue.diskspace2,
        },
        itemCount: queue.noofslots,
        items: queue.slots.map((slot) => ({
          id: slot.nzo_id,
          filename: slot.filename,
          status: slot.status,
          category: slot.cat,
          size: `${slot.mb} MB`,
          sizeLeft: `${slot.mbleft} MB`,
          percentage: slot.percentage,
          timeLeft: slot.timeleft,
          eta: slot.eta,
          priority: slot.priority,
          age: slot.avg_age,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SABnzbd error';
      return { error: true, code: 'SABNZBD_ERROR', message };
    }
  },
};

const getSabnzbdHistory: Tool = {
  name: 'get_sabnzbd_history',
  description: 'Get completed and failed download history from SABnzbd. Shows category, final size, status, and failure reason if applicable.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Number of history items (default: 20, max: 50)', default: 20 },
    },
  },
  handler: async (params) => {
    const limit = Math.min(Math.max((params.limit as number) || 20, 1), 50);

    try {
      const response = await sabnzbd.getHistory(limit);
      const history = response.history;

      return {
        totalItems: history.noofslots,
        totalSize: history.total_size,
        weekSize: history.week_size,
        monthSize: history.month_size,
        items: history.slots.map((slot) => ({
          id: slot.nzo_id,
          name: slot.name,
          status: slot.status,
          category: slot.category,
          size: slot.size,
          completedTimestamp: slot.completed,
          failMessage: slot.fail_message || undefined,
          storage: slot.storage,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SABnzbd error';
      return { error: true, code: 'SABNZBD_ERROR', message };
    }
  },
};

const retrySabnzbdDownload: Tool = {
  name: 'retry_sabnzbd_download',
  description: 'Retry a failed download from SABnzbd history by its NZO ID.',
  inputSchema: {
    type: 'object',
    properties: {
      nzoId: { type: 'string', description: 'NZO ID of the failed download to retry' },
    },
    required: ['nzoId'],
  },
  handler: async (params) => {
    const nzoId = params.nzoId as string;

    if (!nzoId || typeof nzoId !== 'string') {
      return validationError('nzoId must be a non-empty string');
    }

    try {
      await sabnzbd.retryDownload(nzoId);
      return {
        success: true,
        message: `Retry triggered for download ${nzoId}`,
        nzoId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SABnzbd error';
      return { error: true, code: 'SABNZBD_ERROR', message };
    }
  },
};

const pauseResumeSabnzbd: Tool = {
  name: 'pause_resume_sabnzbd',
  description: 'Pause or resume the SABnzbd download queue. Can target the entire queue or a specific item.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['pause', 'resume'], description: 'Action to perform' },
      nzoId: { type: 'string', description: 'Optional: NZO ID of specific item to pause/resume. If omitted, affects entire queue.' },
    },
    required: ['action'],
  },
  handler: async (params) => {
    const action = params.action as 'pause' | 'resume';
    const nzoId = params.nzoId as string | undefined;

    if (!['pause', 'resume'].includes(action)) {
      return validationError('action must be "pause" or "resume"');
    }

    try {
      if (nzoId) {
        // Target specific item
        if (action === 'pause') {
          await sabnzbd.pauseItem(nzoId);
        } else {
          await sabnzbd.resumeItem(nzoId);
        }
        return {
          success: true,
          message: `${action === 'pause' ? 'Paused' : 'Resumed'} download ${nzoId}`,
          nzoId,
          action,
        };
      } else {
        // Target entire queue
        if (action === 'pause') {
          await sabnzbd.pauseQueue();
        } else {
          await sabnzbd.resumeQueue();
        }
        return {
          success: true,
          message: `${action === 'pause' ? 'Paused' : 'Resumed'} entire download queue`,
          action,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SABnzbd error';
      return { error: true, code: 'SABNZBD_ERROR', message };
    }
  },
};

export const sabnzbdTools = [getSabnzbdQueue, getSabnzbdHistory, retrySabnzbdDownload, pauseResumeSabnzbd];
