# PRD-007: Detail-View Layout Stabilization — Fixed Two-Panel vs. Single-Scroll Subpage

| | |
| --- | --- |
| **Status** | Approved Specification · Phase 1 (Approach A) Implemented & Verified |
| **Version** | 0.2 |
| **Date** | 2026-11-02 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-005](PRD-005-unified-dock-mouse-and-visual-status.md) (unified master-detail screen) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.5.0**, `@earendil-works/pi-tui` (main-screen renderer, widget & mouse model) |
| **Design principle** | **Constant widget geometry.** Whatever the internal arrangement, the expanded dock widget's total line count must be a pure function of `(terminalHeight, user-resized panel size)` — never of `(selection, task count, output volume)`. Two candidate arrangements are specified: **Approach A** keeps the two-panel split at fixed offsets with a user-resizable boundary; **Approach B** merges both panels into one internally scrollable subpage. |

---

## 1. Problem Statement

The expanded master-detail dock (PRD-005) visibly flickers/jumps when the selection changes, and shifts when tasks spawn, finish, or produce output. Root causes, in the current render path (`src/ui/dock.ts`, expanded branch of `factory().render()`):

| ID | Cause | Location |
| --- | --- | --- |
| RC-1 | **Two-phase async tail.** On selection change the cached tail belongs to the previous task, so the output pane renders a single `(no output yet)` row; the async `boundedRead` completes milliseconds later and triggers a second render with up to N real lines. Two renders per selection, height jumps 1 → N. | `dock.ts:422` (cache check), `dock.ts:317–335` (`refreshDockTail` + `requestRender` in `finally`), `dock.ts:464` |
| RC-2 | **Data-dependent tail height.** `maxOutputHeight` is fixed per terminal size, but the rendered slice is `outputLines.slice(...)` — tasks with less output render fewer rows; empty output renders one row. | `dock.ts:448`, `dock.ts:462–465` |
| RC-3 | **Variable metadata block.** `taskMetadataLines()` emits 4 base lines plus *optional* `Cwd:`/`Log:` lines → 4–6 rows depending on the selected task's fields. | `format.ts:293–331` |
| RC-4 | **Variable list block.** `visibleCount = min(count, maxVisible)` and a pagination-hint line that appears/disappears; changes on task spawn/exit and on scroll position. | `dock.ts:378–401` |

Amplifier: the widget is registered `belowEditor` — between the editor and the footer. pi-tui's main-screen renderer is line-diff based (rewrites only `firstChanged..lastChanged`), but any height change shifts the footer and forces a rewrite of the whole lower region. When the total rendered line count shrinks below the historical maximum and clear-on-shrink is enabled, the renderer escalates to a full-screen redraw (`tui-main-screen.js` `fullRender` paths). The result is the perceived "dock flicker".

Non-goals:

- No change to the compact (collapsed) dock rows, task lifecycle, notification surfaces, or the RPC surface.
- No change to the fleet-coordinator hand-off hooks (Tab/← switching); they are duck-typed, optional, and orthogonal to layout.
- This extension remains fully standalone; no dependency on any other extension is introduced.

## 2. Platform Constraints (facts this design relies on)

1. **Implicit widget height.** A component-factory widget's height is simply the number of lines `render(width)` returns. There is no fixed-height API — but constant height is trivially achievable by padding. (`InteractiveMode.MAX_WIDGET_LINES = 10` truncation applies **only** to `string[]` widgets; the dock already uses the factory form and is unaffected.)
2. **Internal scroll only.** A `belowEditor` widget is re-rendered pinned near the bottom every frame; terminal scrollback cannot serve as the panel's scrollback. Any scrolling must be widget-internal state — which the output tail viewer already is (`logScroll`/`logFollow`/`scrollDetail`, `dock.ts:52–53`, `243–257`).
3. **Line-diff renderer.** pi-tui rewrites only the changed range (`firstChanged..lastChanged`) inside synchronized output (`\x1b[?2026h`); unchanged geometry means selection changes rewrite line *contents in place* — no reflow, no footer movement.
4. **Mouse support is mode-dependent.**
   - *Fullscreen (alt-screen) TUI:* parses SGR press/drag/release/move and dispatches normalized `TuiMouseEvent`s to components, honoring `TuiMouseEventResult.capture` routing — a drag handle works natively.
   - *Regular (main-screen) TUI:* pi-tui does not parse mouse sequences; this extension's own `parseMouseInput` (`src/ui/terminal-mouse.ts`) does. Today it detects wheel and primary press only. Motion-with-button (`button & 32`) and release (`m`) parsing must be added for a mouse drag handle — feasible because the extension already enables mouse mode `1002h` (button-event tracking), so terminals already report motion.
