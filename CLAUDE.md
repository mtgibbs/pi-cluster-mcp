# Homelab MCP Server

## Project Goal
Build a Model Context Protocol (MCP) server that provides structured tools for Pi K3s cluster operations. This enables Claude (Desktop and CLI) to interact with the homelab using well-defined, safe operations instead of raw kubectl commands.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  Claude Desktop / CLI                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Streamable HTTP (HTTPS) / stdio
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   mcp-homelab (K3s Pod)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ MCP Server  │  │ K8s Client   │  │ SSH Client (NAS)  │  │
│  │(stdio/HTTP) │  │ (in-cluster) │  │ (node-ssh)        │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   Ingress (HTTP)      K8s API Server        Synology NAS
   mcp.lab.mtgibbs.dev (ServiceAccount)      (SSH @ 192.168.1.60)
```

## Tech Stack
- **Runtime**: Node.js 20+ with TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **K8s Client**: @kubernetes/client-node
- **SSH Client**: node-ssh (for Synology operations)
- **Container**: Docker multi-stage build
- **CI/CD**: GitHub Actions → GHCR

## Project Structure

```
homelab-mcp/
├── .github/
│   └── workflows/
│       ├── ci.yaml              # Lint, test, build
│       └── release.yaml         # Build + push container
├── src/
│   ├── index.ts                 # Entry point, transport setup
│   ├── server.ts                # MCP server definition
│   ├── auth.ts                  # API key validation middleware
│   ├── clients/
│   │   ├── kubernetes.ts        # K8s client wrapper
│   │   └── synology.ts          # SSH client for NAS
│   ├── tools/
│   │   ├── index.ts             # Tool registry
│   │   ├── cluster.ts           # get_cluster_health, restart_deployment
│   │   ├── dns.ts               # get_dns_status, test_dns_query
│   │   ├── flux.ts              # get_flux_status, reconcile_flux
│   │   ├── certificates.ts      # get_certificate_status
│   │   ├── secrets.ts           # get_secrets_status, refresh_secret
│   │   ├── backups.ts           # get_backup_status, trigger_backup
│   │   ├── ingress.ts           # get_ingress_status
│   │   ├── tailscale.ts         # get_tailscale_status
│   │   ├── media.ts             # get_media_status, fix_jellyfin_metadata
│   │   ├── networking.ts        # get_node_networking, get_iptables_rules, etc.
│   │   └── logs.ts              # get_pod_logs
│   └── utils/
│       ├── errors.ts            # Structured error responses
│       ├── whitelist.ts         # Allowed deployments for restart
│       ├── node-validation.ts   # Node name validation (cached)
│       ├── debug-agent.ts       # execOnNode() via DaemonSet
│       └── parsers.ts           # iptables, conntrack, ping parsers
├── k8s/
│   ├── namespace.yaml
│   ├── serviceaccount.yaml
│   ├── clusterrole.yaml
│   ├── clusterrolebinding.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── externalsecret.yaml
│   ├── debug-agent-daemonset.yaml  # Netshoot DaemonSet for node diagnostics
│   ├── debug-agent-role.yaml       # RBAC for exec into debug-agent pods
│   └── kustomization.yaml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .eslintrc.json
└── CLAUDE.md
```

## Security Model

### Defense in Depth
1. **Network**: Ingress only accessible via Tailscale
2. **Application**: API key required in `X-API-Key` header
3. **Kubernetes**: ServiceAccount with minimal RBAC
4. **Code**: Deployment whitelist enforced in implementation

### RBAC Permissions

**Read-Only Access:**
- Pods, Pods/Log, Services, Nodes, Events, ConfigMaps, PVCs, Namespaces
- Deployments, StatefulSets, DaemonSets
- Flux resources (Kustomizations, HelmReleases, Sources)
- Cert-manager resources (Certificates, Challenges)
- ExternalSecrets (status only, not secret values)
- Ingresses, Tailscale Connectors, Jobs/CronJobs
- Metrics (nodes, pods)

**Limited Actions:**
- `patch` deployments (for rollout restart) - whitelisted only
- `patch` Flux resources (for reconcile trigger)
- `patch` ExternalSecrets (for force refresh)
- `create` Jobs (for manual backup trigger)
- `create` pods/exec (Jellyfin, Pi-hole, and mcp-homelab namespaces)

**Explicitly NOT Allowed:**
- `delete` on any resource
- `create` pods/deployments/services
- Access to Secret values
- Node operations (cordon, drain)
- Namespace deletion

### Deployment Whitelist
Only these deployments can be restarted via `restart_deployment`:
- `jellyfin/jellyfin`
- `pihole/pihole`
- `pihole/unbound`
- `immich/immich-server`
- `homepage/homepage`
- `uptime-kuma/uptime-kuma`

### Exec Tools Security

The exec-based tools (`test_dns_query`, `curl_ingress`, `test_pod_connectivity`, `get_node_networking`, `get_iptables_rules`, `get_conntrack_entries`) run commands inside cluster pods via the K8s exec API. Security is maintained through multiple layers:

**Input Validation:**
| Tool | Validation |
|------|------------|
| `test_dns_query` | Domain: strict alphanumeric regex, Type: whitelist (A, AAAA, MX, etc.) |
| `curl_ingress` | URL parsed with `new URL()`, protocol must be http/https |
| `test_pod_connectivity` | IP/hostname regex, port: integer 1-65535 |
| `get_node_networking` | Node validated against actual cluster nodes |
| `get_iptables_rules` | Node validated, table whitelisted, chain regex |
| `get_conntrack_entries` | Node validated, filter: alphanumeric with dots/colons |

**Command Construction:**
All commands use array format (not shell strings), preventing injection:
```typescript
['dig', '+short', queryType, domain]  // Safe - no shell interpretation
```

**Threat Model - What Malicious Prompts CANNOT Do:**
- Run arbitrary commands (hardcoded command templates)
- Escape to shell (array format prevents metachar interpretation)
- Read/write files (no filesystem access)
- Modify iptables (only `iptables-save` for reading, not `iptables`)
- Delete K8s resources (no destructive operations)

**What Malicious Prompts COULD Do (by design):**
- Information gathering (network topology, firewall rules) - this is the intended purpose
- SSRF via curl_ingress - but that's the tool's explicit function
- DNS reconnaissance - limited by strict domain regex

### Debug-Agent Deployment Requirements

The debug-agent DaemonSet requires specific container capabilities to function:

```yaml
securityContext:
  privileged: false
  capabilities:
    drop: [ALL]
    add:
      - NET_ADMIN  # Required for: iptables-save, conntrack
      - NET_RAW    # Required for: ping
