# PRD-004: One bash tool — `background` parameter, RPC inspect/control, priority everywhere

| | |
| --- | --- |
| **Status** | Draft — ready for review |
| **Version** | 3.0 (supersedes the sentinel-protocol 1.0 and tool-mediated 2.0 drafts) |
| **Date** | 2026-10-31 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md) (registry, bash override, ctrl+b adoption; §7.5 amended by this PRD) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0** (`dist/modes/rpc/rpc-mode.js`, `dist/core/agent-session.js`, `docs/rpc*.md`, `docs/json.md`) |
| **Design principle** | **One extension, one Bash implementation, one tool.** The extension masks the built-in `bash` tool; background execution is a **parameter of that tool** (`background: true`), not a second tool and not a hook. Management is a thin second tool (`bg_task`) with no run verb. The bash execution hook exists only as a priority transport (`return { operations }`). |
| **Out of scope here** | Custom RPC methods (no extension API in pi 1.4), keypress injection, backgrounding/registry-tracking of RPC-initiated bash (L1), interactive `!` bash priority (L2, transport applies; registry tracking does not) |

---

## 1. Summary

One extension owns everything shell-shaped:

1. **The `bash` tool is overridden** (built-in masked, PRD-003 §7.1) and gains one new parameter: **`background: boolean`**. The model starts long-running work by setting the flag on the tool it already uses — no second "run" verb, no mode switch:
   - `background: false` (default) → byte-identical to pi's bash: foreground, streamed, `ctrl+b`-adoptable, fg nice.
   - `background: true` → spawns immediately as `task-N` at **bg** nice + ionice, returns the standard task notice, wakes the agent on completion.
