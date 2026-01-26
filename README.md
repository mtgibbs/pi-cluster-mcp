# homelab-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that provides structured tools for Pi K3s cluster operations. Enables Claude Desktop and Claude CLI to interact with a homelab using well-defined, safe operations instead of raw kubectl commands.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  Claude Desktop / CLI                         │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ Streamable HTTP (HTTPS) / stdio
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                   mcp-homelab (K3s Pod)                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ MCP Server  │  │ K8s Client   │  │ SSH Client (NAS)   │  │
│  │(stdio/HTTP) │  │ (in-cluster) │  │ (node-ssh)         │  │
│  └─────────────┘  └──────────────┘  └────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   Ingress (HTTP)      K8s API Server        Synology NAS
                       (ServiceAccount)      (SSH)
```

**Runtime:** Node.js 20+ with TypeScript
**MCP SDK:** @modelcontextprotocol/sdk
**K8s Client:** @kubernetes/client-node
**SSH Client:** node-ssh (Synology NAS operations)
**Container:** Multi-arch Docker image (amd64 + arm64)
**CI/CD:** GitHub Actions → GHCR

## Claude Desktop Setup

Add the server to your Claude Desktop configuration at **Settings > Developer > Edit Config** (`claude_desktop_config.json`):

### Remote (HTTP — server running in-cluster)

```json
{
  "mcpServers": {
    "homelab": {
      "url": "https://mcp.lab.mtgibbs.dev/mcp",
      "headers": {
        "X-API-Key": "<your-api-key>"
      }
    }
  }
}
```

### Local (stdio — running from source)

```json
{
  "mcpServers": {
    "homelab": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/pi-cluster-mcp"
    }
  }
}
```

Requires `npm run build` first and a kubeconfig with access to the cluster.

## Tools

The server exposes 19 tools across 9 categories. Each tool is defined with a name, description, JSON Schema input, and an async handler function.

### Diagnostic Tools (Read-Only)

#### `get_cluster_health`

Overall cluster status including nodes, resource usage, problem pods, and warning events.

**Parameters:** None

**Returns:** Node list with status/roles, total pod count, problem pods (not Running/Succeeded), recent warning events.

---

#### `get_dns_status`

Pi-hole and Unbound DNS service health including query statistics.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `includeStats` | boolean | no | `true` | Include Pi-hole query statistics (queries today, blocked count, top queries, top blocked) |

**Returns:** Pi-hole and Unbound pod status, overall health boolean. When stats enabled: queries today, blocked today, blocked percentage, domains on blocklist, top queries, top blocked domains. Also includes Pi-hole diagnostics (FTL warnings, rate-limited clients) when available.

---

#### `get_pihole_whitelist`

List all whitelisted domains in Pi-hole.

**Parameters:** None

**Returns:** Total count and list of whitelisted domains with enabled state, type (exact or regex), comment, and date added.

---

#### `get_pihole_queries`

Get recent DNS queries from Pi-hole query log.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `count` | number | no | `50` | Number of recent queries to return (max: 500) |

**Returns:** List of recent queries with timestamp, query type, domain, client, and status.

---

#### `get_flux_status`

Flux GitOps sync state for all Kustomizations and HelmReleases.

**Parameters:** None

**Returns:** List of Kustomizations and HelmReleases with ready state, status message, and last transition time.

---

#### `get_certificate_status`

TLS certificate health from cert-manager.

**Parameters:** None

**Returns:** All certificates with ready state, DNS names, expiry date, days until expiry, and renewal time. Summary with counts of total/ready/expiring soon/not ready. Warnings for certificates expiring within 30 days or not ready.

---

#### `get_secrets_status`

External Secrets Operator sync status.

**Parameters:** None

**Returns:** All ExternalSecrets with sync state, last refresh time, and synced version. Summary with total/synced/failed counts. List of any failed secrets.

---

#### `get_backup_status`

Backup CronJob status including schedules and last run times.

**Parameters:** None

**Returns:** CronJobs with schedule, suspended state, last schedule time, last successful time, and active job count.

---

#### `get_ingress_status`

Ingress configuration and health.

**Parameters:** None

**Returns:** All ingresses with hosts, TLS configuration, backend services, load balancer IPs, and routing rules.

---

#### `get_tailscale_status`

Tailscale VPN connector status.

**Parameters:** None

**Returns:** Connectors with hostname, exit node state, advertised/active routes, and readiness. Tailscale pods with health status. Gracefully handles missing Tailscale CRDs.

---

#### `get_media_status`

Media services health for Jellyfin and Immich.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `includeStats` | boolean | no | `true` | Include library statistics from Jellyfin and Immich APIs |

**Returns:** Pod status for both services including volume mounts. When stats enabled: Jellyfin library counts, active sessions, system info; Immich photo/video counts, storage usage, server version.

---

### Action Tools

#### `restart_deployment`

Rolling restart of a whitelisted deployment via annotation patch.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | yes | Kubernetes namespace |
| `deployment` | string | yes | Deployment name |

**Allowed deployments:**
- `jellyfin/jellyfin`
- `pihole/pihole`
- `pihole/unbound`
- `immich/immich-server`
- `homepage/homepage`
- `uptime-kuma/uptime-kuma`

Any deployment not on this list is rejected at the application layer regardless of RBAC permissions.

---

#### `test_dns_query`

Run a DNS lookup against Pi-hole by executing `dig` in a Pi-hole pod.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `domain` | string | yes | — | Domain to query |
| `type` | string | no | `A` | DNS record type: A, AAAA, MX, TXT, CNAME, NS, SOA, PTR |

**Returns:** Query answers, resolved boolean, which pod executed the query, exit code.

---

#### `update_pihole_gravity`

Trigger a Pi-hole gravity update to re-download blocklists and rebuild the database.

**Parameters:** None

**Returns:** Success status and gravity update output.

---

#### `reconcile_flux`

Trigger Flux reconciliation by annotating resources.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resource` | string | no | Resource in format `type/namespace/name` (e.g. `kustomization/flux-system/cluster`). Omit to reconcile all Kustomizations and HelmReleases. |

