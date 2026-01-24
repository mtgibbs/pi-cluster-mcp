const API_KEY = process.env.MCP_API_KEY;

export function validateApiKey(providedKey: string | undefined): boolean {
  if (!API_KEY) {
    console.error('Warning: MCP_API_KEY not set, authentication disabled');
    return true;
  }

  return providedKey === API_KEY;
}

export function requireAuth(headers: Record<string, string>): void {
  const apiKey = headers['x-api-key'];

  if (!validateApiKey(apiKey)) {
    throw new Error('Unauthorized: Invalid or missing API key');
  }
}
