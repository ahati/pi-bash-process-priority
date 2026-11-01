# PRD-005: Unified Bottom Dock UX, Terminal Mouse Scrolling & Visual Status Hierarchy

| | |
| --- | --- |
| **Status** | Implemented & Verified |
| **Version** | 1.0 |
| **Date** | 2026-11-01 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md), [PRD-004](PRD-004-rpc-task-surface.md) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0**, `@earendil-works/pi-tui` |
| **Design principle** | **Single, compact, mouse-scrollable task surface with expandable history.** Background task inspection, output monitoring, and lifecycle management live below the editor in a unified dock widget. Running tasks are clamped to 3 rows. The `/tasks` command expands the dock in-place up to 40% vertical screen height to display all task history (running, completed, failed, killed) with `Esc` returning to normal view. Status icons (green dot, green tick, red cross) and uniform blue LHS labels provide clean visual hierarchy across dark and light themes. |

---

## 1. Summary

This specification defines the user interface and interaction enhancements for background tasks in `pi-bash-process-priority`:

1. **Compact 3-Row Clamped Dock & Dynamic 40% Expanded View**:
   - In normal view, the background task dock displays active running tasks clamped at `MAX_DOCK_VISIBLE = 3` rows, keeping vertical screen space clean and focused on the agent transcript and user prompt.
   - Invoking `/tasks` or `/bg-tasks` expands the dock in-place up to **40% of the vertical terminal height** (`Math.floor(termHeight * 0.4)`), bringing all task history (running, completed, failed, and killed).
   - Pressing `Esc` (or executing `/tasks` again) cleanly collapses the dock back to normal 3-row running-only view.
   - Viewport windowing (`listOffset`) dynamically adjusts when scrolling or navigating tasks with mouse or arrow keys, displaying contextual pagination hints (`(1–3 of 8 · scroll with mouse/arrows)` in normal mode, or `(1–12 of 25 · esc normal view · scroll with mouse/arrows)` in expanded mode).
2. **Terminal Mouse Support (SGR & Legacy Wheel Scrolling & Click-to-Select)**:
   Added full terminal mouse integration via `src/ui/terminal-mouse.ts`. Supports parsing SGR 1006 mouse escapes (`\x1b[<...M`) and legacy X10 mouse tracking (`\x1b[M...`). Intercepts mouse wheel up/down in both standard and fullscreen/alt-screen TUI modes:
   - Wheel scrolling on the dock list navigates through tasks when count exceeds visible height.
   - Wheel scrolling inside the task detail view scrolls the live output log tail.
   - Left-click selects a dock row directly.
   - Terminal mouse reporting is cleanly enabled on mount and restored on disposal without escape sequence leakage into the prompt.
3. **Status Icon Prefix Vocabulary (`●`, `✔`, `✗`)**:
   Clear, universally supported status prefix glyphs:
   - **Running**: Green dot `●` (themed with `success` / green).
   - **Completed (success)**: Green tick `✔` (themed with `success` / green, exit code 0 or null).
   - **Failed / Killed**: Red cross `✗` (themed with `error` / red, non-zero exit code or terminated via signal/user kill).
4. **Task Details Uniform Blue LHS Labels & Red/Green Status RHS**:
   Task Details header lines standardize on a uniform blue color that provides optimal contrast and clarity across both dark and light terminal themes:
   - All LHS labels (`Command:`, `Status:`, `Type:`, `Started:`, `PID:`, `Exit:`, `Output:`, `Size:`) are rendered using the `mdLink` theme token (`"blue"` in Pi themes).
   - The status value on the RHS is rendered **red** (`error`) or **green** (`success`) based on task completion status in both Task Details and dock list rows.
5. **Harmonized In-Place `/tasks` and `/bg-tasks` Commands**:
   Restored `/tasks` and `/bg-tasks` command parity with upstream, replacing the jarring fullscreen overlay modal with an in-place dock expansion filling up to 40% of the vertical screen.

---

## 2. Problem Statement

1. **Screen Real-Estate vs Task History Dilemma**:
   Earlier dock prototypes displayed all running tasks without bound, or required a separate fullscreen overlay (`/tasks`) that obscured terminal history and disrupted user context. Users needed a way to keep the default dock compact (max 3 rows) while being able to expand history up to 40% of screen height on demand.
2. **Lack of Mouse Wheel Usability**:
   Users in modern terminal emulators (macOS Terminal, iTerm2, Kitty, WezTerm, VS Code integrated terminal, Alacritty) intuitively expect trackpad and mouse wheel gestures to scroll through lists and log outputs. Keyboard-only navigation (`↑`/`↓`/`PgUp`/`PgDn`) created unnecessary interaction friction.
