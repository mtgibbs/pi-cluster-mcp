import { posix } from 'node:path';
import { NodeSSH } from 'node-ssh';

const NAS_HOST = process.env.NAS_HOST;
const NAS_USER = process.env.NAS_USER;
const NAS_PRIVATE_KEY = process.env.NAS_PRIVATE_KEY;

// Configurable via env: comma-separated list of allowed path prefixes
// Defaults to specific subdirectories, NOT the entire cluster share
const ALLOWED_PATH_PREFIXES = (process.env.NAS_ALLOWED_PATHS || '')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

if (ALLOWED_PATH_PREFIXES.length === 0) {
  // No paths configured = NAS touch operations disabled
  console.error('Warning: NAS_ALLOWED_PATHS not set, touch_nas_path will reject all paths');
}

let sshClient: NodeSSH | null = null;

async function getConnection(): Promise<NodeSSH> {
  if (sshClient && sshClient.isConnected()) {
    return sshClient;
  }

  if (!NAS_HOST) {
    throw new Error('NAS_HOST environment variable not set');
  }

  if (!NAS_USER) {
    throw new Error('NAS_USER environment variable not set');
  }

  if (!NAS_PRIVATE_KEY) {
    throw new Error('NAS_PRIVATE_KEY environment variable not set');
  }

  sshClient = new NodeSSH();
  await sshClient.connect({
    host: NAS_HOST,
    username: NAS_USER,
    privateKey: NAS_PRIVATE_KEY,
  });

  return sshClient;
}

// Rejects (never strips) anything that isn't a plain absolute path inside an allowed prefix.
// Stripping metacharacters left `"` and newlines through, which broke out of the quoted command.
export function validateNasPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) {
    throw new Error('Path must be a non-empty string of at most 1024 characters');
  }
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Path must not contain control characters');
  }
  if (!path.startsWith('/') || posix.normalize(path) !== path || path.split('/').includes('..')) {
    throw new Error('Path must be absolute and normalized (no "..", "." or "//" segments)');
  }

  if (ALLOWED_PATH_PREFIXES.length === 0) {
    throw new Error('NAS_ALLOWED_PATHS not configured, no paths are allowed');
  }
  // Whole-segment match: /volume1/media must not admit /volume1/media-private.
  const isAllowed = ALLOWED_PATH_PREFIXES.some((prefix) => {
    const base = prefix.replace(/\/+$/, '');
    return path === base || path.startsWith(`${base}/`);
  });
  if (!isAllowed) {
    throw new Error(
      `Path not allowed. Must be inside one of: ${ALLOWED_PATH_PREFIXES.join(', ')}`
    );
  }
  return path;
}

// POSIX single-quote escaping: nothing inside '...' is special to the shell except ' itself.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function execCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  const ssh = await getConnection();
  const result = await ssh.execCommand(command);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function touchPath(path: string): Promise<void> {
  const safePath = validateNasPath(path);
  await execCommand(`touch -- ${shellQuote(safePath)}`);
}

export async function checkPath(path: string): Promise<boolean> {
  const safePath = validateNasPath(path);
  const result = await execCommand(`test -e ${shellQuote(safePath)} && echo exists`);
  return result.stdout.trim() === 'exists';
}

export async function listPath(path: string): Promise<string[]> {
  const safePath = validateNasPath(path);
  const result = await execCommand(`ls -1 -- ${shellQuote(safePath)}`);
  return result.stdout.trim().split('\n').filter((line) => line.length > 0);
}

export function getAllowedPaths(): string[] {
  return [...ALLOWED_PATH_PREFIXES];
}

export function disconnect(): void {
  if (sshClient) {
    sshClient.dispose();
    sshClient = null;
  }
}
