# PRD-003: Background tasks — priority-aware `bg_task` tool, `ctrl+b` backgrounding, and agy-style task UI

| | |
| --- | --- |
| **Status** | Draft — ready for review |
| **Version** | 1.0 |
| **Date** | 2026-10-31 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-001](PRD-001-bash-nice-override.md) (nice override — superseded by §7.1 when this feature is active), [RESEARCH.md](RESEARCH.md) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0** (exports confirmed by reading `dist/*.d.ts`) |
| **Out of scope here** | Interactive `!` commands (`user_bash`), Windows `powershell` tool (PRD-002), timers/cron scheduling (§14), remote execution |

> **Current implementation note:** the masked `bash` tool, `ctrl+b`/`ctrl+h` foreground adoption, `adopt` action, and renice/ionice-on-adoption path described below were removed. Current releases expose separate `background_task` / `manage_background_task` tools and keep only the task UI, registry, and spawn-time priority. This document is retained as design history.

---

## 1. Summary

This spec adds **background task support** to `pi-bash-process-priority`:

1. The extension **takes over the built-in `bash` tool** (replacing the PRD-001 `tool_call` rewrite as the priority mechanism), owning the spawned process.
2. A new model-facing tool **`bg_task`** starts commands as **background tasks** that return immediately with a referenceable id (`task-1`, `task-2`, …) and run at a **lower priority than foreground commands**.
3. While a foreground `bash` command is running, a **`ctrl+b` hotkey** moves it into a background task without restarting it (`renice` + `ionice` on adoption).
4. An **agy-consistent task UI**: a live dock below the editor (`● [10:56:57] sleep 120 running`, `↑`/`↓` selection when the editor has nothing to cycle, `ESC` back to input), a `N task(s) · /tasks` status-line segment, a `/tasks` panel, and a Task Details view with streaming output.
5. Completed tasks **wake the agent** with a `<background-task-notification>` follow-up message — no polling.

Reference implementation of the UX: Google's **Antigravity CLI (`agy` 1.4.2)**. All UI strings, layouts, and interaction rules in this spec were captured from a live agy session and from the agy binary's embedded strings/changelog.

## 2. Problem statement

pi's built-in `bash` tool is all-or-nothing: a long-running command (dev server, watch mode, large build, test suite) blocks the turn until it exits, times out, or is aborted — and aborting kills the work. The model has no way to say "start this and check back later", and the user has no way to say "stop waiting on this" without destroying the process.

Desired outcome, mirroring agy:

- The **model** can launch work in the background and get woken on completion.
- The **user** can demote a running foreground command to the background with one keystroke.
- Background work runs at **lower CPU/IO priority** than foreground work — this extension's existing purpose, extended to the task lifecycle.
- All tasks are **visible and manageable**: ids, live status, output, kill, stdin.

## 3. Goals and non-goals

### Goals

| ID | Goal |
| --- | --- |
| G1 | `bash` tool behavior is **byte-identical** to the built-in tool when no backgrounding occurs: output, exit codes, timeouts, abort kill-tree, rendering, `PI_*` env, truncation. |
| G2 | `bg_task` starts a task, returns immediately with `task-N`, and the process runs in its own group at bg priority. |
| G3 | `ctrl+b` moves the currently running foreground `bash` command to a background task **without restarting or killing it**, renicing the group to bg priority. |
| G4 | Each task has a stable **id** (`task-N`) used by the tool surface, the UI, and notifications. |
| G5 | The dock, status line, `/tasks` panel, and Task Details view match the agy UI as specified in §8. |
| G6 | `↑`/`↓` reach the dock exactly when the editor has nothing left to cycle; `ESC` returns to input mode. |
| G7 | Completed tasks deliver a `<background-task-notification>` follow-up that triggers a turn (reactive wake, no polling). |
| G8 | Background tasks run at lower priority than foreground: nice `PI_BG_NICE_LEVEL` (default **19** vs. fg **10**) + `ionice` idle class when available. |
| G9 | Fail-open everywhere: missing `nice`/`ionice`/`renice` degrades priority only — never blocks execution; UI degrades to no-op in non-TUI modes. |
| G10 | Composition: renderers, permission gates, and other extensions keep working (the override spreads the built-in tool definition; renderer chain is untouched). |

