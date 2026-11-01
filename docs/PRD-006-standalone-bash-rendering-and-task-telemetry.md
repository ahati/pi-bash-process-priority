# PRD-006: Standalone Bash Rendering & Task Log Telemetry

| | |
| --- | --- |
| **Status** | Implemented & Verified |
| **Version** | 1.0 |
| **Date** | 2026-11-01 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md), [PRD-004](PRD-004-rpc-task-surface.md) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0**, `@earendil-works/pi-tui` |
| **Design principle** | **Self-contained zero-dependency execution and robust log telemetry.** The extension operates without external dependencies on other UI extensions like `pi-ui-enhancement`. Memory-bounded streaming and live byte tracking ensure background tasks remain lightweight and resilient under heavy output loads. |

---

## 1. Summary

This specification defines the consolidation of standalone bash tool rendering and enhanced task telemetry in `pi-bash-process-priority`:

1. **Self-Contained Standalone Bash Rendering**:
   Ported the complete bash tool call and execution result rendering logic from `pi-ui-enhancement` directly into `pi-bash-process-priority`:
   - `src/ui/bash-display.ts`: Rich tool call rendering with prompt styling (`$`), tool title highlighting, background badge indicators (`⏾ background · taskName`), timeout indications, and working directory headers.
   - `src/ui/bash-result.ts`: Result box rendering with clean output streaming, quiet command indicators, exit status formatting, and partial preview truncation hints.
   - `src/ui/ansi-utils.ts`: Terminal escape sanitizer stripping problematic background color sequences that corrupt themed terminal output.
   - `src/ui/bash-intent.ts`: Intent comment parser extracting `# intent: <summary>` and `# tool: <name>` comments from commands and formatting them into styled headers. Injects system prompt guidelines encouraging models to annotate bash commands.
2. **Management Action Header Formatting**:
   Management calls (`taskAction: list | status | kill | input | adopt`) render cleanly as:
   ```
   ⚙ bash tasks · list
   ⚙ bash tasks · status task-1
   ⚙ bash tasks · kill task-2
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
| **G2** | Rich intent header extraction (`# intent: ...`) and system prompt guidance injection. |
| **G3** | Distinct display for management actions (`taskAction`) vs standard command execution. |
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

### 4.1 Standalone Bash Tool Display Pipeline

```
bash tool call
 │
 ├── Parse Command String ────────► src/ui/bash-intent.ts
 │                                   ├─ Extract `# intent: <text>`
 │                                   ├─ Extract `# tool: <name>`
 │                                   └─ Strip leading redundant `cd <cwd>`
 │
 ├── Render Call Header ──────────► src/ui/bash-display.ts
 │                                   ├─ Tool icon + title (`$`)
 │                                   ├─ Accent-styled command text
 │                                   ├─ Background badge (`⏾ background · taskName`)
 │                                   └─ Management header (`⚙ bash tasks · <action>`)
 │
 └── Render Result / Output ──────► src/ui/bash-result.ts
                                     ├─ ANSI sanitization (`src/ui/ansi-utils.ts`)
                                     ├─ Output streaming with line-clamp preview
                                     └─ Exit status badge (`✔ completed` / `✗ exit 1`)
```

### 4.2 Intent Instruction Injection (`src/ui/bash-intent.ts`)

`buildBashIntentSystemPrompt(existingPrompt)` appends guidelines ensuring the model annotates complex bash invocations with user-friendly intent comments:

```
Guidelines for bash command execution:
- Prefix complex commands with `# intent: <brief explanation>` to communicate intent to the user.
- If delegating to a CLI tool, annotate with `# tool: <name>`.
```

The header parser matches:
```ts
const INTENT_REGEX = /^#\s*intent:\s*(.+)$/im;
const TOOL_REGEX = /^#\s*tool:\s*(.+)$/im;
```

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

1. **Standalone Bash Rendering Unit Tests (`tests/bash-render-standalone.test.ts`)**:
   - Header formatting with intent comments (`# intent: Build project`).
   - Tool comments (`# tool: cargo`).
   - Background badge rendering (`⏾ background · test-server`).
   - Management action calls (`taskAction: "list"` $\rightarrow$ `bash tasks · list`).
   - Redundant `cd <cwd>` prefix stripping.
   - Idempotent line rendering without memory mutation across passes.
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
