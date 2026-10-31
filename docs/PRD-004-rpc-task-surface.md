# PRD-004: RPC task surface — inspect and control background tasks over the Bash method

| | |
| --- | --- |
| **Status** | Draft — ready for review |
| **Version** | 1.0 |
| **Date** | 2026-10-31 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [PRD-003](background-task-design-and-ui.md) (background tasks: registry, bash override, ctrl+b adoption) |
| **Verified against** | pi `@earendil-works/pi-coding-agent` **1.4.0** (`dist/modes/rpc/rpc-mode.js`, `dist/core/agent-session.js`, `docs/rpc*.md`) |
| **Naming note** | The client-visible surface is the **`bash` RPC method** — the Bash execution path and its hook are collectively called **bash** in this document. (pi's internal event object happens to be named `user_bash`; that spelling is an implementation detail and is not used here.) |
| **Design principle** | **One Bash implementation.** All execution logic — spawn, priority wrapping, foreground slots, adoption eligibility, logs — lives in the PRD-003 bash-override module, whose `BashOperations` back the masked built-in tool. The bash hook handler is a **transport adapter only** (~10 lines): it routes the RPC path into that same operations object and answers `__bg__` control verbs from the registry. It contains no execution logic of its own. |
| **Out of scope here** | Custom RPC methods (pi 1.4 has no extension API for them), keypress injection (does not exist over RPC), backgrounding RPC-initiated bash (§8 Limitation L1) |

---

## 1. Summary

PRD-003 shipped the background-task engine and its TUI. This PRD gives **external RPC clients** (IDE extensions, scripts, editors driving pi over stdio JSON) a first-class way to **inspect** and **control** those tasks — without slash commands, without the TUI, and without any pi-side changes:

1. **Control + inspection** — the extension intercepts a reserved sentinel on the existing `bash` RPC method (`__bg__ <subcommand> …`) and answers with **structured JSON** in the standard bash result. One round trip, no model turn, no transcript pollution.
2. **Events** — every task-state transition is appended as a structured custom entry (`bg-task-state`), which RPC clients receive as `entry_appended` events. Excluded from model context by construction.
3. **Bypass fix** — plain RPC `bash` executions (which today skip the PRD-003 override and run unniced) are routed through the extension's operations, so they run at the foreground nice level like every other agent shell command.

## 2. Problem statement

After PRD-003, a task's only controls are the TUI (`ctrl+b`, dock, `/tasks` panel) and the model's `bg_task` tool. An RPC client — exactly the kind of host that most benefits from driving long work in the background — has none of it:

- `ctrl+b` is unreachable: `registerShortcut` is dispatched only by interactive mode (`dist/modes/interactive/interactive-mode.js:1715,5753` — the sole `getShortcuts` callers), and pi's RPC protocol has **no keypress injection** at all (`dist/modes/rpc/rpc-types.d.ts:12-135`, `RpcCommand` union).
- Extensions **cannot register RPC methods** (no `registerRpc`/`onRequest` in `dist/core/extensions/types.d.ts`), so a dedicated `bg.*` method family is impossible in pi 1.4.
- RPC `bash` executions bypass the PRD-003 bash-tool override entirely: `dist/modes/rpc/rpc-mode.js:439-458` → `AgentSession.executeBash` (`agent-session.js:3158`) → `createLocalBashOperations` — no nice wrapping, no foreground slot, invisible to the registry.
- Completion notifications exist (`bg-task-notification` custom messages ride `message_start`/`message_end`), but there is no started/adopted/still-running state stream and no way to act on a task.

Desired outcome: an RPC client can `inspect → adopt → kill → feed → watch` background tasks using only the RPC verbs pi already defines, with structured payloads.

## 3. Goals and non-goals

### Goals

| ID | Goal |
| --- | --- |
| G1 | An RPC client can **list, status, adopt, kill, and send-input** background tasks with one `bash` RPC call each, receiving structured JSON. |
| G2 | The sentinel protocol is **reserved and collision-safe**: any command not starting with the sentinel reaches real shell execution completely untouched. |
| G3 | Task state transitions are **pushed** to RPC clients as `entry_appended` events with full structured snapshots — without entering model context. |
| G4 | Plain RPC `bash` executions run at the **foreground nice level** (bypass fix), preserving pi's streaming (`bash_execution_update`) and `abort_bash` semantics byte-for-byte. |
| G5 | `/tasks` and the dock remain the **TUI** surfaces; nothing in this PRD changes TUI behavior. |
| G6 | Fail-open: every new path degrades to current behavior on any error (probe absence, registry unavailable, malformed sentinel arguments). |
| G7 | **Single Bash implementation**: the bash hook handler is a transport adapter (route + control-verb dispatch only); all execution behavior is owned by the PRD-003 override module, so the masked built-in tool and the RPC path share one executor, one priority policy, one foreground-slot ledger. |

### Non-goals

- **N1** — Backgrounding an RPC-initiated `bash` execution (§8 L1: the client is awaiting its completion by contract; pi tracks and SIGKILLs the group on `abort_bash`).
- **N2** — Custom RPC methods / schema-rich request-response (requires upstream pi API; the sentinel protocol is the 1.4-compatible shape).
- **N3** — Per-command `abort_bash` targeting (pi aborts all tracked bash controllers; upstream limitation).
- **N4** — `/tasks` subactions. The command family stays TUI-only per product decision.

## 4. Verified pi 1.4 mechanisms

**Path boundary (why a transport adapter is required):** the RPC `bash` method does **not** invoke the registered (masked) bash tool. `rpc-mode.js:439-458` calls `AgentSession.executeBash` (`agent-session.js:3158`), which executes via `executeBashWithOperations` with pi's own `createLocalBashOperations` — no tool lookup, no `tool_call` hooks. Masking the built-in tool therefore cannot reach the RPC path by itself. The **only** extension seam on that path is the bash execution hook, whose powers are exactly: return `{ result }` (answer without spawning) or return `{ operations }` (substitute the executor). PRD-004 uses it exclusively as a router into the override's operations — never as a second implementation.

| Mechanism | Evidence | Role |
| --- | --- | --- |
| Bash execution hook fires for **RPC `bash`** (and interactive `!`) | `rpc-mode.js:440-445` calls `emitUserBash`; `interactive-mode.js:5833` for `!` | The single interception point for the Bash execution path. |
| Returning `{ result }` short-circuits execution | `rpc-mode.js:446-452` — skips `executeBash` entirely | Sentinel responses: our JSON becomes the bash result; nothing spawns. |
| Returning `{ operations }` replaces the executor | same site → `executeBash(command, cwd, { operations })` (`agent-session.js:3158`) | **Transport adapter**: routes the RPC path into the override's `BashOperations` — the same executor behind the masked tool (G7). No hook-side execution logic. |
| `pi.appendEntry()` → `entry_appended` event; excluded from model context | `docs/json.md:122`; state docs ("durable data excluded from model context") | The event channel for task-state transitions. |
| `bash` responses/streaming unchanged | `bash_execution_update` carries the RPC request id (`agent-session.js:3169`); `abort_bash` kills tracked groups (`agent-session.js:3209`, `utils/shell.js:209`) | G4: untouched semantics for non-sentinel commands. |
| No custom RPC methods; no keypress injection | `rpc-types.d.ts:12-135`; absence in `types.d.ts` | Why a sentinel on `bash` is the 1.4-compatible shape (N2). |

## 5. Control verbs on the Bash surface (sentinel protocol)

The control verbs are part of the **Bash surface**, not a separate hook feature: the transport adapter receives the requested command and, when it starts with the reserved sentinel, dispatches to the registry and returns the structured result. Execution of all real commands is delegated to the override's operations.

Command shape (first token must match exactly, case-sensitive):

```
__bg__ <subcommand> [args…]
```

Subcommands and JSON responses (written to the result `output` as UTF-8; `exitCode` 0 on success, 1 on handled error with `{"error": "…"}`):

| Subcommand | Response (`application/json` text) |
| --- | --- |
| `__bg__ version` | `{"protocol": 1, "extension": "pi-bash-process-priority", "tasks": <running count>}` |
| `__bg__ list` | `{"tasks": [BgTask…]}` — running first, then finished (retention cap), identical ordering to `bg_task list` |
| `__bg__ status <idOrPrefix>` | `{"task": BgTask, "recentOutput": "<tail-capped log>"}` |
| `__bg__ adopt` | `{"task": BgTask}` — moves the **currently running model-issued bash tool call** to the background (the RPC equivalent of `ctrl+b`, §7.2 of PRD-003); `{"error": "no foreground command"}` when the slot is empty |
| `__bg__ kill <idOrPrefix> [reason]` | `{"task": BgTask}` after the kill settles (SIGTERM→grace→SIGKILL) |
| `__bg__ input <idOrPrefix> <text…>` | `{"task": BgTask}` — text is the remainder of the command line verbatim (newline appended by the registry) |

Rules:

- **R1 (collision safety)** — only the exact `__bg__ ` prefix triggers the protocol. All other commands return `undefined` from the hook: pi executes them normally (now with G4 operations). The sentinel is documented as reserved for this extension.
- **R2 (unknown subcommand)** — `{"error": "unknown subcommand '<x>'"}`, exit code 1, exit code semantics only — never a thrown hook error (a thrown error would block the command, pi fail-safe).
- **R3 (no registry)** — if PRD-003 is disabled or the registry is unavailable: `{"error": "background tasks not active"}`, exit 1.
- **R4 (JSON shape)** — `BgTask` objects are the exact registry snapshots (same shape as `bg_task` results / `bg-task-state` events), so clients parse one schema everywhere.
- **R5 (no transcript side effects)** — sentinel calls append nothing to the session (no user message, no tool call); only explicit `appendEntry` events (§6) are written.
- **R6 (idempotent adopt)** — a second `adopt` while the first is in flight returns the same task, not an error.

## 6. Event stream

On every registry transition the extension appends one entry:

```json
{ "customType": "bg-task-state",
  "data": { "kind": "spawned|adopted|terminal|still-running",
             "task": BgTask,
             "timestamp": <epoch ms> } }
```

- Delivered to RPC clients as `entry_appended` (`docs/json.md:122`); never sent to the model; persisted with the session like any entry (branch-aware replay for free).
- Emitted from the same registry callbacks that drive the TUI and the §7.6 notification — one source of truth, three surfaces.

## 7. Routing RPC bash through the overridden implementation (bypass fix)

For every non-sentinel `bash` hook invocation the transport adapter returns `{ operations }` — **the same operations object that backs the masked tool** (foreground nice wrap at spawn, own process group, merged streaming, foreground-slot bookkeeping). No execution logic is duplicated:

- `bash_execution_update` streaming and the final result are produced by the same `executeBashWithOperations` pipeline — unchanged shapes (G4).
- `abort_bash` semantics are unchanged (pi still owns the abort controller and kills the group).
- RPC-initiated commands finally run at agent priority (closing the last unniced path).
- The RPC-bash children are **not** registered as tasks (L1); they are simply correctly prioritized.

## 8. Limitations

| ID | Limitation |
| --- | --- |
| L1 | RPC-initiated `bash` executions cannot be moved to the background: the RPC client is synchronously awaiting completion and pi tracks the process for `abort_bash`. They are nice-wrapped (§7) and killable via `abort_bash`; adoption applies to **model-issued** tool calls only. |
| L2 | The protocol rides the `bash` method, so it is available to anything that can call RPC bash — which is already arbitrary shell execution. No new privilege is granted (§10). |
| L3 | Structured results are UTF-8 JSON inside the bash `output` field, not a typed RPC response — the 1.4-compatible trade-off (N2). `protocol` versioning (§5) future-proofs parsing. |

## 9. Requirements

| ID | Requirement |
| --- | --- |
| FR-1 | The bash hook handler returns `{ result }` for `__bg__ ` commands per §5 and `undefined` for everything else (R1). |
| FR-2 | Responses are single-line-terminated JSON objects matching §5; `exitCode` 0/1 per success/error (R2, R3). |
| FR-3 | `adopt` delegates to the same registry adoption as `ctrl+b` (§7.2 of PRD-003): no restart, no kill, renice+ionice on adoption, dock/notification/UI updates fire identically. |
| FR-4 | Every registry transition appends exactly one `bg-task-state` entry (§6); failures to append are logged once and never block the registry. |
| FR-5 | Non-sentinel RPC `bash` is executed by the **override's `BashOperations`** (returned verbatim from the transport adapter — no reimplementation), foreground nice included; `undefined` is returned when PRD-003 is disabled so behavior is byte-identical to stock pi. |
| FR-6 | All new code paths are no-ops when `PI_BG_TASKS_DISABLE=1` (R3 included). |
| FR-7 | The TUI surfaces (`/tasks`, dock, `ctrl+b`) are unchanged (G5). |
| FR-8 | The transport adapter adds no execution semantics of its own: no spawning, no buffers, no priority decisions — everything delegates to the override module (G7). Adapter size and surface stay minimal by review. |

## 10. Security considerations

- The sentinel grants task control to **anything that can already execute arbitrary bash over RPC** — no privilege escalation (L2). It cannot be triggered by model output: models invoke tools, not the RPC `bash` method.
- Sentinel commands never spawn a process, never touch the filesystem beyond the existing task log dir, and never enter model context.
- `bg-task-state` entries persist in the session file; they contain no output content beyond what task metadata already holds (ids, commands, paths, exit codes).

## 11. Testing and validation

1. **Unit** — sentinel parser (prefix/subcommand/args split, case sensitivity, unknown subcommand, empty registry), JSON response shapes, `BgTask` snapshot schema; `undefined`-passthrough for non-sentinel commands.
2. **Integration (real RPC session)** —
   - start `pi` in RPC mode with the extension; drive a model `sleep 60` through the overridden bash tool; send `bash "__bg__ adopt"` → assert JSON task id, `ps` shows same PID reniced, `entry_appended` events for `adopted` then `terminal`;
   - `__bg__ list` / `status` / `kill` / `input` round-trips; unknown subcommand → error JSON;
   - plain `bash "echo hi"` → normal streaming + unniced→niced (NI 10) verification; `__bg__` prefix absence in any real command leaves it untouched.
3. **Degradation** — `PI_BG_TASKS_DISABLE=1`: sentinel returns error JSON or (for bash passthrough) stock behavior; no entries appended.

## 12. Future work

- Upstream pi proposal: `registerRpcMethod(name, schema, handler)` — would replace the sentinel with a typed `bg.*` method family (N2) and allow per-command `abort` targeting (N3).
- `bg-task-state` replay helper for clients that attach mid-session (`__bg__ version` already reports `tasks` count; a `state` dump subcommand can follow).
- Extend adoption to RPC bash if pi ever exposes execution-detach semantics (L1).