### Non-goals

- **N1** — Interactive `!` commands and the Windows `powershell` tool (unchanged from PRD-001/002).
- **N2** — Timers/cron scheduling (`schedule`) in v1. The registry and UI are designed so timer entries can join later (§14).
- **N3** — Cross-session task survival. Tasks are session-scoped; killed on `session_shutdown` (§7.6).
- **N4** — Remappable hotkeys. `ctrl+b` is registered via `pi.registerShortcut("ctrl+b", …)` which binds a literal key; remapping via `keybindings.json` is future work.
- **N5** — CPU affinity, cgroups, memory limits.

## 4. Reference UI (captured from agy 1.4.2)

### 4.1 Dock below the input (the authoritative mock)

```
──────────────────────────────────────────────────────────────────────────────
  ● [10:56:57] sleep 120 running
> ● [10:56:54] sleep 120 running
  ● [10:56:52] sleep 120 running
──────────────────────────────────────────────────────────────────────────────
? for shortcuts                                     GPT-OSS 120B (Medium) · 3 task(s) · /tasks
```

- One line per **active** task, newest first, single line each (agy truncates; "Fixed large background tasks crowding out the prompt by limiting each active item below the input box to a single line").
- `●` bullet, `[HH:MM:SS]` local start time, truncated command, status word.
- `>` marks the selected row (selection exists only while the dock has focus).
- Hidden entirely when no tasks are running.

### 4.2 Task Details (opened from the dock / `/tasks`)

```
Task Details

Command: sleep 120
Status:  ● running
Type:    Agent
Started: 2026-10-31 10:56:54

────────────────────────────────────────
Output

(no output)

  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · esc back
```

- Output auto-scrolls to the bottom as the log grows; manual scroll-up disables follow until re-bottomed (agy behavior).
- Footer hints are rendered from the keybindings manager, not hardcoded.

### 4.3 Chat surface

- Foreground: pi's normal bash rendering (the override spreads the built-in renderers).
- A command moved to background ends its tool call immediately with agy's exact wording:

```
Tool is running as a background task with task id: task-N
```

- `bg_task` results render collapsed like any tool row.

### 4.4 Behavior reference (from agy strings/changelog)

- Completion wakes the agent: *"the system will notify you when they finish, so do not poll their status or set timers to check on them."*
- Still-running notice: `Background command is still running after %ds: %s`.
- Status vocabulary: `running` / `completed` / `failed` / `killed`; failures show a reason (`✗ (exit 1)`); kills show `Killed · <reason>`.
- Counts include every kind of background work, shown as `3 task(s)`.
- Timer labels use compact durations (`5m timer`, `1d 2h timer`) — reserved for N2.

## 5. Verified pi 1.4 API surface

All of the following were confirmed by reading the shipped type declarations of `@earendil-works/pi-coding-agent` 1.4.0:

| Mechanism | Declaration | Role in this spec |
| --- | --- | --- |
| `createBashToolDefinition(cwd, options)` | `dist/core/tools/bash.d.ts` → `ToolDefinition<bashSchema, BashToolDetails, BashRenderState>` | Produces the full built-in bash definition (schema, label, renderers with live duration ticker). |
| `BashOperations.exec(command, cwd, { onData, signal, timeout, env }) → Promise<{ exitCode: number \| null }>` | same file | The seam where we spawn and own the child. |
| `BashToolOptions.operations` / `spawnHook` / `commandPrefix` | same file | `operations` carries our executor; `spawnHook` still adjusts command/cwd/env (used for the fg nice wrap). |
| `pi.registerTool({ ...builtin, execute })` | `dist/core/extensions/types.d.ts` L1229 | Same-name registration replaces the built-in (official `ssh.ts` pattern). |
| `pi.registerShortcut("ctrl+b", { handler })` | types.d.ts L1233 | Dispatched through `CustomEditor.onExtensionShortcut`, i.e. **fires while the editor is focused during a running tool**. |
| `ctx.ui.setWidget(key, factory, { placement: "belowEditor" })` | types.d.ts L101, `WidgetPlacement` | The dock. |
| `ctx.ui.setFooter(factory)` / exported `FooterComponent` | types.d.ts L111, components index | Status-line segment composed with the built-in footer. |
| `ctx.ui.setEditorComponent(factory)` / exported `CustomEditor` | types.d.ts L175; `custom-editor.d.ts` | `DockEditor extends CustomEditor` implements the `↓` fall-through. |
| `ctx.ui.custom<T>(factory, { overlay, overlayOptions })` | types.d.ts L121 | `/tasks` panel and Task Details. |
| `pi.sendMessage(msg, { deliverAs: "followUp", triggerTurn: true })` | types.d.ts L1258 | Completion wake. |
| `pi.registerMessageRenderer<T>(customType, renderer)` — `MessageRenderer<T> = (message: CustomMessage<T>, options: { expanded, outputPad }, theme) => Component \| undefined` | types.d.ts L1169, L1250 | Custom transcript rendering of task notifications (§7.10); `expanded` mirrors pi's `ctrl+o` state. |
| `pi.registerToolRenderer(resolver)` | types.d.ts L1256 | Not needed in v1 (spread keeps built-in renderers); available if custom rows are ever required. |
| `Editor` internals (`history`, `historyIndex`) | `pi-tui/dist/components/editor.d.ts` | **Private** — the `↓` fall-through therefore keys off "editor is empty" (§8.1), with a refinement path (§14). |

