import { timingSafeEqual } from 'node:crypto';

// Which tools a caller may see and call. `full` is MCP_API_KEY (every tool); `readonly` is the
// optional MCP_READONLY_API_KEY, which only gets tools marked `readOnly: true`. The read-only key
// is safe to hand an agent without a human in the loop; the full key is not.
export type AuthScope = 'full' | 'readonly';

function keyMatches(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authenticate(headers: Record<string, string | string[] | undefined>): AuthScope | null {
  const fullKey = process.env.MCP_API_KEY;
  const readonlyKey = process.env.MCP_READONLY_API_KEY;

  if (!fullKey) {
    console.error('Error: MCP_API_KEY not set. Authentication failing securely.');
    return null;
  }

  const provided = headers['x-api-key'];
  if (typeof provided !== 'string' || provided.length === 0) return null;

  if (keyMatches(provided, fullKey)) return 'full';
  if (readonlyKey && readonlyKey !== fullKey && keyMatches(provided, readonlyKey)) return 'readonly';
  return null;
}

export function requireAuth(headers: Record<string, string | string[] | undefined>): AuthScope {
  const scope = authenticate(headers);
  if (!scope) {
    throw new Error('Unauthorized: Invalid or missing API key');
  }
  return scope;
}
