export const ALLOWED_DEPLOYMENTS = new Set([
  'jellyfin/jellyfin',
  'pihole/pihole',
  'pihole/unbound',
  'pihole/pihole-secondary',
  'pihole/unbound-secondary',
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

// Opt-in label a CronJob must carry to be eligible for manual triggering via
// trigger_cronjob (and its trigger_backup alias). Adding it is the manifest
// author's attestation that the job is IDEMPOTENT and safe to run CONCURRENTLY,
// since a manual trigger bypasses the CronJob's concurrencyPolicy.
export const TRIGGERABLE_LABEL = 'homelab.mcp/triggerable';

export function isCronjobTriggerable(labels: Record<string, string> | undefined): boolean {
  return labels?.[TRIGGERABLE_LABEL] === 'true';
}