## 6. Architecture

```
src/
├── nice.ts            (existing — reused for the fg wrap inside our exec)
├── probe.ts           (existing — extended: probe renice/ionice once per session)
├── registry.ts        TaskManager: spawn/adopt/kill/input/log, ids, states, listeners
├── bash-override.ts   our BashOperations + execute race; ctrl+b state machine
├── bg-task-tool.ts    bg_task tool definition (run/list/status/kill/input)
├── ui/
│   ├── dock.ts        below-editor widget (rows, selection marker, rules)
│   ├── footer.ts      `N task(s) · /tasks` segment composed with FooterComponent
│   ├── panel.ts       /tasks list + Task Details (ctx.ui.custom)
│   └── format.ts      glyphs, colors, durations, truncation (pure, unit-tested)
└── dock-editor.ts     DockEditor extends CustomEditor (↓ fall-through, dock-mode keys)
index.ts               wiring: activation gating, lifecycle, shortcuts, commands
```

Activation matrix:

| Condition | Behavior |
| --- | --- |
| Unsupported platform (win32/WSL-less per PRD-002) | No override, no tool, no UI. PRD-001 `tool_call` rewrite stays authoritative. |
| Override creation fails (unexpected) | Same as above + one diagnostic (fail-open, PRD-001 G4 style). |
| TUI mode | Full UI (dock, footer, panel, editor). |
| RPC mode | Tools + notifications; `ctx.ui.notify` for state changes; no custom components (`ctx.hasUI` guard). |
| Print/JSON mode | Tools + notifications only; no UI. |

## 7. Detailed design

### 7.1 `bash` tool override

```ts
const builtinBash = createBashToolDefinition(cwd, { operations: ourOperations });
pi.registerTool({ ...builtinBash, execute: ourExecute });
```

**`ourOperations.exec(command, cwd, { onData, signal, timeout, env })`**

1. Wraps `command` with the existing PRD-001 nice logic at spawn time: `nice -n <FG> bash -c '<command>'` (reuses `buildNiceCommand`/`escapeSingleQuotes`; the `tool_call` rewrite is **disabled while the override is active** — single-wrap guarantee, see §11).
2. Spawns with `detached: true` → the child leads its own process group (`pgid = child.pid`); stdout+stderr stream to `onData` **and** into a bounded tail buffer (last `PI_BG_LOG_BYTES` bytes are preserved for later log-file adoption).
3. Registers `signal` abort → kill group (`process.kill(-pgid, "SIGTERM")`, grace, then SIGKILL) — identical to built-in semantics (G1).
4. Registers `timeout` (if the model passed one) exactly like the built-in executor: timer → kill group → reject with `timeout:<s>`.
5. Resolves `{ exitCode }` on close (signal deaths mapped to `128+signum` per the contract).
6. Keeps the live child in a module-level **foreground slot**: `{ child, pgid, command, cwd, startedAt, onData, tail }` (one slot per in-flight call; parallel calls supported via a Map keyed by `toolCallId`).

