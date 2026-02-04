# Feature Requests: Ebook Stack Deployment Session

**Date**: 2026-02-03
**Context**: Deploying LazyLibrarian + Calibre-Web for ebook management

## Summary

During a session deploying an ebook management stack (LazyLibrarian, Calibre-Web, Readarr), several gaps in MCP tooling required falling back to `kubectl exec` via the cluster-ops agent. This document captures potential enhancements.

---

## Feature Requests

### 1. Expand `restart_deployment` Whitelist

**Current State**: Only Jellyfin, Pi-hole, Unbound, Immich, Homepage, Uptime-Kuma can be restarted.

**Request**: Add media stack services:
- `media/lazylibrarian`
- `media/calibre-web`
- `media/readarr`
- `media/sabnzbd`
- `media/sonarr`
- `media/radarr`
- `media/prowlarr`

**Rationale**: These services often need restarts after config changes or to pick up new environment variables.

---

### 2. Generic Pod Exec Tool (Scoped)

**Current State**: Exec is limited to specific namespaces (pihole, jellyfin, mcp-homelab) with hardcoded commands.

**Request**: A more flexible exec tool with safety constraints:

```typescript
exec_in_pod({
  namespace: "media",
  pod: "lazylibrarian",  // or deployment name with fuzzy match
  command: ["cat", "/config/config.ini"],
  timeout: 30
})
```

**Safety Model**:
- Whitelist of allowed namespaces (e.g., `media`, `pihole`, `jellyfin`)
- Command whitelist or prefix whitelist (e.g., `cat`, `ls`, `sqlite3 -readonly`)
- Read-only by default, write operations require explicit flag
- Timeout enforcement

**Use Cases from Today**:
- Reading LazyLibrarian config to debug settings
- Checking if files exist in pods
- Running `calibredb list` to verify library

---

### 3. File Read/Write in Pod Volumes

**Current State**: No way to read or write files in pod volumes.

**Request**:
```typescript
read_pod_file({
  namespace: "media",
  pod: "lazylibrarian",
  path: "/config/calibredb-wrapper.sh"
})

write_pod_file({
  namespace: "media",
  pod: "lazylibrarian",
  path: "/config/calibredb-wrapper.sh",
  content: "#!/bin/bash\n...",
  mode: "0755"
})
```

**Use Cases from Today**:
- Created `/config/calibredb-wrapper.sh` wrapper script
- Needed to modify/debug it multiple times
- Currently requires full kubectl exec with heredoc

**Safety Model**:
- Whitelist allowed path prefixes per namespace (e.g., `/config/`, `/tmp/`)
- Size limits on writes
- No writes to system paths

---

### 4. SQLite Query Tool

**Current State**: No database access.

**Request**:
```typescript
query_sqlite({
  namespace: "media",
  pod: "calibre-web",
  database: "/books/metadata.db",
  query: "SELECT name FROM sqlite_master WHERE type='table';",
  readonly: true
})

exec_sqlite({
  namespace: "media",
  pod: "calibre-web",
  database: "/books/metadata.db",
  statement: "ALTER TABLE books ADD COLUMN isbn TEXT DEFAULT '';"
})
```

**Use Cases from Today**:
- Debugging Calibre-Web 500 error (missing `books.isbn` column)
- Verifying database schema after creation
- Adding missing columns to fix compatibility

**Safety Model**:
- `query_sqlite` is read-only by default
- `exec_sqlite` requires explicit call, limited to specific databases
- Whitelist of allowed database paths

---

### 5. Application-Specific Status Tools

**Current State**: `get_media_status` covers Jellyfin/Immich.

**Request**: Extend or add tools for other media apps:

```typescript
get_download_client_status()  // SABnzbd, qBittorrent
// Returns: queue length, speed, disk space, active downloads

get_arr_status({app: "lazylibrarian"})  // or sonarr, radarr, etc.
// Returns: wanted items, recent downloads, indexer health, download client connection
```

**Use Cases from Today**:
- Checking if LazyLibrarian was finding indexer results
- Verifying SABnzbd connection from LazyLibrarian
- Debugging why searches returned 0 results

---

### 6. Enhanced Logging with Filters

**Current State**: `get_pod_logs` returns raw logs with line limit.

**Request**: Add filtering capabilities:
```typescript
get_pod_logs({
  namespace: "media",
  pod: "lazylibrarian",
  lines: 100,
  filter: "ERROR|WARN",  // grep-style filter
  since: "5m",
  highlight: ["calibredb", "search"]  // terms to highlight in output
})
```

**Use Cases from Today**:
- Searching for calibredb-related errors in LazyLibrarian logs
- Finding search/indexer errors among verbose INFO logs
- Filtering to just the relevant timeframe

---

## Priority Assessment

| Feature | Impact | Complexity | Priority |
|---------|--------|------------|----------|
| Expand restart whitelist | High | Low | P1 |
| Pod file read/write | High | Medium | P1 |
| Generic pod exec | High | Medium | P2 |
| SQLite query tool | Medium | Medium | P2 |
| App-specific status | Medium | High | P3 |
| Enhanced log filters | Low | Low | P3 |

---

## Session Pain Points

1. **Created wrapper script via kubectl exec** - Required 4+ iterations to get right, each requiring manual exec commands through cluster-ops agent

2. **Database schema debugging** - Had to exec into pod, run sqlite3 commands, ALTER TABLE, all manually

3. **Config verification** - Couldn't easily check if LazyLibrarian settings were persisted correctly

4. **No visibility into app behavior** - Had to rely on `get_pod_logs` and manually parse for relevant entries

---

## Notes

The MCP tool's security model is good - these requests should maintain the defense-in-depth approach:
- Namespace whitelisting
- Command/path whitelisting
- Read-only defaults
- Timeout enforcement
- Audit logging