5. **Input interception already exists.** `handleDockInput` is registered via `ctx.ui.onTerminalInput` and swallows all keys while the dock is active (`index.ts:405–419`, `dock.ts:601+`); new resize keys need no new plumbing.
6. **Hardcoded layout constants.** The wheel split `(event.y ?? 0) > 8` (`dock.ts:537`) and click mapping `headerOffset = 3` (`dock.ts:553`) assume the current section heights. Any redesign must derive them from the layout (both approaches do). Side finding: clicking the pagination-hint row currently maps to a task index past the visible window; fixed layout eliminates that class of bug.
7. **Tail reservoir bound.** The detail output is a 128 KiB tail (`DETAIL_TAIL_BYTES`, `log-reader.ts:6`), not the whole log. Scroll depth is bounded by the reservoir in both approaches unless backward paging is added (out of scope here; noted in §9).

## 3. Shared Groundwork (required by both approaches)

Both approaches stand on the same four changes. They are worth landing first regardless of which approach is chosen, because each independently removes a flicker source:

- **G1 — Constant-height contract.** `render()` pads or clamps every section to a fixed row budget. Total height = `f(terminalHeight, persisted panel size)`. This alone kills RC-2/RC-3/RC-4 symptoms.
- **G2 — Tail cache hardening.** Keep the widget geometry during the async gap of RC-1 (fixed height does this), and optionally add a small per-task tail LRU (last ~4 task ids) or dim-render the stale tail until the fresh read lands, so the *content* doesn't blank either.
- **G3 — Derived hit-test constants.** A single `layoutMetrics(termHeight, panelSize)` helper returns section boundaries; `handleMouse` (wheel split, click mapping) reads from it instead of the literals `8` and `3`.
- **G4 — Registry-change hygiene.** `render()` currently re-registers the widget factory on every `registry.onChange` (`dock.ts:335–357`: the `onChange` subscription calls `render()`, which calls `ctx.ui.setWidget(...)` unconditionally), tearing down and recreating the component. Register once; on change only update state + `requestRender()`.

---

## 4. Approach A — Fixed Two-Panel with Resizable Boundary

Keep the PRD-005 split (master list above, details + output below) but pin every section to a fixed vertical offset. The boundary between the panels is a 1-row handle the user can move (keyboard primary, mouse drag secondary).

### 4.1 Layout contract

```
── Background Tasks ──────────────────────────────── 3 tasks · 1–3 of 7   ← fixed 3-row header
  ✓ test-slow                    8s task-1   ┐
> ● test-heartbeat              12s task-2   │  L rows, always exactly L
  ✗ test-counter                 5s task-3   │  (blank pad rows when fewer tasks;
        ⋮                                    ┘   window indicator folded into header)

⇕  (drag or +/- to resize) ─────────────────────────────────              ← 1 handle row, always

Task Details                                                             ← fixed 1
Command: test-heartbeat                                                  ┐
Status:  ● running · 12s                                                 │
Type:    Agent                                                           │  M rows, always exactly M
Started: 2026-11-02 10:12:40                                             │  (pad when Cwd/Log absent)
Cwd:     /home/hati/workspace                                            │
Log:     /home/…/task-2.log                                              ┘
──────────────────────────────────────────────────────────────────        ← fixed 1
Output                                                                   ← fixed 1
                                                                         ← fixed 1 blank
[10:12:41] step 1 done                                                   ┐
[10:12:42] step 2 done                                                   │  O rows, always exactly O
       ⋮                                                                 ┘  (dim pad rows when short)

following tail 1.2KB · ↑/↓ select · +/- resize · PgUp/PgDn log · esc     ← fixed 1
```

Height formula:

```
H = 3 (header) + L (list) + 1 (handle) + 1 (details title)
  + M (metadata, 6) + 1 (rule) + 2 (output title + blank)
  + O (output) + 1 (status line)
H = 15 + L + O
```