**`ourExecute(id, params, signal, onUpdate, ctx)`** — the early-resolve race:

```ts
const builtinRun = builtinExecute(id, params, signal, onUpdate, ctx);   // spread-in definition
const backgrounded = waitForBackgroundRequest(id);                      // ctrl+b promise
const result = await Promise.race([
  builtinRun,
  backgrounded.then(() => BG_RESULT(taskId)),                           // §7.2
]);
builtinRun.catch(() => {});                                            // defuse the loser
return result;
```

- `BG_RESULT` is the agy wording (`§4.3`) as tool **content**, with `details: { taskId, outputPreview, fullOutputPath }` and `isError: false`.
- When the race resolves via backgrounding, `exec` is resolved with `{ exitCode: null }` so the abandoned built-in call settles immediately and its result is discarded; its abort listener and timeout timer are detached at that moment (§7.2 step 3).

### 7.2 `ctrl+b` — move a foreground command to background

Registered as `pi.registerShortcut("ctrl+b", handler)`; the handler is a no-op unless the foreground slot is occupied and the extension is active.

Adoption sequence (atomic, ordered):

1. **Register** the child in the TaskManager as `task-N` with `origin: "foreground-adopted"`, pre-filling the log file with the preserved tail buffer so the task log contains the full history.
2. **Reprioritize the group**: `renice -n <BG> -g <pgid>` and, if available, `ionice -c <CLASS> -p <pid>` (§7.4). Failures degrade to a notice line appended to the task log; adoption never fails because of this.
3. **Detach from the call**: remove the `signal` abort listener and the timeout timer; stop forwarding `onData` (the registry appends subsequent output to the log file instead); clear the foreground slot; resolve the abandoned `exec` promise.
4. **Return** the early tool result (`§4.3`). pi renders the call row as finished; the task keeps running.
5. UI updates via the registry change event: the dock row appears; the status-line count increments.

If pressed when nothing is running: no-op (no sound, no message — agy only shows the hint while a command runs). The running call's UI shows the hint `ctrl+b background` in the working indicator while a foreground bash is in flight (via `ctx.ui.setWorkingIndicator` if available; otherwise omitted — cosmetic).

### 7.3 TaskManager registry (`src/registry.ts`)

State per task:

```ts
interface BgTask {
  id: string;                 // "task-N" — N from a monotonically increasing session counter
  command: string;            // original command text (unwrapped)
  name?: string;              // optional model-provided name; survives everywhere (agy behavior)
  origin: "bg_task" | "foreground-adopted";
  status: "running" | "completed" | "failed" | "killed";
  pid: number | null; pgid: number | null;
  startedAt: number; endedAt: number | null;
  exitCode: number | null; signal: NodeJS.Signals | null;
  logPath: string;            // <logDir>/task-N.log
}
```

- **Spawn** (`bg_task run`): same discipline as §7.1 exec but at **bg priority from the start** (`nice -n <BG>` + `ionice` at spawn), `detached: true`, merged stdout/stderr appended to `task-N.log` (header: `$ <command>`, `[started] <ISO local>`).
- **Kill**: `process.kill(-pgid, "SIGTERM")` → grace `PI_BG_KILL_GRACE_MS` (default 3000) → `SIGKILL`; `ESRCH` counts as success. Status `killed`, reason recorded.
- **send_input**: write to the child's stdin pipe (`<input>\n`); error if not running or no pipe.
- **Logs**: model-visible reads are capped at `PI_BG_LOG_BYTES` (default 50 000) from the tail, with `[Full output: <path>]` notices (truncation pattern from pi-background-tasks/PRD-001 style).
- **Completion**: on close — status `completed` (exit 0) / `failed` (exit ≠ 0) / `killed` (we signaled); append `[exited] <code|signal> <duration>s` to the log; fire listeners.
- **Events**: a single `onChange()` callback drives dock/footer re-render and panel refresh.
- **Rebuild on `session_start`**: reconstruct finished tasks from prior `bg_task`/bash result `details` found via `ctx.sessionManager.getBranch()` (branch-aware, pi-canonical); the id counter resumes at `maxExisting + 1`; tasks that were `running` at snapshot time are re-marked `killed (session ended)`. No process is revived (N3).
- **Shutdown**: `session_shutdown` → kill all running (idempotent, bounded wait). Print mode: same, after the turn settles (agy waits with a deadline in `-p`; recorded as future work, §14).
- **Cap**: `PI_BG_TASKS_MAX` (default 100) finished tasks retained; oldest evicted.