hostNetwork: true    # Required for: node network visibility
```

**Note:** `hostPID` and `privileged: true` are NOT required and should not be used.

### RBAC for Exec Tools

The `pods/exec` permission requires **both `create` and `get` verbs** for the WebSocket connection:

```yaml
rules:
  - apiGroups: [""]
    resources: [pods/exec]
    verbs: [create, get]  # Both required!
```

Namespace-scoped Roles are used to limit exec access to specific namespaces (pihole, jellyfin, mcp-homelab).

## Tools Reference

### Diagnostic Tools (Read-Only)

| Tool | Description | Returns |
|------|-------------|---------|
| `get_cluster_health` | Overall cluster status | Nodes, resource usage, problem pods, warning events |
| `get_dns_status` | Pi-hole + Unbound health | Pod status, blocked queries, upstream health, diagnostics |
| `get_pihole_whitelist` | Pi-hole whitelist | All whitelisted domains with type and status |
| `get_pihole_queries` | Pi-hole query log | Recent DNS queries with type, domain, client, status |
| `get_flux_status` | GitOps sync state | Kustomizations, HelmReleases with ready state |
| `get_certificate_status` | TLS cert health | Certs with ready state, expiry, pending challenges |
| `get_secrets_status` | External Secrets sync | Sync status, last refresh, errors |
| `get_backup_status` | Backup job status | CronJob schedules, last run, next run |
| `get_ingress_status` | Ingress health | Hosts, TLS status, backend health |
| `get_tailscale_status` | VPN connector status | Exit node, routes, connectivity |
| `get_media_status` | Media services health | Jellyfin/Immich pod status, NFS mounts |
| `get_node_networking` | Node network config | Interfaces, addresses, routes, routing rules (via ip -j) |
| `get_iptables_rules` | Firewall rules | iptables/ip6tables rules per table/chain on a node |
| `get_conntrack_entries` | Connection tracking | Active connections with NAT, states, marks |
| `get_pod_logs` | Pod log retrieval | Tail logs with container, time, and line filtering |

### Action Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `reconcile_flux` | `resource?` | Trigger Flux sync (all or specific) |
| `restart_deployment` | `namespace`, `deployment` | Rollout restart (whitelisted only) |
| `fix_jellyfin_metadata` | `name` | Find item in DB, trigger API refresh |
| `trigger_backup` | `job_name` | Create Job from CronJob |
| `test_dns_query` | `domain`, `type?` | Run dig against Pi-hole |
| `update_pihole_gravity` | — | Re-download blocklists and rebuild gravity DB |
| `refresh_secret` | `namespace`, `name` | Force ExternalSecret resync |
| `touch_nas_path` | `path` | SSH to Synology, touch path |
| `curl_ingress` | `url`, `timeout?`, `fromNode?` | Test HTTP(S) from within cluster |
| `test_pod_connectivity` | `sourceNode`, `target`, `port?` | Ping + TCP port check from a node |

## Secrets Required (1Password)

| Item | Field | Purpose |
|------|-------|---------|
| `mcp-homelab` | `api-key` | HTTP endpoint authentication |
| `mcp-homelab` | `nas-private-key` | SSH key for NAS operations |
| `mcp-homelab` | `jellyfin-api-key` | Jellyfin API for metadata refresh |
| `mcp-homelab` | `pihole-password` | Pi-hole v6 web password for API auth |
| `mcp-homelab` | `immich-api-key` | Immich API for media operations |

## Development

### Prerequisites
- Node.js 20+
- Docker
- kubectl configured for local testing
- Access to pi-cluster 1Password vault

### Local Testing (stdio mode)
```bash
npm install
npm run build
npm run dev  # Runs in stdio mode for CLI testing
```

### Container Build
```bash
docker build -t homelab-mcp:dev .
docker run -it --rm \
  -v ~/.kube/config:/root/.kube/config:ro \
  -e MCP_TRANSPORT=stdio \
  homelab-mcp:dev