---

#### `refresh_secret`

Force an ExternalSecret to resync from the secret store.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | yes | Kubernetes namespace |
| `name` | string | yes | ExternalSecret name |

---

#### `trigger_backup`

Manually create a Job from a CronJob to run a backup immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | yes | Kubernetes namespace |
| `cronjob` | string | yes | CronJob name |

---

#### `fix_jellyfin_metadata`

Search for a media item in Jellyfin and trigger a metadata refresh via the Jellyfin API.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | no | Name of the media item to search for |
| `itemId` | string | no | Direct Jellyfin item ID (skips search) |
| `replaceAll` | boolean | no | Replace all existing metadata and images (default: false) |

Either `name` or `itemId` must be provided. If a search returns multiple matches, the tool returns the list of candidates instead of refreshing.

---

#### `touch_nas_path`

SSH to the Synology NAS and touch a file path to update its timestamp.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path on NAS. Must start with one of the configured allowed path prefixes. |

Path validation enforces an allowlist. Shell metacharacters are stripped and path traversal (`..`) is rejected.

## Adding New Tools

1. Create a tool file in `src/tools/` following the `Tool` interface:

```typescript
import { Tool } from './index.js';

const myTool: Tool = {
  name: 'my_tool',
  description: 'What this tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'First parameter' }
    },
    required: ['param1']
  },
  handler: async (params) => {
    const param1 = params.param1 as string;
    // implementation
    return { result: 'data' };
  }
};

export const myTools: Tool[] = [myTool];
```

2. Register in `src/tools/index.ts`:

```typescript
import { myTools } from './my-tool.js';

export const tools: Tool[] = [
  // ...existing tools
  ...myTools,
];
```

3. If new Kubernetes permissions are needed, update `k8s/clusterrole.yaml`.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_TRANSPORT` | no | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | no | `3000` | Port for HTTP transport |
| `MCP_API_KEY` | for HTTP | — | API key for HTTP endpoint authentication (`X-API-Key` header) |
| `NAS_HOST` | for NAS tools | — | Synology NAS IP/hostname |
| `NAS_USER` | for NAS tools | — | SSH username for NAS |
| `NAS_PRIVATE_KEY` | for NAS tools | — | SSH private key for NAS access |
| `NAS_ALLOWED_PATHS` | for NAS tools | — | Comma-separated list of allowed NAS path prefixes. If unset, all NAS path operations are rejected. |
| `JELLYFIN_URL` | no | `http://jellyfin.jellyfin:8096` | Jellyfin API URL |
| `JELLYFIN_API_KEY` | for media tools | — | Jellyfin API key |
| `PIHOLE_URL` | no | `http://pihole.pihole:80` | Pi-hole admin URL |
| `PIHOLE_API_TOKEN` | for DNS stats | — | Pi-hole API token |
| `IMMICH_URL` | no | `http://immich-server.immich:3001` | Immich API URL |
| `IMMICH_API_KEY` | for media stats | — | Immich API key (scopes: `server.about`, `server.statistics`, `server.storage`) |

### 1Password Setup

All secrets are stored in a single 1Password item named `mcp-homelab`. Create the item with these fields:

| Field | Description |
|-------|-------------|
| `api-key` | API key for authenticating HTTP connections |
| `nas-private-key` | Ed25519 SSH private key for Synology NAS access |
| `jellyfin-api-key` | Jellyfin API key (generate in Jellyfin Dashboard > API Keys) |
| `pihole-api-token` | Pi-hole API token (found in Pi-hole Admin > Settings > API) |
| `immich-api-key` | Immich API key with scoped permissions (generate in Immich > User Settings > API Keys) |

