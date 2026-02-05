export const ALLOWED_DEPLOYMENTS = new Set([
  'jellyfin/jellyfin',
  'pihole/pihole',
  'pihole/unbound',
  'immich/immich-server',
  'homepage/homepage',
  'uptime-kuma/uptime-kuma',
  'media/lazylibrarian',
  'media/calibre-web',
  'media/sabnzbd',
  'media/prowlarr',
  'media/sonarr',
  'media/radarr',
  'media/qbittorrent',
  'media/bazarr',
  'media/readarr',
  'media/lidarr',
  'media/jellyseerr',
  'media/flaresolverr',
]);

export function isDeploymentAllowed(namespace: string, name: string): boolean {
  const key = `${namespace}/${name}`;
  return ALLOWED_DEPLOYMENTS.has(key);
}

export function getAllowedDeployments(): string[] {
  return Array.from(ALLOWED_DEPLOYMENTS);
}
