# Homelab MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server designed for managing a Kubernetes-based homelab (specifically a Raspberry Pi K3s cluster). 

This server provides a safe, structured interface for LLMs (like Claude) to interact with your cluster, media services, and network infrastructure without giving them raw `kubectl` access or unrestricted SSH capabilities.

## 🚀 Features

### Kubernetes Operations
- **Health Checks:** Monitor nodes, resource usage, and problem pods.
- **Resource Inspection:** List and describe deployments, statefulsets, daemonsets, pods, services, and configmaps with full spec details.
- **Storage:** Inspect PersistentVolumeClaims with status, capacity, and storage class info.
- **Safe Restarts:** Trigger rolling restarts for whitelisted deployments (e.g., Jellyfin, Pi-hole, media stack).
- **Backups:** Check CronJob status, inspect detailed job specs, retrieve job pod logs, and manually trigger backup jobs.
- **GitOps:** Monitor Flux Kustomizations/HelmReleases and trigger reconciliation.
- **Secrets:** View External Secrets sync status and force refreshes (1Password integration).

### Network & DNS (Pi-hole/Unbound)
- **Status:** Check health of DNS services.
- **Diagnostics:** View blocked query stats, top blocked domains, and recent query logs.
- **Testing:** Run `dig` commands from within the cluster to verify resolution.
- **Management:** View whitelist and trigger Gravity updates.

### Media Services (Jellyfin/Immich)
- **Health:** Monitor pod status for media applications.
- **Stats:** detailed library statistics and active session monitoring.
- **Management:** Search media libraries and trigger metadata refreshes for specific items.

### Network Diagnostics
- **Node Networking:** Inspect interfaces, addresses, routes, and routing rules on any cluster node.
- **Firewall Rules:** Dump iptables/ip6tables rules by table and chain.
- **Connection Tracking:** View conntrack entries with source/destination filtering.
- **Ingress Testing:** Curl ingress URLs from within the cluster with detailed timing.
- **Connectivity Testing:** Ping and TCP port checks between nodes and targets.
- **Pod Logs:** Retrieve pod logs with container, time range, and line count filtering.

### Infrastructure
- **Certificates:** Monitor cert-manager certificate expiry and readiness.
- **NAS Integration:** Securely touch specific paths on a Synology NAS (via SSH) to trigger file system events.
- **Tailscale:** Monitor VPN connector status.

## 🔒 Security Model

This project is built with a "defense in depth" approach:

1.  **Least Privilege:** Runs with a dedicated ServiceAccount.
    -   **Read-Only:** Most resources (Pods, Events, Flux, Certs).
    -   **Scoped Action:** `patch` is strictly limited to whitelisted deployments and Flux resources.
    -   **Scoped Exec:** `pod/exec` is strictly limited to `jellyfin`, `pihole`, and `mcp-homelab` (debug-agent) namespaces via specific Roles.
2.  **Input Validation:** Strict validation on all tool inputs (especially for file paths and resource names).
3.  **Authentication:** Requires `X-API-Key` header for all requests.
4.  **Network:** Designed to run behind an Ingress accessible only via Tailscale.

## 🛠️ Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `MCP_API_KEY` | Secret key for authenticating requests | Yes |
| `MCP_TRANSPORT` | `stdio` (default) or `sse` | No |
| `NAS_HOST` | Hostname/IP of Synology NAS | Yes (for NAS tools) |
| `NAS_USER` | SSH Username for NAS | Yes (for NAS tools) |
| `NAS_PRIVATE_KEY` | SSH Private Key for NAS | Yes (for NAS tools) |
| `NAS_ALLOWED_PATHS`| Comma-separated list of allowed path prefixes | No (defaults to strict subset) |
| `JELLYFIN_URL` | Internal URL for Jellyfin | No (default: cluster svc) |
| `JELLYFIN_API_KEY` | API Key for Jellyfin operations | Yes (for Media tools) |
| `IMMICH_API_KEY` | API Key for Immich stats | Yes (for Media tools) |

## 📦 Deployment

### Local Development (Stdio)

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in stdio mode (for testing with Claude Desktop/CLI)
npm run dev
```

### Kubernetes (Production)

The server is designed to be deployed as a Pod in your cluster.

1.  **Build Docker Image:**
    ```bash
    docker build -t ghcr.io/username/homelab-mcp:latest .
    ```

2.  **Deploy Manifests:**
    See the `k8s/` directory for example manifests, including:
    -   `deployment.yaml`
    -   `service.yaml`
    -   `ingress.yaml` (configured for Tailscale/Cert-manager)
    -   `clusterrole.yaml` (Scoped RBAC permissions)

## 🧩 Available Tools

| Category | Tools |
|----------|-------|
| **Cluster** | `get_cluster_health`, `restart_deployment` |
| **DNS** | `get_dns_status`, `test_dns_query`, `update_pihole_gravity`, `get_pihole_whitelist`, `get_pihole_queries` |
| **GitOps** | `get_flux_status`, `reconcile_flux` |
| **Media** | `get_media_status`, `fix_jellyfin_metadata` |
| **Backups** | `get_backup_status`, `trigger_backup`, `get_cronjob_details`, `get_job_logs` |
| **Secrets** | `get_secrets_status`, `refresh_secret` |
| **Storage** | `get_pvcs` |
| **Resources** | `describe_resource` |
| **System** | `get_certificate_status`, `get_ingress_status`, `touch_nas_path` |
| **Networking** | `get_node_networking`, `get_iptables_rules`, `get_conntrack_entries`, `curl_ingress`, `test_pod_connectivity` |
| **Logs** | `get_pod_logs` |