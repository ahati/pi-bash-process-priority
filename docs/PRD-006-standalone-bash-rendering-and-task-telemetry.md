# PRD-006: Background-Task Rendering & Task Log Telemetry

| | |
| --- | --- |
| **Status** | Implemented & Verified |
| **Version** | 1.0 |
| **Date** | 2026-11-01 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md), [PRD-004](PRD-004-rpc-task-surface.md) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0**, `@earendil-works/pi-tui` |
| **Design principle** | **Self-contained zero-dependency execution and robust log telemetry.** The extension operates without external dependencies on other UI extensions like `pi-ui-enhancement`. Memory-bounded streaming and live byte tracking ensure background tasks remain lightweight and resilient under heavy output loads. |

> **Current implementation note (post-split):** the standalone built-in `bash` renderer was removed in commit `2ebbafc`. `pi-bash-process-priority` now delegates `bash` rendering to pi / `pi-ui-enhancement` and only ships renderers for its own `background_task` and `manage_background_task` tools. `src/ui/bash-intent.ts` and its prompt injection have been removed; the sections below describe the current background-task scope.

---

## 1. Summary

This specification defines the consolidation of background-task tool rendering and enhanced task telemetry in `pi-bash-process-priority`:

1. **Standalone Background-Task Rendering**:
   The background task tools keep task-specific call and result rendering without depending on `pi-ui-enhancement`:
   - `src/ui/bash-display.ts`: Call headers for `background_task` (badge, task name, `$` command, timeout, expanded `cwd:`) and `manage_background_task` (`task manager` action header).
   - `src/ui/bash-result.ts`: Result cards for background task spawn, management actions, errors, and bounded output previews.
   - `src/ui/ansi-utils.ts`: Terminal escape sanitizer stripping problematic background color sequences that corrupt themed terminal output.
2. **Management Action Header Formatting**:
   Management calls (`action: list | status | logs | kill | input`) render cleanly as:
   ```
   🔧 task manager · list
   🔧 task manager · status task-1
   🔧 task manager · kill task-2
   ```
   with spinner animations during active execution.
3. **Memory-Safe Bounded Log Reader (`src/log-reader.ts`)**:
   Ported from `pi-background-tasks` (ismailsaleekh):
   - Implements `BoundedLogReader` and `readTail(filePath, maxBytes)` using POSIX `fs.openSync`, `fs.readSync`, and seek offsets.
   - Safely reads only the trailing slice of arbitrary-sized log files (up to hundreds of megabytes or gigabytes) without buffer exhaustion or node event-loop latency.
   - Normalizes carriage returns (`\r\n` $\rightarrow$ `\n`) and strips trailing blank lines.
4. **Live Byte Tracking & Extended Process Telemetry (`src/registry.ts`)**:
   - The child process log writer tracks cumulative bytes streamed to disk (`bytesWritten`).
   - Exposes `bytesWritten` through `BgTask` metadata and displays formatted sizes (`formatSize(bytesWritten)`) in Task Details.
   - Provides programmatic task rerun (`registry.rerun(id)`) and mass termination (`registry.stopAllRunning()`).

---

## 2. Problem Statement

1. **Fragile Cross-Extension Coupling**:
   Previously, bash rendering relied on a separate extension (`pi-ui-enhancement`). When `pi-bash-process-priority` overrode the built-in `bash` tool, rendering was subject to load order races, missing visual badges, or broken display styles if the other extension was absent, disabled, or updated independently.
2. **Memory Overflows on Heavy Background Output**:
   Long-running background tasks (e.g. continuous compilers, test suites, packet dumps, servers) can produce tens of megabytes of log output. Naively reading entire files via `fs.readFileSync()` causes high heap allocation, GC thrashing, and process crashes.
3. **Lack of Live Telemetry in UI**:
   Users running background commands had no visibility into output volume or process identifiers without manually digging into `.pi/bg-tasks/` directories.

---

## 3. Goals & Non-Goals

### Goals

| ID | Goal |
|---|---|
| **G1** | Complete independence: zero dependencies on `pi-ui-enhancement` or external renderers. |
| **G2** | Task-specific call/result rendering for `background_task` and `manage_background_task` that works regardless of which extension renders built-in `bash`. |
| **G3** | Distinct display for management actions (`action`) vs background task spawns. |
| **G4** | Bounded tail reading guaranteeing maximum heap footprint under large log files. |
| **G5** | Accurate live byte tracking (`bytesWritten`) updated per stream chunk. |
| **G6** | Extended metadata support in Task Details (`PID`, `Exit`, `Output`, `Size`). |

