import { describe, it, expect } from 'vitest';
import { tools } from '../tools/index.js';
import { isDeploymentAllowed, getAllowedDeployments } from '../utils/whitelist.js';

describe('tool registry', () => {
  it('registers all expected tools', () => {
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('get_cluster_health');
    expect(toolNames).toContain('restart_deployment');
    expect(toolNames).toContain('get_dns_status');
    expect(toolNames).toContain('test_dns_query');
    expect(toolNames).toContain('get_flux_status');
    expect(toolNames).toContain('reconcile_flux');
    expect(toolNames).toContain('get_certificate_status');
    expect(toolNames).toContain('get_secrets_status');
    expect(toolNames).toContain('refresh_secret');
    expect(toolNames).toContain('get_backup_status');
    expect(toolNames).toContain('trigger_backup');
    expect(toolNames).toContain('get_ingress_status');
    expect(toolNames).toContain('get_tailscale_status');
    expect(toolNames).toContain('get_media_status');
    expect(toolNames).toContain('fix_jellyfin_metadata');
    expect(toolNames).toContain('touch_nas_path');
    expect(toolNames).toContain('update_pihole_gravity');
    expect(toolNames).toContain('get_pihole_whitelist');
    expect(toolNames).toContain('get_pihole_queries');
  });

  it('has no duplicate tool names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have descriptions and input schemas', () => {
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.handler).toBeTypeOf('function');
    }
  });
});

describe('deployment whitelist', () => {
  it('allows whitelisted deployments', () => {
    expect(isDeploymentAllowed('jellyfin', 'jellyfin')).toBe(true);
    expect(isDeploymentAllowed('pihole', 'pihole')).toBe(true);
    expect(isDeploymentAllowed('pihole', 'unbound')).toBe(true);
    expect(isDeploymentAllowed('immich', 'immich-server')).toBe(true);
    expect(isDeploymentAllowed('homepage', 'homepage')).toBe(true);
    expect(isDeploymentAllowed('uptime-kuma', 'uptime-kuma')).toBe(true);
  });

  it('rejects non-whitelisted deployments', () => {
    expect(isDeploymentAllowed('kube-system', 'coredns')).toBe(false);
    expect(isDeploymentAllowed('default', 'anything')).toBe(false);
    expect(isDeploymentAllowed('jellyfin', 'wrong-name')).toBe(false);
  });

  it('returns all allowed deployments', () => {
    const allowed = getAllowedDeployments();
    expect(allowed).toHaveLength(6);
    expect(allowed).toContain('jellyfin/jellyfin');
  });
});
