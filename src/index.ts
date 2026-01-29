import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { createServer } from './server.js';
import { requireAuth } from './auth.js';

const transport = process.env.MCP_TRANSPORT || 'stdio';
const port = parseInt(process.env.MCP_PORT || '3000', 10);

async function main(): Promise<void> {
  if (transport === 'stdio') {
    const server = createServer();
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error('MCP server running on stdio');
  } else if (transport === 'http') {
    const app = express();
    app.use(express.json());

    // Health endpoint (no auth required)
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // Session management
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    // MCP endpoint handles GET (SSE stream), POST (messages), DELETE (close session)
    app.all('/mcp', async (req, res) => {
      // Auth check
      try {
        requireAuth(req.headers as Record<string, string>);
      } catch {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const sessionTransport = sessions.get(sessionId)!;
        await sessionTransport.handleRequest(req, res, req.body);
      } else if (!sessionId && req.method === 'POST') {
        // New session initialization
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: (): string => randomUUID(),
          onsessioninitialized: (sid: string): void => {
            sessions.set(sid, httpTransport);
            httpTransport.onclose = (): void => {
              sessions.delete(sid);
            };
          },
        });

        const server = createServer();
        await server.connect(httpTransport);
        await httpTransport.handleRequest(req, res, req.body);
      } else if (sessionId && req.method === 'POST') {
        // Stale session ID - create a new session instead of failing
        // This handles pod restarts gracefully
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: (): string => randomUUID(),
          onsessioninitialized: (sid: string): void => {
            sessions.set(sid, httpTransport);
            httpTransport.onclose = (): void => {
              sessions.delete(sid);
            };
          },
        });

        const server = createServer();
        await server.connect(httpTransport);
        await httpTransport.handleRequest(req, res, req.body);
      } else if (sessionId) {
        // Non-POST with stale session
        res.status(404).json({ error: 'Session not found' });
      } else {
        res.status(400).json({ error: 'Bad request' });
      }
    });

    app.listen(port, '0.0.0.0', () => {
      console.error(`MCP server running on http://0.0.0.0:${port}`);
    });
  } else {
    console.error(`Unknown transport: ${transport}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
