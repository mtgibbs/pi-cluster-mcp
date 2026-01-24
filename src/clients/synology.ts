import { NodeSSH } from 'node-ssh';

const NAS_HOST = process.env.NAS_HOST || '192.168.1.60';
const NAS_USER = process.env.NAS_USER || 'mcp';
const NAS_PRIVATE_KEY = process.env.NAS_PRIVATE_KEY;

let sshClient: NodeSSH | null = null;

async function getConnection(): Promise<NodeSSH> {
  if (sshClient && sshClient.isConnected()) {
    return sshClient;
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

export async function execCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  const ssh = await getConnection();
  const result = await ssh.execCommand(command);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function touchPath(path: string): Promise<void> {
  const safePath = path.replace(/[;&|`$]/g, '');
  await execCommand(`touch "${safePath}"`);
}

export async function checkPath(path: string): Promise<boolean> {
  const safePath = path.replace(/[;&|`$]/g, '');
  const result = await execCommand(`test -e "${safePath}" && echo "exists"`);
  return result.stdout.trim() === 'exists';
}

export function disconnect(): void {
  if (sshClient) {
    sshClient.dispose();
    sshClient = null;
  }
}
