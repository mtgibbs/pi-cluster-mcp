# Design: `trigger_jellyfin_scan` — discover new media on demand

**Date**: 2026-08-28
**Status**: Design, unimplemented
**Context**: A movie that Radarr had already imported was invisible in Jellyfin, and no MCP
tool could do anything about it.

---

## 1. Why

Jellyfin's `LibraryMonitor` watches for new files with `inotify`, and **inotify does not work
across NFS**. Everything Radarr and Sonarr write to the QNAP is invisible to Jellyfin's watcher.
The only thing that discovers a *new* title is the scheduled **Scan Media Library** task, and that
task runs **once a day at 02:00** — deliberately, because a scan's thousands of random reads
contend for seeks with a stream's one sequential read on a 3-disk spinning RAID5 and kill playback
mid-movie (`media-services` SKILL.md records the 15-min interval that caused it and the move to
off-hours).

So the daily scan is correct, and the gap it leaves is real: **between an import and 02:00, new
media exists on disk and cannot be watched.**

On 2026-08-28 that gap was hit head-on. Radarr grabbed and imported *Stick It* at 20:57; the title
was simply absent from Jellyfin, and the whole MCP tool surface had no way to close the distance.
`fix_jellyfin_metadata` refreshes items Jellyfin **already knows about** — it returned `NOT_FOUND`,
which is correct behaviour and useless here. The documented fix in the skill is a raw `curl` against
`/ScheduledTasks/…` carrying an API key read from 1Password: a path available to a laptop with `op`,
and available to **nothing else**. The harness container has no `op` and no `kubectl`.

The tool that has the Jellyfin key in its environment already — `mcp-homelab` — is the one thing
that could have done it in one call, and it could not, because the tool was never written.

**This spec adds exactly that one call, with the guards that make it safe to expose.**

## 2. Outcomes (Definition of Done)

1. A caller can trigger Jellyfin's library scan through the MCP, with no `kubectl`, no `op`, and no
   raw `curl`.
2. The tool **refuses while anything is playing**, because that is the failure the daily schedule
   exists to prevent.
3. The tool **refuses to start a second scan** while one is running, and reports the running one's
   progress instead.
4. Only an allowlisted task can be triggered. An arbitrary task id from the caller never reaches
   Jellyfin.
5. Every refusal names its cause in a distinct code. Nothing reports success it did not observe.
6. The guards **fail closed** — a guard that cannot complete its own check refuses the scan.

## 3. The tool

### 3.1 Shape

```
trigger_jellyfin_scan(task?: string = "RefreshLibrary", force?: boolean = false)
```

`task` is a Jellyfin **task Key**, not an Id. Keys are stable strings in Jellyfin's source
(`RefreshLibrary`); Ids are per-install hashes. The existing skill documentation carries the Id
`7738148ffcd07979c7ceb148e06b3aed`, and that Id is exactly the kind of value that survives in a
document long after it stops being true on a rebuilt server. **Resolve the Key to an Id at call
time; never hardcode the Id.**

### 3.2 The allowlist

```ts
// src/utils/whitelist.ts — alongside ALLOWED_DEPLOYMENTS
export const TRIGGERABLE_JELLYFIN_TASKS = new Set(['RefreshLibrary']);
```

One entry. `RefreshLibrary` is the only task that answers the question "why can't I see the movie I
just downloaded"; every other scheduled task is a maintenance job whose off-hours slot is a
deliberate decision recorded in the media-services **Master Schedule**. `TaskExtractMediaSegments`
in particular is documented as causing the *same* seek-contention stream deaths, and is deliberately
**not** triggerable.

This mirrors `ALLOWED_DEPLOYMENTS` and the `homelab.mcp/triggerable` label on CronJobs: a mutation
tool reaches a fixed, reviewed set of targets, never an arbitrary one the caller names.

The allowlist is also the **input-validation boundary**. The caller's `task` string is compared
against the set and then discarded; what goes into the request URL is the Id resolved from
Jellyfin's own task list. A caller-supplied string never becomes a URL path segment.

### 3.3 Guard A — refuse while something is playing

