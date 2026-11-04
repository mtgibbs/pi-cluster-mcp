// Deployments the agent may rolling-restart. A restart here is an idempotent
// annotation patch — it never mutates spec, data, or storage — but it IS a production
// action, so this list is opt-in and deliberately short.
//
// Everything below the divider is an APPLICATION. Restarting one degrades that app and
// nothing else. The infra entry above the divider is a considered exception, added after
// an incident where the inability to restart it cost 40 hours.
export const ALLOWED_DEPLOYMENTS = new Set([
  // --- infrastructure (blast radius beyond a single app — add sparingly) ---
  // external-secrets: added 2026-08-13. Its 1Password provider runs as an Extism/WASM
  // plugin whose client can wedge while the pod stays Running 1/1 with 0 restarts; a
  // rolling restart is the documented fix and a retry loop provably is not (only a new
  // process resets the WASM host memory). On 2026-08-11 this wedged and 53 of 56
  // ExternalSecrets stopped refreshing for 40+ hours, and remediation had to wait on a
  // human with kubectl. Restarting it does NOT touch materialised Secrets — they are
  // owned by the ExternalSecret CRs and survive the controller cycling.
  // See pi-cluster: docs/incidents/2026-08-11-eso-onepassword-wasm.md
  'external-secrets/external-secrets',
  //
  // NOT included, deliberately: the Flux controllers. Same "can wedge" argument applies,
  // but they are the mechanism by which every change reaches the cluster, so an agent
  // restarting them can mask or amplify a bad reconcile. That needs its own decision.
  //
  // --- applications ---
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