Clamps: `L ≥ 3`, `O ≥ 4`, `H ≤ termHeight − reserve` (reserve ≈ editor + footer rows). The pagination-hint line is removed as a *toggling* row; the `1–N of M` window indicator moves into the fixed header row (right-aligned, as in the mockup).

### 4.2 Resize model

- **State:** `listRows` (or a `splitRatio`) stored on `DockController`; `getMaxVisible()` (`dock.ts:158–164`) is replaced by this persisted value — the 40%-of-terminal heuristic disappears.
- **Keyboard (primary, mode-independent):** `+`/`-` (or `shift+↑`/`shift+↓`) while the dock is active adjust `listRows` by 1; `handleDockInput` already owns the keyboard. Re-clamp on terminal resize.
- **Mouse drag (secondary):** `handleMouse` returns `{ handled: true, capture: true }` on `press` within the handle row; pi-tui retargets subsequent `drag`/`release` events to the widget (`TuiMouseEventResult.capture`), and the new `listRows` derives from `event.screenY` vs. the widget origin (`screenY − localY`). Works natively in fullscreen mode. In regular mode, extend `parseMouseInput` with motion/release SGR parsing and keep drag state in the controller (§2.4).
- **Persistence:** keep the value for the session; optionally persist to extension settings later (not required for v1).

### 4.3 Edge cases

| Case | Behavior |
| --- | --- |
| Task count changes | List pads/clips to `L`; nothing below moves. Window indicator in header updates. |
| Selection change | Metadata + output rows rewrite in place; heights unchanged (G1 + G2). |
| Terminal resize | Re-clamp `L`, `O`; pi-tui full-redraws on height change anyway (one-shot). |
| Small terminals | Clamps guarantee `H ≤ termHeight − reserve`; if even minimums don't fit, fall back to `L = 3, O = 4` and let the widget clip naturally. |
| Handle focused vs. wheel | Wheel over list rows (`y < header + L`) scrolls the list; below that scrolls the log — boundaries from `layoutMetrics`, no literals. |

### 4.4 Assessment

**Pros**
- Smallest delta from PRD-005; all existing keys (↑/↓ select, PgUp/PgDn log) keep their meaning.
- Directly answers "keep the sections at fixed vertical offsets with a resizable handle".
- Sections stay independently readable; list remains visible while reading output (good for multi-task monitoring).

**Cons**
- Padding cost: blank rows when tasks or output are few (standard split-pane tax).
- Two scroll dimensions remain (list window + log window) → two sets of scroll-state rules.
- Mouse drag requires per-mode work (native in fullscreen; parser extension in regular mode).
- Fixed `M = 6` metadata rows waste 2 rows for tasks lacking Cwd/Log (could collapse to `M = 4` + dynamic… no — that reintroduces RC-3; pad instead).

---

## 5. Approach B — Two Panels as a Single Scrollable Subpage

Merge the list, details, and output into **one content buffer** with **one scroll window**. The widget renders a fixed-height viewport onto that buffer; scrolling is internal state (§2.2), exactly like today's tail viewer — but over everything.

### 5.1 Content buffer model

Compose a typed row array, not bare strings:

```ts
interface DockRow {
  text: string;
  kind: "task" | "meta" | "output" | "rule" | "header";
  taskIndex?: number;   // for kind === "task": hit-test target
}
```

Buffer layout: one row per task (no list windowing — the panel scroll replaces it), a rule, the selected task's metadata block, a rule, and the selected task's output lines (from the G2 cache). The buffer is rebuilt per render; `scrollTop` indexes into it.

### 5.2 Scroll window & follow

```
── Background Tasks · ● test-heartbeat (running · 12s) ────  ← sticky header (pinned 1–2 rows)
  ✓ test-slow                     8s task-1    ┐
> ● test-heartbeat               12s task-2    │
  ✗ test-counter                  5s task-3    │
Task Details                                  │   one scroll window (P rows)
Command: test-heartbeat                       │   over the whole buffer
    ⋮                                         │
Output                                        │
[10:12:41] step 1 done                        │
    ⋮                                         ┘
lines 9–24 of 132 · ↑/↓ select · PgUp/PgDn scroll · esc    ← fixed status row
```