3. **Inconsistent and Jarring Visual Styling**:
   Monochrome bullets or overly busy multi-colored LHS labels created visual noise. Different terminal background colors (dark vs light themes) rendered some labels unreadable.
4. **Disjoint Navigation**:
   Switching between active task monitoring and full task history required disparate command workflows instead of a single, fluid dock widget that expands and collapses in-place via `Esc`.

---

## 3. Goals & Non-Goals

### Goals

| ID | Goal |
|---|---|
| **G1** | Dock visible items clamped to strictly at most 3 rows by default (`MAX_DOCK_VISIBLE = 3`), showing running tasks only. |
| **G2** | `/tasks` and `/bg-tasks` commands expand the dock in-place up to 40% of terminal height (`Math.floor(termHeight * 0.4)`), showing all tasks (running, completed, failed, killed). |
| **G3** | `Esc` collapses the expanded `/tasks` dock back to normal 3-row view (or exits dock mode if already in normal view). |
| **G4** | Smooth viewport windowing (`listOffset`) with dynamic clamping when tasks finish, are killed, or are selected via arrows or mouse wheel. |
| **G5** | Full mouse wheel support (wheel up / down) scrolling both dock tasks and detail output lines in standard terminal mode and alt-screen mode. |
| **G6** | Direct row selection via mouse click. |
| **G7** | Intuitive visual icons: green dot (`●`) for running, green tick (`✔`) for clean completion, red cross (`✗`) for failure/kill. |
| **G8** | Uniform blue LHS labels (`mdLink`) for cross-theme readability (dark and light) with binary red/green RHS status rendering. |

### Non-Goals

| ID | Non-Goal |
|---|---|
| **N1** | Multi-column dock layouts (horizontal space is reserved for single-line command display and elapsed time). |
| **N2** | Mouse dragging for window resizing (clamped 3-row and 40% expanded modes satisfy ergonomic needs). |
| **N3** | External web or browser dashboard for tasks. |

---

## 4. Architectural & Component Details

### 4.1 Terminal Mouse Support (`src/ui/terminal-mouse.ts`)

Terminal mouse reporting is activated using standard VT200 / SGR ANSI private mode escape codes:
- Enable: `\x1b[?1000h\x1b[?1002h\x1b[?1006h`
- Disable: `\x1b[?1006l\x1b[?1002l\x1b[?1000l`

#### Protocol Parsing (`parseMouseInput`)

```ts
export interface MouseInputParseResult {
  sawMouse: boolean;
  wheelDelta: number; // -1 for wheel up, 1 for wheel down, 0 otherwise
  isClick: boolean;
  isRelease: boolean;
  x?: number;
  y?: number;
  button?: number;
}
```

- **SGR Format (`\x1b[<b;x;yM` / `\x1b[<b;x;ym`)**:
  - Button code `64`: Wheel Up $\rightarrow$ `wheelDelta: -1`.
  - Button code `65`: Wheel Down $\rightarrow$ `wheelDelta: 1`.
  - Button code `0` with final `M`: Left click down with `(x, y)` coordinate tracking.
- **Legacy Format (`\x1b[Mcbxy`)**:
  - Byte `0x60`: Wheel Up $\rightarrow$ `wheelDelta: -1`.
  - Byte `0x61`: Wheel Down $\rightarrow$ `wheelDelta: 1`.
- **Transparency**: Non-mouse keyboard input returns `{ sawMouse: false, wheelDelta: 0 }` so standard keyboard processing continues unaffected.

### 4.2 Dock Viewport Clamping, Dynamic 40% Expansion & Windowing (`src/ui/dock.ts`)

```ts
export const MAX_DOCK_VISIBLE = 3;
```

#### Normal vs Expanded Mode
- **Normal View (`isExpanded = false`)**:
  - Displays **running tasks only** (`getRunningTasks()`).
  - Viewport is clamped to `visibleCount = Math.min(totalCount, MAX_DOCK_VISIBLE)`.
  - Header: `Tasks`.
  - Pagination: `(1–3 of 8 · scroll with mouse/arrows)` when `totalCount > 3`.
- **Expanded View (`isExpanded = true`, triggered via `/tasks` or `/bg-tasks`)**:
  - Displays **all tasks** (`getAllTasks()`), including completed, failed, and killed.
  - Viewport expands dynamically up to 40% of the vertical terminal height:
    ```ts
    getMaxVisible(termHeight?: number): number {
      if (!this.expanded) return MAX_DOCK_VISIBLE;
      const h = termHeight ?? 24;
      return Math.max(MAX_DOCK_VISIBLE, Math.floor(h * 0.4));
    }
    ```
  - Header: `Tasks (all)`.
  - Pagination: `(1–12 of 25 · esc normal view · scroll with mouse/arrows)`.
  - `Esc` key cleanly triggers `collapseTasks()` to restore normal view.

