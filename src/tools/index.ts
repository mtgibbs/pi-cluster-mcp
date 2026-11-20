import type { AuthScope } from '../auth.js';
import { clusterTools } from './cluster.js';
import { dnsTools } from './dns.js';
import { fluxTools } from './flux.js';
import { certificateTools } from './certificates.js';
import { secretsTools } from './secrets.js';
import { backupTools } from './backups.js';
import { ingressTools } from './ingress.js';
import { tailscaleTools } from './tailscale.js';
import { mediaTools } from './media.js';
import { networkingTools } from './networking.js';
import { logsTools } from './logs.js';
import { storageTools } from './storage.js';
import { resourceTools } from './resources.js';
import { bazarrTools } from './bazarr.js';
import { sonarrTools } from './sonarr.js';
import { radarrTools } from './radarr.js';
import { sabnzbdTools } from './sabnzbd.js';
import { arrSharedTools } from './arr-shared.js';
import { mealieTools } from './mealie.js';

export interface Tool {
  name: string;
  // true only if the tool changes nothing (cluster, NAS, apps, or third-party indexers). Required
  // so a new tool can't silently land in the read-only key's scope.
  readOnly: boolean;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export const tools: Tool[] = [
  ...clusterTools,
  ...dnsTools,
  ...fluxTools,
  ...certificateTools,
  ...secretsTools,
  ...backupTools,
  ...ingressTools,
  ...tailscaleTools,
  ...mediaTools,
  ...networkingTools,
  ...logsTools,
  ...storageTools,
  ...resourceTools,
  ...bazarrTools,
  ...sonarrTools,
  ...radarrTools,
  ...sabnzbdTools,
  ...arrSharedTools,
  ...mealieTools,
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

export function toolsForScope(scope: AuthScope): Tool[] {
  return scope === 'full' ? tools : tools.filter((t) => t.readOnly);
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  scope: AuthScope = 'full'
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const tool = toolMap.get(name);

  // Same answer as a nonexistent tool, so the read-only key can't probe for write tools.
  if (!tool || (scope === 'readonly' && !tool.readOnly)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: true, code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` }),
        },
      ],
    };
  }

  try {
    const result = await tool.handler(args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: true, code: 'HANDLER_ERROR', message }),
        },
      ],
    };
  }
}