- `H = 1 (sticky header) + P (viewport) + 1 (status)`. `P` is the single resizable knob (same keyboard `+`/`-` / drag-handle story as §4.2, minus the split semantics — one boundary: panel vs. rest of screen).
- `follow` ⇔ `scrollTop === maxScroll` (bottom). Today's `move()` resets `logScroll`/`logFollow`; the merged equivalent is the anchor rule in §5.3.
- The sticky header carries the selected task id + status, so a user scrolled deep into output still knows which task they are reading. This replaces the orientation the split view gave for free.

### 5.3 Input semantics (the real design work)

| Concern | Rule (proposed) |
| --- | --- |
| Select vs. scroll | ↑/↓ = move selection; PgUp/PgDn / Home / End / wheel = scroll the panel. Selection auto-reveals: after `move(delta)`, clamp `scrollTop` so the selected row is inside the window. (Alternative `less`-style dual-purpose arrows rejected: ambiguous at the list/detail boundary.) |
| Scroll anchor on selection change | If the window was over list rows → keep the list position (just reveal the new selection). If it was over details/output → jump `scrollTop` to the start of the new task's detail section. Never leave stale output on screen. |
| Click | `localY → scrollTop + localY → rows[]` → `kind === "task"` selects `taskIndex`; `meta`/`output` rows are inert. Replaces `headerOffset = 3` arithmetic entirely. |
| Wheel | One dimension: scroll the panel. The `y > 8` split heuristic is deleted. |
| `k` kill, `Enter` open, `Esc` close | Unchanged. |

### 5.4 Assessment

**Pros**
- One scroll dimension, one resizable knob; `listOffset`, `maxVisible`, the pagination hint, and both hardcoded constants disappear.
- Constant height by construction; flicker gone with the same G1/G2 groundwork.
- Reads like a document: long output gets the whole viewport, not a 4–8 row slit.
- Sticky header solves the "which task am I reading" problem better than the split does.

**Cons**
- Larger behavioral change: PRD-005's "upper half = list, lower half = detail" visual contract is replaced; users lose the always-visible list while reading output (mitigated by the sticky header showing the selected task, not the list).
- Selection-dependent content below the list means buffer content re-binds under the scroll window — the §5.3 anchor rules must be specified carefully and tested.
- Scroll depth still bounded by the 128 KiB tail reservoir (§2.7); "scroll to top" means top-of-tail. Full-log scrolling = separate backward-paging effort.
- More of `DockController`'s state model is replaced (§8), so more test churn.

---

## 6. Comparison

| Dimension | A — Fixed two-panel | B — Single-scroll subpage |
| --- | --- | --- |
| Flicker eliminated | Yes (G1–G4) | Yes (G1–G4, structurally) |
| Delta from PRD-005 | Small (render + resize) | Large (state model + input semantics) |
| Scroll dimensions | 2 (list, log) | 1 |
| Resize knobs | Split boundary (L vs O) | Panel height only |
| List visible while reading output | Always | Only when scrolled up (sticky header shows selected task) |
| Output viewport | `O` rows (min 4) | Full panel `P` rows |
| Mouse drag effort | Fullscreen native; regular mode needs parser work | Same |
| Hardcoded `y > 8` / `headerOffset = 3` | Derived from `layoutMetrics` | Deleted outright |
| Test churn | Moderate (`dock.test.ts`, `dock-tui.test.ts` height-invariance + clamp cases) | Higher (buffer, anchor rules, hit-test mapping) |
| Risk | Low | Medium (UX semantics) |

## 7. Interaction with Existing Surfaces

- **Compact dock:** untouched by both approaches (`render()` collapsed branch stays as-is).
- **Fleet hand-off (Tab/←, wheel yield):** untouched; operates on controller state, not layout.
- **`/tasks` command & `openDetail`:** unchanged entry points; both approaches only change the expanded render + controller internals.
- **Status line:** the trailing hint text updates per approach (A adds resize keys; B shows `lines x–y of z` over the buffer).

## 8. Migration Notes (state mapping)

| `DockController` today | Approach A | Approach B |
| --- | --- | --- |
| `index` (selection) | unchanged | unchanged |
| `listOffset` | kept (list window) | removed |
| `logScroll` / `logFollow` | kept (output pane) | replaced by `scrollTop` / `follow` over buffer |
| `logMaxScroll` | kept (output lines) | `rows.length − P` |
| `detailTask` | unchanged | unchanged |
| — | new: `listRows` (persisted), drag state | new: `scrollTop`, buffer builder, anchor state |
| `getMaxVisible()` 40% heuristic | replaced by `listRows` | removed |

