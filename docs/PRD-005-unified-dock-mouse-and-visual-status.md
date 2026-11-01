# PRD-005: Unified Bottom Dock UX, Terminal Mouse Scrolling & Visual Status Hierarchy

| | |
| --- | --- |
| **Status** | Implemented & Verified |
| **Version** | 1.0 |
| **Date** | 2026-11-01 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md), [PRD-004](PRD-004-rpc-task-surface.md) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0**, `@earendil-works/pi-tui` |
| **Design principle** | **Single, compact, mouse-scrollable task surface.** All background task inspection, output monitoring, and lifecycle management live below the editor in a unified 3-row clamped dock widget. There are no competing fullscreen overlay commands. Status icons and distinct label colors provide instantaneous visual recognition. |

---

## 1. Summary

This specification defines the user interface and interaction enhancements for background tasks in `pi-bash-process-priority`:

1. **Compact 3-Row Clamped Dock**:
   The visible background task dock is capped at `MAX_DOCK_VISIBLE = 3` rows, keeping vertical screen space clean and focused on the agent transcript and user input prompt. Viewport windowing (`listOffset`) dynamically adjusts when scrolling or navigating tasks, displaying a contextual pagination hint `(offset + 1–offset + visibleCount of count · scroll with mouse/arrows)` when more than 3 tasks exist.
2. **Terminal Mouse Support (SGR & Legacy Wheel Scrolling & Click-to-Select)**:
   Added full terminal mouse integration via `src/ui/terminal-mouse.ts`. Supports parsing SGR 1006 mouse escapes (`\x1b[<...M`) and legacy X10 mouse tracking (`\x1b[M...`). Intercepts mouse wheel up/down in both standard and fullscreen/alt-screen TUI modes:
   - Wheel scrolling on the dock list navigates through tasks when count exceeds 3.
   - Wheel scrolling inside the task detail view scrolls the live output log tail.
   - Left-click selects a dock row directly.
   - Terminal mouse reporting is cleanly enabled on mount and restored on disposal without escape sequence leakage into the prompt.
3. **Status Icon Prefix Vocabulary (`⏳`, `✔`, `✗`)**:
   Replaced generic monochrome dots with unambiguous status prefix glyphs:
   - **Running**: Sand-clock `⏳` (themed with `warning` / yellow).
   - **Completed (success)**: Green tick `✔` (themed with `success` / green, exit code 0 or null).
   - **Failed / Killed**: Red cross `✗` (themed with `error` / red, non-zero exit code or terminated via signal/user kill).
4. **Task Details Color Hierarchy & Red/Green Status RHS**:
   Task Details header lines now follow a distinct semantic color hierarchy:
   - `Command:` $\rightarrow$ `accent` (cyan)
   - `Status:` $\rightarrow$ `warning` (yellow)
   - `Type:` $\rightarrow$ `toolTitle` (blue)
   - `Started:` $\rightarrow$ `muted` (light mauve/subtle foreground)
   - Metadata rows (`PID:`, `Exit:`, `Output:`, `Size:`) $\rightarrow$ `dim` (gray)
   - The status value on the RHS is colored **red** (`error`) or **green** (`success`) based on status outcome in both Task Details and dock list rows.
5. **Deprecation and Removal of `/tasks` Command**:
   Removed the standalone `/tasks` slash command registration and its fullscreen overlay panel from `index.ts`. All background task listing, status monitoring, log tail inspection, and task termination are consolidated into the bottom dock widget.

---

## 2. Problem Statement

1. **Screen Real-Estate Waste**:
   Earlier dock prototypes displayed up to 7 or more tasks simultaneously, consuming over a third of typical 24–40 row terminal viewports. This pushed chat history and editor lines offscreen.
2. **Lack of Mouse Wheel Usability**:
   Users in modern terminal emulators (macOS Terminal, iTerm2, Kitty, WezTerm, VS Code integrated terminal, Alacritty) intuitively expect trackpad and mouse wheel gestures to scroll through lists and log outputs. Keyboard-only navigation (`↑`/`↓`/`PgUp`/`PgDn`) created unnecessary interaction friction.
3. **Flat, Monochromatic Status Indication**:
   Monochrome bullets (`●`) and uniform white label text forced users to read full lines to determine if a background task was running, finished cleanly, or crashed.
4. **Fragmented UI Surfaces**:
   Having both a below-editor dock widget and a separate `/tasks` fullscreen overlay created redundant, competing display elements that confused users and added maintenance overhead.

---

## 3. Goals & Non-Goals

