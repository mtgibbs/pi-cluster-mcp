import { listNodes } from '../clients/kubernetes.js';

let cachedNodeNames: string[] = [];
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000;

async function refreshCache(): Promise<void> {
  const nodes = await listNodes();
  cachedNodeNames = nodes
    .map((n) => n.metadata?.name)
    .filter((name): name is string => !!name);
  cacheExpiry = Date.now() + CACHE_TTL_MS;
}

export async function getValidNodeNames(): Promise<string[]> {
  if (Date.now() > cacheExpiry) {
    await refreshCache();
  }
  return cachedNodeNames;
}

export async function validateNodeName(node: string): Promise<string | null> {
  const validNames = await getValidNodeNames();
  if (!validNames.includes(node)) {
    return `Invalid node '${node}'. Valid nodes: ${validNames.join(', ')}`;
  }
  return null;
}
