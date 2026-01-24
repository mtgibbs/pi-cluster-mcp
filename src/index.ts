import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const transport = process.env.MCP_TRANSPORT || 'stdio';

async function main(): Promise<void> {
  const server = createServer();

  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error('MCP server running on stdio');
  } else {
    console.error(`Unknown transport: ${transport}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
