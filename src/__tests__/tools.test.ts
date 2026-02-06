import { describe, it, expect } from 'vitest';
import { tools } from '../tools/index.js';
import { isDeploymentAllowed, getAllowedDeployments } from '../utils/whitelist.js';
import { parseIptablesSave, parseConntrack, parsePing } from '../utils/parsers.js';

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
    // Networking diagnostic tools
    expect(toolNames).toContain('get_node_networking');
    expect(toolNames).toContain('get_iptables_rules');
    expect(toolNames).toContain('get_conntrack_entries');
    expect(toolNames).toContain('curl_ingress');
    expect(toolNames).toContain('test_pod_connectivity');
    // Log tools
    expect(toolNames).toContain('get_pod_logs');
    // Storage tools
    expect(toolNames).toContain('get_pvcs');
    // Resource inspection tools
    expect(toolNames).toContain('describe_resource');
    // CronJob/Job tools
    expect(toolNames).toContain('get_cronjob_details');
    expect(toolNames).toContain('get_job_logs');
    // Bazarr tools
    expect(toolNames).toContain('get_subtitle_status');
    expect(toolNames).toContain('get_subtitle_history');
    expect(toolNames).toContain('search_subtitles');
    // Sonarr tools
    expect(toolNames).toContain('get_sonarr_queue');
    expect(toolNames).toContain('get_sonarr_history');
    expect(toolNames).toContain('search_sonarr_episode');
    // Radarr tools
    expect(toolNames).toContain('get_radarr_queue');
    expect(toolNames).toContain('get_radarr_history');
    expect(toolNames).toContain('search_radarr_movie');
    // SABnzbd tools
    expect(toolNames).toContain('get_sabnzbd_queue');
    expect(toolNames).toContain('get_sabnzbd_history');
    expect(toolNames).toContain('retry_sabnzbd_download');
    expect(toolNames).toContain('pause_resume_sabnzbd');
    // Arr shared tools
    expect(toolNames).toContain('get_quality_profile');
    expect(toolNames).toContain('reject_and_search');
  });

  it('has the expected total tool count', () => {
    expect(tools).toHaveLength(44);
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
    expect(allowed).toHaveLength(18);
    expect(allowed).toContain('jellyfin/jellyfin');
    expect(allowed).toContain('media/sonarr');
    expect(allowed).toContain('media/radarr');
  });
});

describe('parsers', () => {
  describe('parseIptablesSave', () => {
    it('parses iptables-save output', () => {
      const input = `*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p tcp --dport 22 -j ACCEPT
-A FORWARD -i cni0 -j ACCEPT
COMMIT`;

      const result = parseIptablesSave(input);
      expect(result.table).toBe('filter');
      expect(result.chains).toHaveLength(3);

      const input_chain = result.chains.find((c) => c.name === 'INPUT');
      expect(input_chain?.policy).toBe('ACCEPT');
      expect(input_chain?.rules).toHaveLength(2);

      const forward_chain = result.chains.find((c) => c.name === 'FORWARD');
      expect(forward_chain?.policy).toBe('DROP');
      expect(forward_chain?.rules).toHaveLength(1);
    });
  });

  describe('parseConntrack', () => {
    it('parses conntrack output', () => {
      const input = `tcp      6 300 ESTABLISHED src=10.0.0.1 dst=10.0.0.2 sport=54321 dport=80 src=10.0.0.2 dst=10.0.0.1 sport=80 dport=54321 [ASSURED] mark=0 use=1
udp      17 30 src=10.0.0.1 dst=8.8.8.8 sport=12345 dport=53 src=8.8.8.8 dst=10.0.0.1 sport=53 dport=12345 [ASSURED] mark=0 use=1`;

      const entries = parseConntrack(input);
      expect(entries).toHaveLength(2);

      expect(entries[0].protocol).toBe('tcp');
      expect(entries[0].state).toBe('ESTABLISHED');
      expect(entries[0].src).toBe('10.0.0.1');
      expect(entries[0].dst).toBe('10.0.0.2');
      expect(entries[0].sport).toBe('54321');
      expect(entries[0].dport).toBe('80');
      expect(entries[0].replySrc).toBe('10.0.0.2');
      expect(entries[0].replyDst).toBe('10.0.0.1');

      expect(entries[1].protocol).toBe('udp');
      expect(entries[1].state).toBeNull();
      expect(entries[1].src).toBe('10.0.0.1');
      expect(entries[1].dst).toBe('8.8.8.8');
    });
  });

  describe('parsePing', () => {
    it('parses successful ping output', () => {
      const input = `PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.
64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.123 ms
64 bytes from 10.0.0.1: icmp_seq=2 ttl=64 time=0.456 ms
64 bytes from 10.0.0.1: icmp_seq=3 ttl=64 time=0.789 ms

--- 10.0.0.1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 0.123/0.456/0.789/0.272 ms`;

      const result = parsePing(input);
      expect(result.host).toBe('10.0.0.1');
      expect(result.transmitted).toBe(3);
      expect(result.received).toBe(3);
      expect(result.lossPercent).toBe(0);
      expect(result.rttMin).toBe(0.123);
      expect(result.rttAvg).toBe(0.456);
      expect(result.rttMax).toBe(0.789);
    });

    it('parses failed ping output', () => {
      const input = `PING 10.0.0.99 (10.0.0.99) 56(84) bytes of data.

--- 10.0.0.99 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2003ms`;

      const result = parsePing(input);
      expect(result.host).toBe('10.0.0.99');
      expect(result.transmitted).toBe(3);
      expect(result.received).toBe(0);
      expect(result.lossPercent).toBe(100);
      expect(result.rttMin).toBeNull();
      expect(result.rttAvg).toBeNull();
    });
  });
});