### Goals

| ID | Goal |
|---|---|
| **G1** | Dock visible items clamped to strictly at most 3 rows at all times (`MAX_DOCK_VISIBLE = 3`). |
| **G2** | Smooth viewport windowing (`listOffset`) with dynamic clamping when tasks finish, are killed, or are selected via arrows. |
| **G3** | Full mouse wheel support (wheel up / down) scrolling both dock tasks and detail output lines in standard terminal mode and alt-screen mode. |
| **G4** | Direct row selection via mouse click. |
| **G5** | Unambiguous visual icons (`⏳`, `✔`, `✗`) rendered on every task line. |
| **G6** | Distinct theme colors for LHS labels (`Command:`, `Status:`, `Type:`, `Started:`) and binary red/green RHS status rendering. |
| **G7** | Single source of truth for task UI: eliminate the `/tasks` command and rely solely on the bottom dock. |

### Non-Goals

| ID | Non-Goal |
|---|---|
| **N1** | Multi-column dock layouts (horizontal space is reserved for single-line command display and elapsed time). |
| **N2** | Mouse dragging for window resizing (fixed 3-row limit satisfies ergonomic goals). |
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

### 4.2 Dock Viewport Clamping & Windowing (`src/ui/dock.ts`)

```ts
export const MAX_DOCK_VISIBLE = 3;
```

#### Viewport Math
- `visibleCount = Math.min(totalCount, MAX_DOCK_VISIBLE)`
- `listOffset` maintains the start index of the 3-item window.
- When `selectedIndex < listOffset`, `listOffset` decrements to `selectedIndex`.
- When `selectedIndex >= listOffset + visibleCount`, `listOffset` increments to `selectedIndex - visibleCount + 1`.
- When tasks are removed from the registry, `reconcile()` clamps `listOffset` to `Math.max(0, count - MAX_DOCK_VISIBLE)`.
- When `totalCount > 3`, the dock appends a subtle pagination line:
  ```
    (1–3 of 8 · scroll with mouse/arrows)
  ```

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
    const icon = "⏳";
    return theme ? theme.fg("warning", icon) : icon;
  }
  if (task.status === "completed" && (task.exitCode === null || task.exitCode === undefined || task.exitCode === 0)) {
    const icon = "✔";
    return theme ? theme.fg("success", icon) : icon;
  }
  const icon = "✗";
  return theme ? theme.fg("error", icon) : icon;
}
```

### 4.5 Task Details Color Hierarchy (`detailLines` in `src/ui/format.ts`)

```
Task Details

Command: sleep 10
Status:  ⏳ running · 4s
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

| Field | Side | Role | Theme Token | Fallback Color |
|---|---|---|---|---|
| `Command:` | LHS | Action identification | `accent` | Cyan |
| `Status:` | LHS | State header | `warning` | Yellow / Gold |
| `Type:` | LHS | Origin attribution | `toolTitle` | Blue |
| `Started:` | LHS | Timestamp header | `muted` | Light Mauve / White |
| `PID:`, `Exit:`, `Output:`, `Size:` | LHS | Extended metadata | `dim` | Dark Gray |
| `running · 5s` / `completed` | RHS | Healthy status | `success` | Green |
| `failed (exit 1)` / `killed` | RHS | Error status | `error` | Red |

When `theme` is omitted (e.g. in headless unit tests), plain unformatted strings are returned to preserve 100% backward compatibility with string-matching assertions.

---

## 5. Verification & Test Plan

1. **Unit Testing (`tests/mouse-and-status-prefix.test.ts`)**:
   - Status icon tests verifying correct glyphs and theme color tokens for running, completed, failed, and killed states.
   - SGR and legacy mouse escape parsing verifying `wheelDelta: -1` and `1`.
   - `DockController` 3-row viewport clamping, scroll up/down math, and bounds checking.
   - Distinct LHS label coloring assertions (`[accent]Command:[/accent]`, `[warning]Status:[/warning]`, `[toolTitle]Type:[/toolTitle]`, `[muted]Started:[/muted]`).
   - Binary red/green RHS status assertions for success and error conditions.
2. **E2E Terminal Regression Suites**:
   - `tests/e2e-tui.mjs`: Tests dock row visibility, selection marker `> ⏳`, detail view transitions, arrow navigation, and task termination via `k`.
   - `tests/e2e-subagent-task.mjs`: Tests subagent background task rendering, live duration ticking, and metadata verification.
   - `tests/e2e-tui-autorelease.mjs`: Tests dock auto-release behavior when running tasks complete.
