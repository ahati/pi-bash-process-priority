# PRD-005: Clean Background Tasks Screen, Top List Status Markers & Cwd/Log Telemetry

| | |
| --- | --- |
| **Status** | Approved Specification · In Implementation |
| **Version** | 3.0 |
| **Date** | 2026-11-01 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md), [PRD-004](PRD-004-rpc-task-surface.md), [PRD-006](PRD-006-standalone-bash-rendering-and-task-telemetry.md) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0**, `@earendil-works/pi-tui` |
| **Design principle** | **Focused, clean task screen.** Displays a full-width header `── Background Tasks ─────────`, session branch subtitle, scrollable task list with completion markers (`✓`, `●`, `✗`), right-aligned duration and task ID, and inline `Cwd` and `Log` paths for the selected task. There is only a single `/tasks` command (no `/bg-tasks`). |

---

## 1. Summary & Visual Layout

Invoking `/tasks` (or inspecting tasks from the bottom dock) displays the clean, focused task screen directly below the editor:

```
── Background Tasks ────────────────────────────────────────────────────────────────
3 tasks  current session branch

  ✓ test-slow                                                               8s task-1
> ✓ test-heartbeat                                                         12s task-2
  ✓ test-counter                                                            5s task-3

Cwd: /home/hati/workspace
Log: /home/hati/workspace/.pi/bg-tasks/task-2.log
```

### Components:

1. **Full-Width Header**:
   - `── Background Tasks ` followed by `─` extending to terminal width.
   - Title in `toolTitle` or `accent`, rule dashes in `dim`.
2. **Context Subtitle**:
   - `N tasks  current session branch` in `dim` (e.g. `3 tasks  current session branch`).
3. **Scrollable Task List**:
   - Selection indicator: `> ` on the active task row, `  ` on others.
   - Status marker:
     - `✓` (completed, green `success`)
     - `●` (running, green `success`)
     - `✗` (failed / killed, red `error`)
   - Task label: `task.taskName ?? task.command` (single line, truncated to fit).
   - Right-aligned: elapsed time (e.g. `8s`, `12s`) and task identifier (e.g. `task-1`, `task-2`).
   - Scrollable via keyboard (`↑`/`↓`) and mouse wheel.
4. **Selected Task Cwd & Log Telemetry**:
   - Rendered directly below the list for the currently highlighted task:
     ```
     Cwd: /home/hati/workspace
     Log: /home/hati/workspace/.pi/bg-tasks/task-2.log
     ```
   - LHS labels `Cwd:` and `Log:` colored in uniform blue (`mdLink`).
   - Paths rendered in `dim` / default text.
5. **No `/bg-tasks` Alias**:
   - Only `/tasks` is registered.
   - Pressing `Esc` closes the view and returns to the normal editor prompt.

---

## 2. Goals & Non-Goals

### Goals

| ID | Goal |
|---|---|
| **G1** | Header rule `── Background Tasks ──────────────────────────` scaled dynamically to window width. |
| **G2** | Context subtitle `N tasks  current session branch`. |
| **G3** | Task list with selection indicator `> `, completion markers (`✓`, `●`, `✗`), right-aligned duration and task ID. |
| **G4** | Direct display of `Cwd: <path>` and `Log: <path>` for the currently selected task. |
| **G5** | Remove `/bg-tasks` command alias; retain `/tasks` as the sole entry point. |
| **G6** | Mouse wheel and arrow key (`↑`/`↓`) scrolling through tasks when the list exceeds visible capacity. |
| **G7** | `Esc` collapses `/tasks` view and returns to the editor prompt. |

### Non-Goals

| ID | Non-Goal |
|---|---|
| **N1** | Heavy framed multi-border boxes (`┌─ Command ─┐`, `┌─ Latest output ─┐`) — replaced by this clean, lightweight layout. |
| **N2** | Separate fullscreen overlay modals. |
| **N3** | Registering `/bg-tasks`. |

---

## 3. Component Updates

### 3.1 `index.ts`
- Remove `pi.registerCommand("bg-tasks", ...)`.
- Update `pi.registerCommand("tasks", ...)` to open this focused task screen.

### 3.2 `src/ui/dock.ts`
- `renderTasksView(width, now)`:
  1. Computes header rule to exact `width`.
  2. Renders `${tasks.length} task${tasks.length === 1 ? '' : 's'}  current session branch`.
  3. Renders visible task rows with `>` marker, status marker, task name, and right-aligned duration + ID.
  4. Renders `Cwd: ${selectedTask.cwd}` and `Log: ${selectedTask.logPath}`.
- Handles mouse wheel and `↑`/`↓` scrolling over task list.

### 3.3 `src/ui/format.ts`
- Format helpers:
  - `taskHeaderLine(width, theme)`
  - `taskRowWithId(task, selected, width, now, theme)`
  - `taskCwdAndLogLines(task, theme)`