Before starting anything, read the active sessions (`getActiveSessions()`, already implemented in
`src/clients/jellyfin.ts`). If **any** session has a `NowPlayingItem`, refuse:

```json
{ "error": true, "code": "STREAM_ACTIVE",
  "message": "Refusing to scan while 1 stream is active — a library scan starves playback on the RAID5.",
  "activeSessions": [{ "userName": "…", "client": "…", "nowPlaying": "…" }],
  "hint": "Pass force: true to override, or wait for the 02:00 scheduled scan." }
```

This guard is the whole reason the tool is safe to have. Without it, an agent that helpfully "just
runs a scan" reproduces, on demand, the exact fault that took months to diagnose.

`force: true` overrides it. The override must be **echoed in the success response** (`"forced":
true`) so the run that killed a stream is attributable afterwards.

> A paused session is still holding the file open and is still going to resume. Treat any session
> with a `NowPlayingItem` as active, paused or not.

### 3.4 Guard B — refuse an overlapping run

Read the task's `State` from Jellyfin's task list. If it is `Running` (or `Cancelling`), do not
start a second one:

```json
{ "error": true, "code": "ALREADY_RUNNING",
  "message": "Scan Media Library is already running (42%).",
  "state": "Running", "progressPercent": 42 }
```

This mirrors Guard A of `trigger_cronjob` (`refuse overlapping runs`, commit `f4c63c8`) and gives
the tool a second job for free: **calling it again is how you check on it.** A caller that wants
progress re-invokes and reads `ALREADY_RUNNING`. That is deliberately why this ships as one tool
rather than a trigger plus a separate status reader — one tool, two answers, nothing extra to
learn.

`force` does **not** override Guard B. Two concurrent scans of the same library is never the thing
anyone wanted, and Jellyfin will not do it usefully anyway.

### 3.5 Fail closed

If `getActiveSessions()` throws, or the task list cannot be read, the tool **refuses**:

```json
{ "error": true, "code": "GUARD_UNAVAILABLE",
  "message": "Could not read Jellyfin sessions; refusing to scan rather than scanning unguarded." }
```

A guard that cannot run is not a guard that passed. This is the single easiest thing to get wrong
here — a `try/catch` that logs and falls through to the scan turns both guards off precisely when
Jellyfin is already unhappy.

### 3.6 Success

```json
{ "success": true, "task": "Scan Media Library", "taskKey": "RefreshLibrary",
  "taskId": "7738…", "previousState": "Idle", "forced": false,
  "message": "Triggered Scan Media Library. New titles appear as it completes; re-run this tool to see progress." }
```

`success: true` is returned **only** when Jellyfin's start request actually succeeded (HTTP 204).
An exception or a non-2xx is an error response, never a success with a warning attached.

The tool **does not wait** for the scan to finish. It returns as soon as the task is started. A
scan takes ~11 seconds on this library today, but it is unbounded in principle, and an MCP call
that blocks on it would be a call that times out on the day it matters most.

## 4. Client work (`src/clients/jellyfin.ts`)

Two additions, both using the existing `jellyfinFetch` (which already carries `X-Emby-Token` and
already returns `{}` on 204):

```ts
export interface JellyfinTask {
  Id: string; Key: string; Name: string;
  State: 'Idle' | 'Running' | 'Cancelling';
  CurrentProgressPercentage?: number;
}

export async function getScheduledTasks(): Promise<JellyfinTask[]>   // GET  /ScheduledTasks
export async function startScheduledTask(taskId: string): Promise<void> // POST /ScheduledTasks/Running/{taskId}
```

> **Verify the endpoint shape against the running server before building on it.** The instance is
> Jellyfin **10.11.11** (from `get_media_status`). `POST /ScheduledTasks/Running/{Id}` is the
> documented start route, but this is the one fact in this document taken from the API surface
> rather than from this repo's own code — confirm it first, and adjust here if it differs.

## 5. Scope

**In:** the tool, the two client functions, the allowlist entry, unit tests, and a `media-services`
SKILL.md note pointing at the tool instead of the raw `curl`.