#### Viewport Math
- `listOffset` maintains the start index of the visible window.
- When `selectedIndex < listOffset`, `listOffset` decrements to `selectedIndex`.
- When `selectedIndex >= listOffset + visibleCount`, `listOffset` increments to `selectedIndex - visibleCount + 1`.
- When tasks finish or are removed, `reconcile()` clamps `listOffset` to `Math.max(0, count - maxVisible)`.

### 4.3 Dual-Mode Mouse Dispatching

```
User scrolls mouse wheel
 │
 ├── Alt-Screen Mode (TUI) ───────► DockComponent.handleMouse(event: TuiMouseEvent)
 │                                   ├─ wheelup/down in detail view ──► scrollDetail(delta)
 │                                   └─ wheelup/down in dock list   ──► scrollList(delta)
 │
 └── Standard Mode (DockEditor) ──► DockEditor.handleInput(data: string)
                                     ├─ parseMouseInput(data)
                                     ├─ if detail view active ────────► scrollDetail(delta)
                                     └─ else ────────────────────────► scrollList(delta)
```

In standard inline mode, `DockEditor.handleInput()` traps raw mouse sequences before the parent `Editor` class processes them, preventing garbage escape characters from entering the text prompt.

### 4.4 Status Icon Prefix (`taskStatusIcon` in `src/ui/format.ts`)

```ts
export function taskStatusIcon(
  task: BgTask,
  theme?: { fg: (color: any, text: string) => string },
): string {
  if (task.status === "running") {
    const icon = "●";
    return theme ? theme.fg("success", icon) : icon;
  }
  if (task.status === "completed" && (task.exitCode === null || task.exitCode === undefined || task.exitCode === 0)) {
    const icon = "✔";
    return theme ? theme.fg("success", icon) : icon;
  }
  const icon = "✗";
  return theme ? theme.fg("error", icon) : icon;
}
```

### 4.5 Task Details Uniform Blue LHS Labels & Red/Green RHS Status (`detailLines` in `src/ui/format.ts`)

```
Task Details

Command: sleep 10
Status:  ● running · 4s
Type:    Agent
Started: 2026-11-01 14:00:00
PID:     1234
Exit:    0
Output:  /tmp/task-1.log
Size:    2.4 KB
────────────────────────────────────────────────────────────
Output
```

#### Color Mapping Matrix

| Field | Side | Role | Theme Token | Resolves To |
|---|---|---|---|---|
| `Command:`, `Status:`, `Type:`, `Started:` | LHS | Task attributes | `mdLink` | Blue (works in both dark & light themes) |
| `PID:`, `Exit:`, `Output:`, `Size:` | LHS | Extended metadata | `mdLink` | Blue (works in both dark & light themes) |
| `running · 5s` / `completed` | RHS | Healthy status | `success` | Green |
| `failed (exit 1)` / `killed` | RHS | Error status | `error` | Red |

When `theme` is omitted (e.g. in headless unit tests), plain unformatted strings are returned to preserve 100% backward compatibility with string-matching assertions.

---

## 5. Verification & Test Plan

1. **Unit Testing (`tests/mouse-and-status-prefix.test.ts`, `tests/format.test.ts`)**:
   - Status icon tests verifying `●` (green dot) for running, `✔` (green tick) for success, and `✗` (red cross) for failed/killed.
   - SGR and legacy mouse escape parsing verifying `wheelDelta: -1` and `1`.
   - `DockController` normal mode 3-row viewport clamping and `/tasks` expanded mode 40% vertical height calculation.
   - Uniform LHS label coloring assertions (`[mdLink]Command:[/mdLink]`, `[mdLink]Status:[/mdLink]`, etc.).
   - Binary red/green RHS status assertions for success and error conditions.
2. **E2E Terminal Regression Suites**:
   - `tests/e2e-tui.mjs`: Tests dock row visibility, selection marker `> ●`, detail view transitions, arrow navigation, and task termination via `k`.
   - `tests/e2e-subagent-task.mjs`: Tests subagent background task rendering, live duration ticking, and metadata verification.
   - `tests/e2e-tui-autorelease.mjs`: Tests dock auto-release behavior when running tasks complete.
   - `tests/e2e-rpc.mjs`: Tests RPC protocol compliance with updated status and icons.