2. **`bg_task` shrinks to management** — `list | status | kill | input | adopt` — no run verb. `adopt` is the steer/RPC trigger for `ctrl+b`.
3. **RPC inspection without hooks**: every task transition is appended as a structured `bg-task-state` entry → `entry_appended` events, never in model context.
4. **Priority everywhere**: the bash execution hook is reduced to a transport (`return { operations }` — the masked tool's own executor), so RPC-initiated shell commands also run at fg nice. PRD-001's "tool calls only" scope is amended: **every agent shell execution is niced**.
5. **No control hooks**: the hook parses nothing and decides nothing. Control is tool-mediated (`bg_task`), invoked by the model on its own initiative or when an RPC client steers it.

## 2. Problem statement

The model's only way to run a shell command is the `bash` tool, and it is all-or-nothing foreground: a dev server, watch mode, or long test suite blocks the turn until it exits, times out, or is aborted. Starting long work in the background required a second tool with a parallel "run" verb — two ways to execute, two parameter sets, two mental models.

Meanwhile RPC clients (IDEs) have no structured view of task lifecycle and no way to trigger `ctrl+b`.

Constraints (verified, pi 1.4.0): RPC `bash` never passes through the registered tool (`rpc-mode.js:439-458` → `agent-session.js:3158`); no keypress injection; no extension-registered RPC methods; `entry_appended` events exist (`docs/json.md:122`); `steer`/`prompt` reach the agent (`rpc-types.d.ts:12-135`).

## 3. Goals and non-goals

### Goals

| ID | Goal |
| --- | --- |
| G1 | `bash { command, background: true }` starts a task and returns the task notice immediately; the schema change is additive and the default path is byte-identical to pi (G-guarantees of PRD-003 carry over). |
| G2 | Background tasks run at **bg** priority (nice `PI_BG_NICE_LEVEL` + ionice); foreground at **fg** nice; RPC-initiated shell runs at **fg** nice via the priority transport. |
| G3 | `bg_task` is management-only: `list \| status \| kill \| input \| adopt`; `adopt` triggers the identical `ctrl+b` code path. |
| G4 | The bash execution hook carries **zero logic** — its entire body is `return { operations: sharedOps }`. No sentinel, no parsing, no result short-circuit. |
| G5 | Every task transition appends one structured `bg-task-state` entry (RPC `entry_appended`; never in model context). |
| G6 | TUI unchanged: dock, `/tasks`, `ctrl+b`, details panel — plus rows for tasks started via the parameter (same registry, same rendering). |

### Non-goals

- **N1** — Registry-tracking / backgrounding of RPC-initiated `bash` (client awaits completion; pi tracks the group for `abort_bash`). Priority only (transport).
- **N2** — Custom RPC methods, keypress injection (upstream asks, §12).
- **N3** — `/tasks` subactions (TUI-only per product decision).
- **N4** — Subagent aggregation (PRD-005; the event schema reserves attribution fields).

## 4. Tool surface (amends PRD-003 §7.5)

### 4.1 `bash` (overridden, masked built-in)

```ts
{
  command: string                      // unchanged
  timeout?: number                     // unchanged (foreground only)
  background?: boolean                 // NEW — default false
  taskName?: string                    // NEW, optional — human-readable task name
}
```

- **Foreground** (`background` unset/false): unchanged pipeline — fg nice at spawn, streaming, abort kill-tree, timeout, truncation (PRD-003 §7.1 guarantees).
- **Background** (`background: true`): registry spawn at bg priority (§7.3 of PRD-003); `timeout` is rejected up front (`"timeout does not apply to background commands"`); response is the standard task notice:

  ```
  Tool is running as a background task with task id: task-7
  Output: /home/u/proj/.pi/bg-tasks/task-7.log
  Do not poll. You will be notified when it finishes.
  ```

- `renderCall` shows the flag distinctly (e.g. `○ Bash(sleep 120) ⏾ background`), so the transcript reads like agy's task rows.
- The tool description gains one sentence: *"Set background=true for long-running commands (dev servers, watchers, long tests); you will be notified when they finish — never poll."* The async-termination guideline from PRD-003 remains.

### 4.2 `bg_task` (management-only)

```
action: "list" | "status" | "kill" | "input" | "adopt"
taskId?, input?, name?          // as before
```

- The `run` action is **removed** (its job moved to the `background` parameter); `adopt` arrives from this PRD (§5).
- `promptSnippet`: "Inspect and manage this conversation's background tasks (task-N)."

## 5. `adopt` — the control verb

`bg_task { action: "adopt" }` resolves the current foreground tool call through the same `requestBackground()` as `ctrl+b` (no restart, no kill, renice+ionice, full event/UI fan-out):

- Success → `Moved to background: task-7 (sleep 120)` + output path.
- Empty slot → `No foreground command is currently running.` (`isError: true`).
- RPC clients trigger it by steering the agent (`steer`: *"Move the running command to the background (bg_task adopt)."*) and observe the confirmation via the §6 event stream. Control is agent-mediated by design (L3).

## 6. Event stream (`bg-task-state` entries)

On every registry transition (spawned / adopted / terminal / still-running) the extension appends exactly one entry:

```json
{ "customType": "bg-task-state",
  "data": { "kind": "…", "task": { BgTask }, "timestamp": <epoch ms> } }
```

- Delivered to RPC clients as **`entry_appended`** (`docs/json.md:122`); excluded from model context; persisted branch-aware.
- Emitted from the same registry callbacks as the TUI and completion notification — one source of truth, three surfaces.
- Clients must tolerate unknown fields; attribution fields (PRD-005 subagents) may be added.

## 7. Priority transport (the only hook usage)

```ts
pi.on("user_bash", () => ({ operations: sharedOperations }));
```

`sharedOperations` is the same `BashOperations` behind the masked tool. The hook's entire body is that return statement:

- RPC-initiated shell commands execute through the masked tool's executor → **fg nice** (PRD-001 contract amended: every agent shell execution is niced).
- `bash_execution_update` streaming, results, and `abort_bash` semantics are produced by the same `executeBashWithOperations` pipeline — unchanged.
- No control logic, no parsing, no registry tracking of RPC bash (N1).
- With `PI_BG_TASKS_DISABLE=1` the hook returns `undefined` (stock behavior).

## 8. Limitations

| ID | Limitation |
| --- | --- |
| L1 | RPC-initiated `bash` cannot appear in the task registry, be adopted, or be backgrounded — pi owns that process (`abort_bash` kills the group). Priority only (§7). |
| L2 | Interactive `!` bash: priority transport applies; registry tracking does not (same as L1, different path). |
| L3 | RPC control is agent-mediated: one steering round trip before `adopt`/`kill`/`input` land. Direct programmatic control needs upstream `registerRpcMethod` (§12). |
| L4 | `adopt` races are benign: if the foreground command exits between steer and tool call, the result is `No foreground command is currently running.` |
| L5 | Schema evolution: `background`/`taskName` are additive params on a masked tool — providers that choke on unknown tool params would also have choked on the override itself; no new risk class. |

## 9. Requirements

| ID | Requirement |
| --- | --- |
| FR-1 | `bash` accepts `background?: boolean` and `taskName?: string`; `background: true` spawns via the registry (bg priority), returns the §4.1 notice, and never blocks on the child. |
| FR-2 | Foreground behavior (default) is byte-identical to PRD-003's masked tool (streaming, exit codes, timeout, abort kill-tree, truncation). |
| FR-3 | `timeout` + `background: true` is a parameter-validation error before spawn. |
| FR-4 | `bg_task` loses `run` and gains `adopt`; all management actions keep their PRD-003 semantics and wordings. |
| FR-5 | Every registry transition appends exactly one `bg-task-state` entry per §6; append failures are logged once and never block the registry. |
| FR-6 | The bash execution hook's entire body is the §7 return; with PRD-003 disabled it returns `undefined`. No other hook statements (G4) — verified by test. |
| FR-7 | `renderCall` distinguishes background calls (§4.1); dock/`/tasks` render parameter-started tasks identically to `ctrl+b`-adopted ones (origin `bg_task` vs `foreground-adopted` preserved in `details`). |
| FR-8 | All new paths no-op under `PI_BG_TASKS_DISABLE=1`. |

## 10. Security considerations

- `background` changes *when results arrive*, not *what may execute* — the model could already run any command; the parameter adds scheduling, not capability.
- Adoption, events, and notifications are unchanged surfaces; `bg-task-state` entries carry metadata only (ids, commands, paths, exit codes).
- The priority transport returns a static operations reference — no command inspection at the hook, so there is no new decision surface to attack.

## 11. Testing and validation

1. **Unit** — schema (defaults, `background`+`timeout` rejection), spawn→task notice wording, `run`-removal from `bg_task`, event emission per transition, hook body shape (returns operations; `undefined` when disabled).
2. **Integration (real sessions)**
   - TUI: `bash { sleep 60, background: true }` → immediate task notice, dock row, bg nice + ionice on the same PID, completion wake; foreground path byte-identical to stock (PRD-003 harness).
   - RPC: `steer` adopt phrase → `kind: "adopted"` event + reniced PID; `entry_appended` stream shows `spawned → adopted → terminal`; `get_entries` poll lists tasks.
   - RPC `bash "echo hi"` → normal streaming, NI 10 (transport); `abort_bash` still kills it.
3. **Degradation** — `PI_BG_TASKS_DISABLE=1`: tool registers without `background` effect (param rejected or ignored with a notice — pick: ignored + notice), hook returns `undefined`, no events.

## 12. Future work

- Upstream pi: `registerRpcMethod` (typed, turnless client control — would make §5 steering unnecessary) and `AgentSession.executeBash` honoring the registered tool's operations natively (making §7 transport unnecessary).
- Upstream rename: `user_bash` → `bash` (cosmetic; v3 does not depend on it).
- PRD-005: subagent task aggregation (`Type: Subagent` rows via the `globalThis` registry bridge; event `data` reserves attribution fields).