`format.ts` gains no new export for A (pad at call sites); B adds a `buildDockRows(...)` helper (pure, unit-testable).

Tests to add regardless of approach: **height invariance** (render expanded view across N selections/task counts → identical line count), clamp behavior at small `termHeight`, resize-key handling, and for B: buffer windowing + click-mapping + anchor-rule table tests.

## 9. Open Questions

1. **A:** always pad the list to `L` (constant geometry even for 1 task), or reflow only on task-count changes (less blank space, but still shifts on spawn/exit)? Proposed: always pad.
2. **A:** handle visual — bare `⇕` row, `── handle ──` rule, or box-drawing grip? Proposed: dim rule row with centered `⇕`.
3. **A/B:** persist panel size across sessions via extension settings, or session-only? Proposed: session-only for v1.
4. **B:** exact key bindings for resize (`+`/`-` vs `shift+↑/↓` vs `<`/`>`) — check conflicts with swallowed dock keys.
5. **B:** is full-log backward paging (beyond the 128 KiB reservoir) in scope now, later, or never? Proposed: later; the buffer model leaves room for it.
6. **Both:** does wheel-over-panel ever move selection (today wheel-up in list area does)? Proposed: no — wheel scrolls, arrows select.

## 10. Recommendation

Land **§3 groundwork (G1–G4) + Approach A** as phase 1: it is the minimal, low-risk change that removes the flicker and delivers the fixed-offset + resizable-handle behavior. Approach B can then be evaluated as phase 2 purely as a UX refinement — it reuses ~80% of the same groundwork (constant height, tail cache, derived metrics) and, if adopted, subsumes A's split-resize with a single panel-height knob. The two approaches are mutually exclusive render strategies, but the decision can safely be deferred until A has shipped and the flicker fix has been validated in daily use.

---

## 11. Implementation Notes (Phase 1 — Approach A, v0.2)

**Landed:** G1–G4 groundwork plus the full Approach A render/interaction model.

| Deliverable | Where |
| --- | --- |
| Layout constants, `computeLayout`, row-boundary metrics | `src/ui/dock-layout.ts` (new, pure) |
| `⇕ (drag or +/- to resize)` handle row | `formatResizeHandle` in `src/ui/format.ts` |
| SGR press/motion/release parsing | `src/ui/terminal-mouse.ts` (`ParsedMouseInput.press/motion/release`) |
| Controller state: `requestedListRows`, drag state, `resizeList`, `beginHandleDrag/dragHandleTo/endHandleDrag`, `getLayoutMetrics/getOutputRows` | `src/ui/dock.ts` (`DockController`) |
| Fixed-row expanded render, metrics-driven wheel/click, drag capture, tail LRU, register-once widget, `+`/`-` keys | `src/ui/dock.ts` (`installDock`) |
| Tests | `tests/dock-fixed-layout.test.ts` (new); updated `tests/dock.test.ts`, `tests/mouse-and-status-prefix.test.ts` — suite 160/160, `tsc --noEmit` clean |

### 11.1 Behavior deltas vs. the pre-PRD-007 dock

