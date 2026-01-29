import { getReadyPodOnNode, execInPod } from '../clients/kubernetes.js';

const DEBUG_AGENT_NAMESPACE = 'mcp-homelab';
const DEBUG_AGENT_LABEL = 'app.kubernetes.io/name=mcp-debug-agent';
const DEBUG_AGENT_CONTAINER = 'netshoot';

export async function execOnNode(
  node: string,
  command: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const pod = await getReadyPodOnNode(DEBUG_AGENT_NAMESPACE, DEBUG_AGENT_LABEL, node);

  if (!pod || !pod.metadata?.name) {
    throw new Error(`No ready debug-agent pod found on node '${node}'`);
  }

  return execInPod(DEBUG_AGENT_NAMESPACE, pod.metadata.name, DEBUG_AGENT_CONTAINER, command);
}
