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

export interface Tool {
  name: string;
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
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const tool = toolMap.get(name);

  if (!tool) {
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