- **Constant geometry.** Expanded height = `15 + L + O` rows, clamped to `termHeight − 6` (editor+footer reserve). Default split: `L = ceil(budget × 0.35)`, `O = budget − L`. Below ~28 rows the layout degrades to the `L = 3, O = 4` floor (PRD §4.3).
- **Window indicator** (`N tasks · a–b of c`) moved into the header rule line (right-aligned via `formatHeaderLine`'s hint); the toggling pagination-hint row is gone; the subtitle row is now just `current session branch` (the count lives in the hint).
- **Tail LRU (G2):** per-task cache of the last 4 tails — selection changes render from cache instead of collapsing to `(no output yet)` while the async read is in flight (verified by the height-invariance test).
- **Wheel semantics (§9 Q6 resolution):** wheel scrolls the region under the pointer (list window above `handleIndex`, log below); it no longer moves the selection. Region boundaries come from `getLayoutMetrics` — the `y > 8` and `headerOffset = 3` literals are gone, and pad-row/hidden-task misclicks are fixed.
- **Keyboard resize:** `+`/`=` grows the list pane, `-`/`_` shrinks it (output pane absorbs the difference); clamped to `[3, maxListRows]` and re-derived per terminal height.

### 11.2 Documented deviations from §4.2

1. **Mouse drag handle is fullscreen-only in v1.** Discovery during implementation: `TuiAltScreen` registers its viewport input listener at construction — *before* extension listeners — and consumes **all** raw SGR mouse sequences itself (`tui-alt-screen.js:105`, `handleViewportInput`). So normalized `press/drag/release` (with `capture` routing) reaches `DockWidget.handleMouse` in fullscreen mode, where the drag handle is fully implemented. Regular (main-screen) mode has no component mouse dispatch and exposes no widget screen-origin, so a raw-path drag cannot map terminal rows to the handle row; resize there is keyboard-only. `parseMouseInput.press/motion/release` is landed as groundwork should a future pi-tui expose main-screen widget origins.
2. **Raw wheel handler yields via `isViewportTUI`.** Since viewport TUIs consume mouse sequences before input listeners run, the raw wheel branch is now guarded to regular mode only (defensive; behavior identical either way today).
3. **`H` formula corrected:** §4.1 printed `16 + L + O`; the fixed overhead is `15` (3+1+1+6+1+2+1). Implemented and tested as 15.

### 11.3 Resolved open questions (§9)

Q1 always pad · Q2 `⇕` rule row · Q3 session-only persistence · Q6 wheel scrolls, arrows select. Q4 (`+`/`-` adopted) and Q5 (backward paging deferred) stand as proposed.

---

## 12. End-to-End Verification (live pi via `@microsoft/tui-test`)

`npm run e2e` drives a **real pi process in a real PTY** (tui-test xtermjs engine, 110×40) with this
extension plus a test-only driver (`e2e/spawn-driver.ts`) that spawns tasks through the product's own
shared-registry surface (`SHARED_TASK_MANAGER_KEY`) — no LLM/API key required. Two passes:

| Pass | Mode | Checks | Result |
| --- | --- | --- | --- |
| `e2e/dock.e2e.ts` | fullscreen (product default) | 37 assertions: compact dock, ↓ dock mode, Esc release, expanded contract, height invariance across selection + async tail, `+`/`-` resize, **mouse drag of the handle (press→drag→release via `capture`)**, click-to-select, PgUp/Home/End log keys, `k` kill, Esc collapse | 37/37 |
| `e2e/regular.e2e.ts` | regular (main screen) | 18 assertions: same geometry contract, raw-wheel list scrolling (position-independent), PgUp/PgDn via the raw input path, truncation regression | 18/18 |

Screenshots (SVG) per stage in `e2e/artifacts/`; `e2e/probe.ts` (`npm run e2e:probe`) is a quick
smoke/dump harness.

### 12.1 Product defects found & fixed by the e2e pass

1. **Scrolled-log status line truncated** (found in the first live run): `formatOutputStatusLine`'s
   scrolled text plus the PRD-007 key suffix exceeded 110 columns, cutting off `esc close` — and the
   base text repeated `PgUp/PgDn scroll` that the suffix also carries. Fixed: scrolled-mode base is
   now `lines a–b of N · ↓ end follows`; the regression is asserted in both e2e passes and the unit
   suite.
2. **Mode-wrong log-scroll hint**: in fullscreen, pi's alt-screen viewport handler consumes
   `PageUp`/`PageDown` for transcript scrolling **before extension input listeners run**, so the
   dock's "PgUp/PgDn scroll" hint was unreachable there (verified by raw-byte capture). `Home`/`End`
   are not viewport-bound and do reach the dock. Fixed: the status hint is mode-aware
   (`Home/End log` in fullscreen, `PgUp/PgDn log` in regular — `isViewportTUI`).

### 12.2 Harness caveats (not product behavior)

- The xtermjs backend wheels at `(0,0)` regardless of pointer position (`mouseScroll` carries no
  coordinates), so fullscreen wheel-over-region routing cannot be exercised e2e; it is covered by
  unit tests (`dock-fixed-layout.test.ts`) and by click hit-testing, which shares the same dispatch
  path. Regular mode exercises the position-independent raw wheel path e2e.
- Manual `down → move → up` does not emit button-held motion; use `mouse.drag` (emits proper
  `[<32;…M` motion), which the drag handle handles end-to-end.
- PNG screenshots need OSC-52 clipboard access (absent in this container); the harness saves SVG.
- While dock mode is active the dock owns the keyboard (per PRD-005), so scripted `/commands` must
  run after `Esc`.

---

## 13. Reproducible e2e: recorded/replayed fake-LLM output

The e2e now exercises the **real agent path** — user prompt → streamed model
response → `background_task` tool call → dock reacts — without a live LLM.

### 13.1 Architecture

| Piece | Role |
| --- | --- |
| `e2e/replay-provider.ts` | Extension registering provider `replay` / model `scripted` via `pi.registerProvider(name, { api, models, streamSimple })` (the documented custom-provider form, cf. the bundled gitlab-duo example). `streamSimple` re-emits recorded normalized stream events — same deltas, same order, same inter-chunk pauses (÷ `PI_DOCK_E2E_REPLAY_SPEED`, default 4). No network, no API key. |
| `e2e/fixtures/dock-spawn.json` | The frozen "LLM output": per assistant turn, the exact normalized deltas (`text_*`, `toolcall_*`) with millisecond offsets, the final text, the parsed tool calls, and the stop reason. Committed to git; the e2e derives its expectations (tool arguments → dock row, confirmation word → transcript) from it. |
| `e2e/record.ts` (`npm run e2e:record`) | Capture-from-live: runs pi against a real provider (`opencode/glm-5.3-flash` by default) with the same prompt and records the `message_update` event cadence into the fixture. Requires valid credentials **once**. |
| `e2e/make-fixture.ts` (`npm run e2e:fixture`) | Generates an equivalent hand-authored fixture when no credentials are available (current state — the configured opencode key had expired server-side). |

Replay turn N is selected by counting assistant messages already in
`context.messages`, so a fixed scenario replays turn-for-turn deterministically.

### 13.2 Determinism analysis

Deterministic across runs: the model output (frozen fixture), its cadence
(scaled, fixed), the prompt, the driver commands, and therefore every
assertion. Verified: three consecutive fullscreen runs → 40/40 with identical
assertion sets.

Residual nondeterminism (accepted, assertion-relevant only if we ever assert
on them — we do not):
- **Wall-clock UI strings**: task ages (`3s → 4s`), `Started:` timestamps, and
  the 1 s dock ticker tick with real time. Removing these would need a clock
  injection seam through pi itself — out of scope.
- **Filesystem timing**: log reads land within milliseconds but not at fixed
  offsets; the fixture's height-invariance contract is immune by design.
- **Port/PTY allocation**: irrelevant to assertions.

### 13.3 Replay-provider contract finding

pi-agent-core's loop filters the finalized message's content by
`block.type === "toolCall"` to decide execution. A custom `streamSimple` that
replaces its content block in `toolcall_end` must preserve that discriminator
— dropping it makes the turn look like plain text (tool never executes, loop
ends after one turn). The replayer now re-applies `type: "toolCall"` on
`toolcall_end`; this mirrors how the built-in API implementations keep the
block object identity across `content_block_stop`.

### 13.4 Privacy policy (name & API key containment)

Per operator decision: **provider names and model names are fine;
the operator's name and API keys are not.**

- The fixture records **model output only** — normalized deltas, final text,
  parsed tool-call arguments (`id`/`name`/`arguments`; opaque provider fields
  like `thoughtSignature` are stripped at capture). No prompt context, no
  message metadata, no credentials. `streamSimple` receives the resolved API
  key via `options` and never reads or logs it; the replay provider declares a
  literal no-op key.
- `e2e/privacy.ts` derives this machine's concrete identities (git
  `user.name`/`user.email`, OS username, home directory) and scans every
  capture **and every replay load** for them plus credential-shaped patterns
  (`sk-…`, `ghp_…`, `AKIA…`, JWTs, authorization/api-key assignments, 43+
  char secret runs). The recorder **quarantines a violating fixture outside
  the repo and fails**; the replayer refuses to load one.
- The recording run minimizes what can reach the model in the first place:
  `--no-context-files --no-skills --no-extensions --no-session` and `cwd`
  `/tmp` — no AGENTS.md, no skills, no repo context, no persisted session.
- Scan result for the current synthetic fixture: clean.