```

### Deploy to Cluster
```bash
# From pi-cluster repo after MCP manifests are added
flux reconcile kustomization mcp-homelab
```

## CI/CD

### GitHub Actions Workflows

**ci.yaml** - On PR and push to main:
- Lint (ESLint)
- Type check (tsc)
- Build
- Unit tests

**release.yaml** - On tag push (v*):
- Build multi-arch container (arm64 + amd64)
- Push to ghcr.io/mtgibbs/homelab-mcp
- Create GitHub release

## Adding New Tools

1. Create tool implementation in `src/tools/<category>.ts`:
```typescript
export const myNewTool: Tool = {
  name: 'my_new_tool',
  description: 'What this tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'First param' }
    },
    required: ['param1']
  },
  handler: async (params) => {
    // Implementation
    return { result: 'data' };
  }
};
```

2. Register in `src/tools/index.ts`

3. If new K8s permissions needed:
   - Update `k8s/clusterrole.yaml`
   - Document in this file

4. Test locally before deploying

## Troubleshooting

### Pod won't start
- Check ServiceAccount exists: `kubectl get sa mcp-homelab -n mcp-homelab`
- Check RBAC: `kubectl auth can-i list pods --as=system:serviceaccount:mcp-homelab:mcp-homelab`
- Check secrets synced: `kubectl get externalsecrets -n mcp-homelab`

### HTTP connection fails
- Verify Tailscale connected
- Check API key in request header
- Check ingress: `kubectl describe ingress mcp-homelab -n mcp-homelab`
- Check cert: `kubectl get certificate -n mcp-homelab`

### Tool returns permission denied
- Check ClusterRole has required verb/resource
- Check ClusterRoleBinding references correct ServiceAccount
- For deployment restart, verify it's in the whitelist

### MCP tools return "Server not initialized"
This error means the client is using a stale session ID after the server restarted.

**Cause**: MCP Streamable HTTP uses sessions. When the server pod restarts (new deployment, crash, node migration), existing session IDs become invalid. The client may still be holding the old session ID.

**Solution**: Start a fresh Claude Code session (`claude` in a new terminal). The new session will perform proper initialization handshake.

**Note**: This is a client-side issue, not a server bug. If you see this after deploying a new version, don't assume the code is broken - test with a fresh session first.

### Tool returns "[object Object]" in error message
This indicates improper error serialization. K8s client errors are often plain objects, not Error instances.

**Pattern to avoid**:
```typescript
// BAD: String(err) returns "[object Object]" for objects
const msg = err instanceof Error ? err.message : String(err);
```

**Correct pattern**:
```typescript
// GOOD: Properly handle K8s error structure
if (err instanceof Error) {
  msg = err.message;
} else if (err && typeof err === 'object') {
  const asRecord = err as Record<string, unknown>;
  // K8s errors often have: { response: { body: { message: '...' } } }
  if (asRecord.response?.body?.message) {
    msg = asRecord.response.body.message;
  } else {
    msg = JSON.stringify(err);
  }
} else {
  msg = String(err);
}
```

## Coding Standards

### Error Handling

**K8s Client Errors**: The `@kubernetes/client-node` library throws objects with nested structure, not standard Error instances. Always check for:
- `err.response.body.message` - The actual error message from K8s API
- `err.statusCode` - HTTP status code
- `err.body` - Response body (may be string or object)

See `src/utils/errors.ts` for the canonical `k8sError()` helper.

**Never use `String(obj)`** for unknown error types - it returns `[object Object]`. Use `JSON.stringify()` for objects.

**Nullable responses**: K8s API responses can return `undefined` or `null` for empty results (e.g., empty logs). Always use nullish coalescing:
```typescript
return response.body ?? '';  // Not just response.body
```

### Testing After Deployment

When deploying a new version:
1. Wait for pod to become Ready
2. **Start a fresh Claude Code session** (critical for HTTP transport)
3. Test basic tools (`get_cluster_health`) before complex ones
4. Check pod logs if tools fail: `kubectl logs -n mcp-homelab deploy/mcp-homelab`

### Incident Reference: v0.1.8-v0.1.11 Regression

**Timeline**:
- v0.1.8: Added error handling improvements, appeared broken after deploy
- v0.1.9: Incorrectly reverted changes (misdiagnosed as code bug)
- v0.1.10: Re-applied changes, discovered actual bug: `String(err)` → `[object Object]`
- v0.1.11: Fixed with proper object serialization

**Lessons**:
1. "Server not initialized" after deploy = stale client session, not code bug
2. Always test with fresh Claude Code session after server restart
3. Never use `String()` for unknown error types
4. K8s errors need special handling - they're not Error instances