### 7.4 Priority model

| Path | CPU | IO | Applied |
| --- | --- | --- | --- |
| Foreground `bash` | `nice -n <PI_BASH_NICE_LEVEL>` (default 10) — unchanged behavior | untouched | at spawn, inside our `exec` |
| `bg_task run` | `nice -n <PI_BG_NICE_LEVEL>` (default **19**) | `ionice -c <PI_BG_IONICE_CLASS>` (default **3**, idle; `0` = off) | at spawn |
| `ctrl+b` adoption | `renice -n <PI_BG_NICE_LEVEL> -g <pgid>` | `ionice -c <CLASS> -p <pid>` | at adoption |

- Probed once per session at `session_start` (extends existing `probe.ts`): `nice` (existing), `renice -n <BG> -g <pgid>` on a throwaway group, `ionice -c3 true`. Results gate only the priority claims, never execution (G9). One combined diagnostic if any probe fails.
- Rationale for defaults: fg 10 is PRD-001's contract; bg must be strictly lower — 19 is the unprivileged floor; `ionice -c3` (idle) matches "background work must never compete with the user".

### 7.5 Model-facing tools

> **Amended by [PRD-004](PRD-004-rpc-task-surface.md) v3:** background execution is a **parameter of the masked `bash` tool** (`background?: boolean`, `taskName?: string`) — not the `run` action below. `bg_task` is management-only (`list | status | kill | input | adopt`). The text below reflects PRD-003 v1.0 and is kept for history; PRD-004 §4 is authoritative for the tool surface.

**`bg_task`** — one tool, action-parameterized (agy's `run_command` + `manage_task` collapsed into pi's naming):

```ts
parameters: {
  action: enum["run", "list", "status", "kill", "input"],   // required
  command: string (required for "run"),
  name: string (optional, human-readable task name),
  taskId: string (required for "status" | "kill" | "input"),
  input: string (required for "input"),
}
```

- `run` → spawns per §7.3 and returns immediately:

  ```
  Tool is running as a background task with task id: task-7
  Output: /home/u/proj/.pi/bg-tasks/task-7.log
  Do not poll. You will be notified when it finishes.
  ```