The `k8s/externalsecret.yaml` manifest syncs these fields into a Kubernetes secret `mcp-homelab-secrets` via the External Secrets Operator.

### Synology NAS Setup

1. Generate an SSH key:
   ```bash
   ssh-keygen -t ed25519 -C "cluster-mcp" -f ~/.ssh/mcp-synology
   ```

2. Create a user `cluster-mcp` on the Synology NAS with access only to the directories you want the MCP server to manage.

3. Add the public key to the NAS user:
   ```bash
   ssh admin@<NAS_IP>
   mkdir -p /var/services/homes/cluster-mcp/.ssh
   cat <<EOF > /var/services/homes/cluster-mcp/.ssh/authorized_keys
   <contents of ~/.ssh/mcp-synology.pub>
   EOF
   chmod 700 /var/services/homes/cluster-mcp/.ssh
   chmod 600 /var/services/homes/cluster-mcp/.ssh/authorized_keys
   chown -R cluster-mcp:users /var/services/homes/cluster-mcp/.ssh
   ```

4. Add the private key contents to the `nas-private-key` field in 1Password.

5. Set `NAS_ALLOWED_PATHS` in your deployment to restrict which paths the MCP server can operate on:
   ```
   /volume1/cluster/media,/volume1/cluster/photos,/volume1/cluster/backups
   ```

## Security Model

### Defense in Depth

1. **Network** — Ingress only accessible via Tailscale
2. **Authentication** — API key required in `X-API-Key` header for HTTP transport
3. **Kubernetes RBAC** — ServiceAccount with minimal permissions (read-only for most resources, limited write for specific operations)
4. **Application Layer** — Deployment restart whitelist enforced in code, NAS path allowlist enforced in code
5. **NAS Access** — Path sanitization (shell metacharacter stripping, traversal rejection), configurable path prefix allowlist, dedicated low-privilege SSH user

### RBAC Permissions

**Read-only:** Pods, Services, Nodes, Events, ConfigMaps, PVCs, Namespaces, Deployments, StatefulSets, DaemonSets, Ingresses, Flux resources, cert-manager resources, ExternalSecrets, Tailscale Connectors, Metrics

**Limited write:**
- `patch` Deployments — for rollout restart (application-level whitelist)
- `patch` Flux Kustomizations and HelmReleases — for reconcile trigger
- `patch` ExternalSecrets — for force refresh
- `create` Jobs — for manual backup trigger
- `create` pods/exec — scoped to `jellyfin` namespace only via RoleBinding

**Explicitly not allowed:** `delete` on any resource, `create` pods/deployments/services, access to Secret values, node operations (cordon, drain), namespace deletion.

## Development

### Prerequisites

- Node.js 20+
- Docker (for container builds)

### Local Development

```bash
npm install
npm run build
npm run dev          # stdio mode for CLI testing
```

### Run Tests

```bash
npm test             # single run
npm run test:watch   # watch mode
```

### Lint and Type Check

```bash
npm run lint
npm run typecheck
```

### Container Build

```bash
docker build -t homelab-mcp:dev .
docker run -it --rm \
  -v ~/.kube/config:/root/.kube/config:ro \
  -e MCP_TRANSPORT=stdio \
  homelab-mcp:dev
```

### Test MCP Handshake

With the container running, send a JSON-RPC initialize request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
```

Then list available tools:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

## Deployment

### Container Image

Published to GHCR on tagged releases:

```
ghcr.io/mtgibbs/pi-cluster-mcp:<version>
```

Multi-arch: `linux/amd64` and `linux/arm64`.

### Kubernetes Manifests

All manifests are in `k8s/` and managed by a `kustomization.yaml`:

| Manifest | Description |
|----------|-------------|
| `namespace.yaml` | `mcp-homelab` namespace |
| `serviceaccount.yaml` | ServiceAccount for the pod |
| `clusterrole.yaml` | RBAC permissions |
| `clusterrolebinding.yaml` | ClusterRoleBinding + jellyfin-scoped RoleBinding |
| `externalsecret.yaml` | 1Password secret sync |
| `deployment.yaml` | Pod spec with env vars, probes, security context |
| `service.yaml` | ClusterIP service on port 3000 |
| `ingress.yaml` | TLS ingress via cert-manager |

### Flux Integration

Add a Flux `GitRepository` source and `Kustomization` pointing to the `k8s/` directory in this repo, or copy the manifests into your cluster repo.

## CI/CD

**CI** (on PR and push to main): lint, typecheck, build, test
**Release** (on `v*` tag): multi-arch container build, push to GHCR, GitHub release with auto-generated notes