**Out:**
- Triggering any other scheduled task. Add one only when something actually pulls for it.
- Changing the 02:00 schedule. The daily scan stays exactly as it is; this is a supplement to it,
  never a replacement, and the Master Schedule's reasoning is unaffected.
- Sonarr/Radarr on-import scan hooks. That is the *real* long-term fix for discovery latency
  (media-services SKILL.md names it), and it is a separate change in a different system.
- Waiting, polling, or notifying on completion.

## 6. Facts the implementer must know

| fact | where | why it matters |
|---|---|---|
| inotify does not work over NFS | media-services SKILL.md | it is why a scan is the *only* discovery path |
| a scan killed streams; that is why it is 02:00 | media-services SKILL.md + the Master Schedule | Guard A is not defensive padding, it is the documented failure |
| `JELLYFIN_API_KEY` is already in the pod env | `clusters/pi-k3s/mcp-homelab/deployment.yaml` | **no new credential** — reuse before mint |
| `jellyfinFetch` handles 204 already | `src/clients/jellyfin.ts` | the start call returns 204 with no body |
| `trigger_cronjob` established the guard shape | commits `f60d2ec`, `f4c63c8` | follow it rather than inventing a second idiom |
| the MCP is read-mostly by design | `CLAUDE.md`, `.review-hub.yml` | a new mutation needs a visible gate or review-hub will say so |

## 7. Review gates this will trip

`.review-hub.yml` runs these on the PR, and this design answers each deliberately:

- **`mutation-gating`** — a new mutating tool shipping with no gate. Answered by §3.2–3.4.
- **`concurrency-safety`** — active-run guard integrity. Guard B (§3.4) is that guard; weakening or
  unwiring it is the regression to watch for.
- **`input-validation`** — unvalidated caller input reaching a sink. §3.2: the caller's string is
  matched against a set and discarded; only a server-resolved Id reaches the URL.
- **`fail-closed`** — error paths that stop refusing. §3.5 is the whole point.
- **`no-false-green`** — §3.6: `success: true` only on an observed 204.
- **`secret-hygiene`** — the token stays inside `jellyfinFetch`; no response field and no error
  message may carry it.

## 8. Acceptance criteria

- **AC-1** When no session is playing and the task is idle, the tool shall start `RefreshLibrary`
  and return `success: true` with the resolved `taskId`.
- **AC-2** When any session has a `NowPlayingItem`, the tool shall return `STREAM_ACTIVE` and shall
  **not** call the start endpoint.
- **AC-3** When `force: true` and a session is playing, the tool shall start the task and return
  `forced: true`.
- **AC-4** When the task state is `Running`, the tool shall return `ALREADY_RUNNING` with the
  progress percentage, and shall not call the start endpoint — **including when `force: true`**.
- **AC-5** When `task` is not in `TRIGGERABLE_JELLYFIN_TASKS`, the tool shall return
  `TASK_NOT_ALLOWED` and shall make no Jellyfin request that includes the caller's string.
- **AC-6** When the allowlisted key is absent from Jellyfin's task list, the tool shall return
  `TASK_NOT_FOUND`.
- **AC-7** When reading sessions or tasks throws, the tool shall return `GUARD_UNAVAILABLE` and
  shall not call the start endpoint.
- **AC-8** When the start endpoint returns non-2xx, the tool shall return `JELLYFIN_ERROR` and
  shall not report success.

### Validating the gates in both directions

Per `reference_gate_two_direction_validation`, each guard needs **both** proofs, and a test that
only ever sees the happy path proves nothing:

1. **Red before green** — a fixture with an active session must make AC-2 fail *before* Guard A is
   written, and the `ALREADY_RUNNING` fixture must fail before Guard B is written.
2. **Green is reachable** — the idle/no-session fixture must actually start the task, or the guards
   have simply disabled the tool.

The mocked Jellyfin client in `src/__tests__/tools.test.ts` is where both live.

## 9. Open question

**Should a completed scan announce itself?** The tool returns immediately, so the caller learns the
scan finished only by asking again. An ntfy notification on completion would close that, but it
needs a completion watcher, which is a background job this server does not have and should not grow
for one tool. Left open deliberately; re-invocation is sufficient today.