### Non-Goals

| ID | Non-Goal |
|---|---|
| **N1** | Modifying external non-bash tool rendering (e.g. `read`, `edit`, `write` tools). |
| **N2** | Compressing or rotating log files on disk (managed externally by OS / session cleanup). |
| **N3** | In-memory log ring buffers (file-backed disk logging remains the source of truth). |

---

## 4. Architecture & Technical Details

### 4.1 Background-Task Display Pipeline

```
background_task / manage_background_task call
 │
 ├── Render Call Header ──────────► src/ui/bash-display.ts
 │                                   ├─ BackgroundTask badge + task name
 │                                   ├─ Accent-styled `$ <command>`
 │                                   ├─ Timeout and elapsed spinner
 │                                   ├─ Expanded `cwd:` line
 │                                   └─ Management header (`🔧 task manager · <action>`)
 │
 └── Render Result / Output ──────► src/ui/bash-result.ts
                                     ├─ ANSI sanitization (`src/ui/ansi-utils.ts`)
                                     ├─ Output preview with line clamping
                                     └─ Action-specific result formatting
```

### 4.2 Intent Instruction Injection (removed)

`src/ui/bash-intent.ts` and the `before_agent_start` prompt injection were removed in commit `2ebbafc`. Built-in bash intent headers are owned by `pi-ui-enhancement` (`bashIntentMode`); the remaining background-task renderers do not parse `# intent:` / `# tool:` comments.

### 4.3 Bounded Log Tail Reader (`src/log-reader.ts`)

```ts
export class BoundedLogReader {
  constructor(private readonly defaultMaxBytes: number = 64 * 1024) {}

  readTail(filePath: string, maxBytes = this.defaultMaxBytes): {
    content: string;
    bytesRead: number;
    totalBytes: number;
    truncated: boolean;
  }
}
```

#### Read Algorithm:
1. Calls `fs.statSync(filePath)` to determine `totalBytes`.
2. If `totalBytes <= maxBytes`, reads the entire file in one buffer.
3. If `totalBytes > maxBytes`:
   - Calculates seek offset: `startOffset = totalBytes - maxBytes`.
   - Opens file descriptor: `fd = fs.openSync(filePath, "r")`.
   - Reads exact `maxBytes` into allocated slice: `fs.readSync(fd, buffer, 0, maxBytes, startOffset)`.
   - Sets `truncated = true`.
4. Drops partial leading line if truncated in the middle of a line break.
5. Returns normalized utf-8 content with byte counts.

### 4.4 Process Telemetry in Registry (`src/registry.ts`)

When a child process streams stdout and stderr:
```ts
child.stdout.on("data", (chunk: Buffer) => {
  task.bytesWritten = (task.bytesWritten ?? 0) + chunk.length;
  stream.write(chunk);
});

child.stderr.on("data", (chunk: Buffer) => {
  task.bytesWritten = (task.bytesWritten ?? 0) + chunk.length;
  stream.write(chunk);
});
```

Formatted byte sizes appear in Task Details:
- `< 1024 B`: `N B`
- `< 1024 KB`: `N.N KB`
- `≥ 1 MB`: `N.N MB`

---

## 5. Verification & Test Plan

1. **Background-Task Rendering Unit Tests (`tests/bash-render-standalone.test.ts`)**:
   - Background task call header with optional task name.
   - Expanded `cwd:` line.
   - Background task result card (task ID, log path, no-poll hint).
   - Management action calls (`action: "list"` → `task manager · list`).
   - Redundant `cd <cwd>` prefix stripping.
2. **Log Reader Unit Tests (`tests/log-reader.test.ts`)**:
   - Safe behavior on non-existent files.
   - Bounded reading on large files within `maxBytes` cap.
   - Carriage return normalization and line splitting.
3. **Registry Telemetry Tests (`tests/registry-enhanced.test.ts`)**:
   - Verifying `bytesWritten` tracking during active process output streaming.
   - Verifying task rerun capabilities (`registry.rerun(id)`).
   - Verifying `registry.stopAllRunning()` kills all spawned child process groups.
4. **Format Enhanced Tests (`tests/format-enhanced.test.ts`)**:
   - Verifying `formatSize` formatting across byte scales.
   - Verifying `showMetadata` outputs `PID`, `Exit`, `Output`, and `Size`.
