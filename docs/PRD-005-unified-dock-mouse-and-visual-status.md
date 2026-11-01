# PRD-005: Unified Master-Detail Background Tasks Screen & Reactive Telemetry

| | |
| --- | --- |
| **Status** | Approved Specification · Implemented & Verified |
| **Version** | 3.1 |
| **Date** | 2026-11-01 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md), [PRD-004](PRD-004-rpc-task-surface.md), [PRD-006](PRD-006-standalone-bash-rendering-and-task-telemetry.md) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0**, `@earendil-works/pi-tui` |
| **Design principle** | **Merged Master-Detail Screen.** Opening `/tasks` or inspecting a specific task presents a single, unified master-detail interface. The upper half renders the master task list with status markers (`✓`, `●`, `✗`), duration, and ID. The lower half renders the active task's details (`Command:`, `Status:`, `Type:`, `Started:`, `Cwd:`, `Log:`) and live `Output` tail. Moving the selection (`↑`/`↓` or mouse) reactively re-binds the lower half in real time without screen transitions. |

---

## 1. Summary & Visual Layout

Invoking `/tasks` (or inspecting tasks from the dock) displays the unified master-detail screen directly below the editor:

```
── Background Tasks ────────────────────────────────────────────────────────────────
3 tasks  current session branch

  ✓ test-slow                                                               8s task-1
> ✓ test-heartbeat                                                         12s task-2
  ✓ test-counter                                                            5s task-3

Task Details
Command: test-heartbeat
Status:  ✓ completed · 12s
Type:    Agent
Started: 2026-11-01 16:39:40
Cwd:     /home/hati/workspace
Log:     /home/hati/workspace/.pi/bg-tasks/task-2.log
────────────────────────────────────────────────────────────────────────────────────
Output

(no output yet)

following tail 0B · ↑ scroll · ↑/↓ select · PgUp/PgDn scroll log · k kill · esc close
```

### Components:

1. **Full-Width Header**:
   - `── Background Tasks ` followed by `─` extending to terminal width.
   - Title in `toolTitle` or `accent`, rule dashes in `dim`.
2. **Context Subtitle**:
   - `N tasks  current session branch` in `dim` (e.g. `3 tasks  current session branch`).
3. **Master Task List**:
   - Selection indicator: `> ` on the active task row, `  ` on others.
   - Status marker:
     - `✓` (completed, green `success`)
     - `●` (running, green `success`)
     - `✗` (failed / killed, red `error`)
   - Task label: `task.taskName ?? task.command` (single line, truncated to fit).
   - Right-aligned: elapsed duration (e.g. `8s`, `12s`) and task identifier (e.g. `task-1`, `task-2`).
   - Scrollable via keyboard (`↑`/`↓`) and mouse wheel.
4. **Task Details Metadata Group (with Cwd & Log)**:
   - Rendered directly below the list for the currently highlighted task:
     ```
     Task Details
     Command: <command>
     Status:  <icon> <status> [· <duration>]
     Type:    Agent | Subagent
     Started: <timestamp>
     Cwd:     <path>
     Log:     <path>
     ```
   - LHS labels `Command:`, `Status:`, `Type:`, `Started:`, `Cwd:`, and `Log:` colored in uniform blue (`mdLink`).
   - `Status` RHS rendered in semantic color (green for success/running, red for error/exit!=0).
   - Paths rendered in `dim` / default text.
5. **Divider Rule & Live Output Section**:
   - Full-width divider `───────────────────────────────────`.
   - `Output` section header.
   - Live scrollable tail of the selected task's log file (scrollable via `PgUp`/`PgDn` or mouse wheel).
6. **Reactive Selection Tracking**:
   - Moving the `>` cursor (`↑`/`↓` or mouse click) instantly re-binds the active task.
   - `Command:`, `Status:`, `Type:`, `Started:`, `Cwd:`, `Log:`, and the `Output` tail update immediately in real time.
7. **Single Unified Screen**:
   - There is no separate "details only" screen that hides the task list.
   - Invoking `/tasks`, inspecting task details, or clicking a task row displays this exact same screen.
   - Only `/tasks` is registered (no `/bg-tasks`).
   - Pressing `Esc` closes the view and returns to the normal editor prompt.

---

## 2. Goals & Non-Goals

### Goals

| ID | Goal |
|---|---|
| **G1** | Header rule `── Background Tasks ──────────────────────────` scaled dynamically to window width. |
| **G2** | Context subtitle `N tasks  current session branch`. |
| **G3** | Master task list with selection indicator `> `, completion markers (`✓`, `●`, `✗`), right-aligned duration and task ID. |
| **G4** | Direct display of `Cwd: <path>` and `Log: <path>` inside the `Task Details` metadata group. |
| **G5** | Unified screen: `/tasks` and task detail inspection present the same merged screen. |
| **G6** | Reactive selection: moving the cursor updates `Command`, `Status`, `Type`, `Started`, `Cwd`, `Log`, and `Output` immediately. |
| **G7** | Keyboard navigation: `↑`/`↓` navigates master task list, `PgUp`/`PgDn` scrolls Output tail, `k` kills selected task, `Esc` collapses view. |
| **G8** | Remove `/bg-tasks` command alias; retain `/tasks` as the sole entry point. |

### Non-Goals

| ID | Non-Goal |
|---|---|
| **N1** | Separate disjoint modal screens that hide the task list. |
| **N2** | Static, un-reactive telemetry lines. |
| **N3** | Registering `/bg-tasks`. |

---

## 3. Architecture & Implementation

### 3.1 `src/ui/dock.ts`
- `DockController`:
  - Tracks tasks, selection `index`, `listOffset`, and `expanded` state.
  - `expandTasks(taskId)` and `openDetail(task)` both activate the unified master-detail view.
  - `move(delta)` navigates tasks and re-targets `detailTask` and Output reader.
  - `scrollDetail(delta)` scrolls the Output tail with follow-state tracking.
  - `reconcile()` gracefully handles finished/evicted tasks without recursion/overflow.
- `installDock(ctx, registry, controller, options)`:
  - Collapsed mode: renders compact 1-3 running task rows with bottom border.
  - Expanded mode: renders full merged master-detail screen with header, list, details, divider, and Output tail.
  - Handles mouse wheel (scrolling list vs output based on cursor position) and click selection.

### 3.2 `src/dock-editor.ts`
- Routes keyboard events:
  - `↓` on empty editor enters dock mode.
  - In expanded mode:
    - `↑`/`↓` moves selection across the master task list (exiting to editor if `↑` on top row).
    - `PgUp`/`PgDn` scrolls the live Output log tail.
    - `Home`/`End` scrolls Output tail to start/end.
    - `k` kills the currently selected task.
    - `Esc` closes the expanded view and returns focus to the editor input.

### 3.3 `src/ui/format.ts`
- Pure formatting helpers:
  - `taskStatusIcon(task, theme)`: `✓` (green), `●` (green), `✗` (red).
  - `formatHeaderLine(title, width, theme)`: Full-width divider rule header.
  - `formatCleanTaskRow(task, selected, width, now, theme)`: Clean master task row.
  - `taskMetadataLines(task, width, now, options)`: Task Details group including `Command:`, `Status:`, `Type:`, `Started:`, `Cwd:`, `Log:` with uniform blue LHS labels (`mdLink`).
  - `detailLines(...)`: Section block for standalone callers.
  - `formatOutputStatusLine(...)`: Status hint showing scroll position and line count.
