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

function sanitizePath(path: string): string {
  // Strip shell metacharacters
  const sanitized = path.replace(/[;&|`$(){}!#]/g, '');

  // Reject path traversal
  if (sanitized.includes('..')) {
    throw new Error('Path traversal not allowed');
  }

  return sanitized;
}

function validatePath(path: string): void {
  if (ALLOWED_PATH_PREFIXES.length === 0) {
    throw new Error('NAS_ALLOWED_PATHS not configured, no paths are allowed');
  }

  const isAllowed = ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!isAllowed) {
    throw new Error(
      `Path not allowed. Must start with one of: ${ALLOWED_PATH_PREFIXES.join(', ')}`
    );
  }
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
  const safePath = sanitizePath(path);
  validatePath(safePath);
  await execCommand(`touch "${safePath}"`);
}

export async function checkPath(path: string): Promise<boolean> {
  const safePath = sanitizePath(path);
  validatePath(safePath);
  const result = await execCommand(`test -e "${safePath}" && echo "exists"`);
  return result.stdout.trim() === 'exists';
}

export async function listPath(path: string): Promise<string[]> {
  const safePath = sanitizePath(path);
  validatePath(safePath);
  const result = await execCommand(`ls -1 "${safePath}"`);
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