- `list` → one line per task (running first): `task-7  sleep 120  running  (started 10:56:57)`; finished within the retention cap included; empty → `No background tasks.`
- `status` → status line + last ≤50 KB of log (tail-capped, `[Full output: …]` notice).
- `kill` → §7.3 kill; result `Killed task-7 (sleep 120).` (agy's step-line vocabulary).
- `input` → `Sent input to task-7.` / errors: `Cannot send input to command task-7: command not running.`

Prompt surface: `promptSnippet: "Start long-running commands as background tasks (task-N) and manage them"`, plus one guideline bullet: *"After starting a background task, proceed with other work or end your turn — you will be woken when it completes. Never poll."* `exposure: "direct"` (default), `executionMode: "parallel"` (never blocks other calls).

The built-in `bash` tool keeps its identity; its description is untouched (G1). `ctrl+b` is documented to the model only implicitly through results (the model sees `task-N` and the notification).

### 7.6 Notifications

On every terminal transition, once per task:

```xml
<background-task-notification>
  <task-id>task-7</task-id>
  <task-name>sleep 120</task-name>
  <origin>foreground-adopted</origin>
  <status>completed|failed|killed</status>
  <exit-code>0</exit-code>          <!-- omitted when signaled -->
  <signal>SIGKILL</signal>          <!-- omitted on normal exit -->
  <output-file>/…/.pi/bg-tasks/task-7.log</output-file>
  <summary>Background task "sleep 120" completed (exit 0)</summary>
</background-task-notification>
```

delivered via `pi.sendMessage({ customType: "bg-task-notification", content, display: true, details }, { deliverAs: "followUp", triggerTurn: true })` — this triggers a turn when idle and steers when streaming (pi semantics), satisfying G7. In TUI mode a `ctx.ui.notify` also fires when the agent is idle.

The split of responsibilities is pi-canonical: `content` (the XML above) is **model-facing**; `details` carries the structured snapshot (`BgTask` plus `kind` and render-ready duration strings) and is **not** sent to the model — it drives the transcript renderer (§7.10) and the `session_start` registry rebuild (§7.3).

**Still-running notice** (agy parity): `bg_task run` accepts `notificationTimeoutSeconds?: number` — a one-shot timer that (if the task is still running) sends the same channel a non-triggering message: `Background command is still running after <n>s: <command>`. For adopted foreground tasks this timer is armed only if the model set one before `ctrl+b` (it survives adoption).

### 7.7 Dock editor interaction (G6)

`DockEditor extends CustomEditor` (exported class), installed with `ctx.ui.setEditorComponent((tui, theme, keybindings) => new DockEditor(tui, theme, keybindings))`. State machine — `input` ⇄ `dock`:

- In `input` mode, `handleInput(data)`:
  - `↓` (via `keybindings`/`matchesKey` arrow sequences) **and `getText() === ""`** (nothing to cycle — Editor history is exhausted by definition) → if the dock has ≥1 row: enter `dock` mode (selection index 0), consume the key. Otherwise fall through to `super.handleInput`.
  - anything else → `super.handleInput(data)`. History recall, autocomplete, IME, paste: untouched (we only intercept the one fall-through case).
- In `dock` mode, `handleInput` consumes:
  - `↑`/`↓` → move selection (clamped), `Enter` → open Task Details for the selected task, `k` → kill selected, `ESC` → back to `input` mode (editor state untouched — it was never unfocused),
  - all other keys → silently consumed while in dock mode (agy parity: dock owns the keyboard), except `ctrl+c` which always reaches the app (pi safety valve).
- `ESC` from Task Details returns to `dock` mode; `ESC` from dock returns to `input` — matching "down/up arrow selects the running task and ESC goes back to input mode".
- Dock mode is only enterable when the widget is visible; submission (`Enter` in input mode) is unaffected.

### 7.8 UI rendering contracts (`src/ui/format.ts` — pure functions)

| Element | Format |
| --- | --- |
| Dock row (unselected) | `"  " + bullet + " [" + HH:MM:SS + "] " + command(truncated to width-24) + " " + status` |
| Dock row (selected) | `"> " + bullet + …` (same tail) |
| Bullet | `●` colored: running → `theme.fg("accent")`, completed → `success`, failed → `error`, killed → dim |
| Failed row suffix | `failed (exit 1)` / signal form `killed (SIGKILL)` |
| Rules | full-width `─` line above and below the row block |
| Footer segment | `"· N task(s) · /tasks"` appended after the built-in footer content; omitted when `N = 0`; `/tasks` rendered as a hint in `theme.fg("dim")` |
| Status line count | `N task(s)` where N = running tasks (+ timers once they exist) |
| Details panel | exact layout of §4.2; `Type: Agent` in v1 — mirrors agy, where the label denotes the **actor** (all v1 tasks are agent-initiated, including plain shell commands and `ctrl+b` adoptions); vocabulary reserved for §14: `Timer`, `Cron` |
| Details footer hints | from `KeybindingsManager` display strings: `↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · esc back` |
| Empty output | `(no output)` |
| Durations | compact (`45s`, `5m 12s`, `1d 2h`) — reserved for timers; dock uses start clock times like agy |

All rendered lines pass through `truncateToWidth`; widths re-measured on render (pi-tui contract). Widget and panel components cache per width and `invalidate()` on registry change (render coalescing via `tui.requestRender()`).

### 7.9 `/tasks` panel and Task Details

- `pi.registerCommand("tasks", { description: "View background tasks" })` opens the panel via `ctx.ui.custom<Component>` (fullscreen, not overlay) — same view set as the dock's Enter path.
- **List view**: rows in dock format; `↑/↓` select, `Enter` → detail, `k` kill, `s` input prompt, `ESC` close; height capped at `min(rows, ~10)` plus hints line (agy: "capping the panel height").
- **Task Details**: layout per §4.2. Output pane is a bounded `ScrollView` over a tail-read of the log (≤ `PI_BG_LOG_BYTES`, re-read on a 1 s ticker **only while the task is running and the panel is open**). Follow-the-bottom by default; any manual scroll-up disables follow until the user re-bottoms (`ctrl+end` or scroll to end) — agy's exact rule.
- `k` inside detail kills that task (confirm via `ctx.ui.confirm`).

### 7.10 Notification renderer (`registerMessageRenderer`)

Registered as `pi.registerMessageRenderer<BgNotificationDetails>("bg-task-notification", renderer)` so wake messages render as purpose-built transcript rows instead of raw XML. The renderer uses `message.details` (typed `T`) and `theme` only — never parses `content`. Returning `undefined` would fall back to pi's default rendering; this renderer always returns a component. Renderers apply to the interactive transcript **and** HTML exports (pi contract).

**`kind: "terminal"`** (task reached a final state) — collapsed (`options.expanded === false`), one themed line:

```
● task-2 completed · sleep 120 · exit 0 · 2m 01s
```

- dot color: `completed` → `success`, `failed` → `error`, `killed` → dim
- segments joined by ` · `, all truncated to width; `outputPad` respected
- duration = `endedAt − startedAt`, humanized (`45s`, `2m 01s`, `1h 04m`)
- failed adds `· exit 1` or `· SIGKILL`; killed adds `· <reason>`

Expanded (`ctrl+o`), the detail block:

```
● Background task completed — task-2
  Command:  sleep 120
  Ran:      2m 01s · started 10:56:52 · ended 10:58:53
  Origin:   bg_task | ctrl+b (foreground adopt)
  Output:   /home/u/proj/.pi/bg-tasks/task-2.log
  ────────────────────────────────────────
  <tail of output, ≤8 lines, tail-capped, indented two spaces>
```

**`kind: "still-running"`** (the §7.6 notice) — always a single dim line, never expands:

```
○ task-2 still running after 30s · sleep 120
```

Implementation notes: pure `format.ts` helpers produce the line strings (unit-tested); the component is a stateless `Text`-style render — no tickers, no invalidation churn (notification rows are immutable once written). If `details` is missing or unparseable (e.g. transcript edited elsewhere), the renderer returns `undefined` and pi renders the raw `content` — graceful degradation.

## 8. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BASH_NICE_LEVEL` | `10` | Foreground nice (existing, unchanged). |
| `PI_BG_NICE_LEVEL` | `19` | Background nice (spawn + renice-on-adopt), clamped 1–19, must be ≥ fg level (else clamped up). |
| `PI_BG_IONICE_CLASS` | `3` | Background IO class (`0` off, `2` best-effort, `3` idle). |
| `PI_BG_TASK_LOG_DIR` | `<cwd>/.pi/bg-tasks` | Task log directory (created lazily, gitignore respected). |
| `PI_BG_TASKS_MAX` | `100` | Finished tasks retained. |
| `PI_BG_KILL_GRACE_MS` | `3000` | SIGTERM→SIGKILL grace. |
| `PI_BG_LOG_BYTES` | `50000` | Model-visible log read cap + adoption tail buffer. |

## 9. Lifecycle

- **Factory**: registers everything; starts **no** timers/processes (pi contract).
- **`session_start`**: probe (`nice`/`renice`/`ionice`), activate override + tool + UI (TUI only), rebuild registry from the branch.
- **Runtime**: registry `onChange` → dock/footer invalidate + `requestRender`; 1 s tickers exist **only while** tasks are running (dock) or the detail panel is open — idle pi stays idle (agy's idle-CPU fix).
- **`session_shutdown`**: kill running tasks (bounded), stop tickers, restore editor/footer (`setEditorComponent(undefined)`, `setFooter(undefined)`), dispose widget. Idempotent (reload/exit/cancel converge).
- **`/reload`**: same path as shutdown→start; state rebuilds from transcript details.

## 10. Failure modes

| Failure | Behavior |
| --- | --- |
| `nice` missing/refused | Foreground runs unwrapped (PRD-001 fail-open); bg still spawns, priority claim dropped, one diagnostic. |
| `renice`/`ionice` missing/refused | Adoption proceeds; priority unchanged; notice appended to task log. |
| Registering override throws | Feature disabled for the session, PRD-001 hook stays active, one diagnostic. |
| Child spawn fails | Existing built-in error surface (G1 preserved). |
| Log file unwritable | Output stays in the in-memory tail; `status` serves from it; warning once. |
| Editor component already replaced by another extension | We chain: wrap the existing `getEditorComponent()` factory if present (compose, don't stomp). Same discipline for the footer. |
| Widget/panel in RPC/print mode | Skipped (`ctx.mode`/`ctx.hasUI` guards). |

## 11. Relationship to PRD-001

- While the override is active it is the **single source** of nice wrapping (applied inside `exec`); the `tool_call` rewrite is bypassed to guarantee exactly one `nice` layer (FR-4 of PRD-001 generalized).
- On override-creation failure the PRD-001 hook is the active mechanism again — no behavioral regression path.
- PRD-001's tests remain the acceptance baseline for G1 (byte-identical semantics), plus new adoption tests (§12).

## 12. Testing and validation

1. **Unit (pure modules, `node --experimental-strip-types`)** — `format.ts` (rows, truncation, glyphs, durations, **notification collapsed/expanded/still-running lines**), registry state machine (spawn→complete/kill, id monotonicity, rebuild-from-details, eviction), race logic (backgrounded-vs-finish ordering, loser defusal), config parsing/clamping.
2. **Smoke (real pi session)**
   - `ps -o pid,ni,cls,cmd` shows fg command at NI 10 / bg task at NI 19 + `ionice` class 3.
   - `bg_task run` returns `task-N` immediately; `status`/`list`/`kill`/`input` behave; log file tracks output.
   - `ctrl+b` on `sleep 60`: tool call ends instantly with the agy wording; `ps` shows the **same PID** reniced to 19; dock row appears; task completes and wakes the agent with the notification.
   - `↓` from an empty editor focuses the dock; `↑/↓` move `>`; `Enter` opens details; `ESC ESC` returns to input; editor history still works for non-empty input.
   - Byte-identical bash runs vs. pristine pi (PRD-001 §7 harness): output, exit codes, timeout, ESC kill-tree.
   - Idle CPU with dock visible and zero tasks: no tickers (ptime delta ≈ 0 over 30 s).
3. **Degradation** — repeat the above with `renice`/`ionice` shadowed by a PATH shim: everything still works, notices appear.

## 13. Security considerations

- The extension owns process-group kills; kills target only groups it created (adopted group = group it spawned). No pid reuse hazards beyond Node's normal child-process semantics (`detached` groups are killed by `-pgid`).
- `send_input` writes only to tasks of this session.
- Log files live under the workspace (`.pi/bg-tasks`); the model can read them with `read` — same exposure as tool output today; adoption preserves pre-backgrounding output in the log (it was already model-visible via streaming).
- `ctrl+b` cannot be triggered by model output — it is a user key.

## 14. Future work

- Timers/scheduled jobs join the registry (`Type: Timer`, `5m timer` labels) — the registry and UI already accept them.
- History-exhaustion refinement for `↓` (diff text across `super.handleInput` to detect mid-history exhaustion, not just empty-editor).
- Remappable hotkeys via `keybindings.json` action ids (needs `pi.registerShortcut` action-level support).
- Print-mode grace: wait bounded (`--print-timeout`) for running tasks instead of killing at settle; leave daemons optionally.
- `/tasks` fuzzy filter and kill-all; cross-session task adoption for `agy`-style resume.

## 15. References

- agy 1.4.2 live captures (dock, status line, Task Details, chat rows) — §4.
- agy binary strings: `Tool is running as a background task with task id: %s`, `Background command is still running after %ds: %s`, `No background tasks.`, `%d task(s)`, `Use /tasks to see background tasks and their status.`, `KeyBackgroundCommand`, async-termination guidance template.
- pi 1.4.0 declarations: `dist/core/tools/bash.d.ts`, `dist/core/extensions/types.d.ts`, `dist/modes/interactive/components/custom-editor.d.ts`, `dist/core/bash-executor.d.ts`, `examples/extensions/ssh.ts`, `examples/extensions/modal-editor.ts`, `examples/extensions/custom-footer.ts`, `docs/tui.md`, `docs/extensions.md`.
- [PRD-001](PRD-001-bash-nice-override.md), [PRD-002](PRD-002-cross-platform.md), [RESEARCH.md](RESEARCH.md).
