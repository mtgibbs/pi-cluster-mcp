export const ALLOWED_DEPLOYMENTS = new Set([
  'jellyfin/jellyfin',
  'pihole/pihole',
  'pihole/unbound',
  'immich/immich-server',
  'homepage/homepage',
  'uptime-kuma/uptime-kuma',
]);

export function isDeploymentAllowed(namespace: string, name: string): boolean {
  const key = `${namespace}/${name}`;
  return ALLOWED_DEPLOYMENTS.has(key);
}

export function getAllowedDeployments(): string[] {
  return Array.from(ALLOWED_DEPLOYMENTS);
}
