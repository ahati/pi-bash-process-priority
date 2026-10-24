# PRD-001: Core bash nice-priority override

| | |
| --- | --- |
| **Status** | Draft — ready for review |
| **Version** | 1.0 |
| **Date** | 2026-02-27 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | [RESEARCH.md](RESEARCH.md) (feasibility), PRD-002 for platform gating |
| **Out of scope here** | Interactive `!` commands, Windows PowerShell (PRD-002), settings UI / slash commands |

---

## 1. Summary

`pi-bash-process-priority` is a pi extension that makes **every model-issued `bash` command execute at a lower CPU priority** by rewriting the command through a `tool_call` handler before execution:

```
<original command>   →   nice -n <LEVEL> bash -c '<original command>'
```

The agent's behavior, transcript, and tool results are unchanged; only the scheduling niceness of the spawned process tree changes. Foreground work (editor, compiles the human is waiting on, video calls) keeps its CPU share while the agent grinds through builds, test suites, and searches in the background.

## 2. Problem statement

An agent session routinely launches CPU-heavy commands — `npm install`, `tsc`, `pytest`, `rg` over monorepos, `ffmpeg` — with the same priority as everything else on the machine. While the agent works, interactive terminals, IDE language servers, and other foreground processes become sluggish. Users who want the agent to stay "polite" currently have no supported way to say "run everything the agent shells out at low priority".

Desired outcome: a single, installable pi package that guarantees agent shell work is scheduled *below* normal priority, with zero impact on command semantics, output, exit codes, cancellation, or timeout behavior.

## 3. Goals and non-goals

### Goals

1. G1 — All commands issued to the built-in `bash` tool (model-issued and nested/codemode calls) execute with a positive nice increment.
2. G2 — Command semantics are preserved exactly: stdout/stderr, exit codes, environment, working directory, shell features, and timeout/abort (kill-tree) behavior.
3. G3 — No tool ownership: the extension must not re-register the `bash` tool, so it composes with any other extension that owns or renders it (e.g. `pi-ui-enhancement`, background-task managers).
4. G4 — Fail-open: if `nice` is unavailable or refuses the adjustment, commands still run (at normal priority) and the extension degrades quietly.
5. G5 — Configurable niceness via environment variables, with sane defaults (`2`).
6. G6 — Works under both pi shell transports (argv `bash -c` and legacy WSL stdin transport) because the rewrite emits plain shell script text.

### Non-goals

- N1 — Covering interactive `!` commands (`user_bash`) or the Windows `powershell` tool (PRD-002 tracks platform strategy).
- N2 — *Raising* priority (negative nice) — unprivileged processes cannot do this, and the product is explicitly about politeness.
- N3 — Per-command policies (allowlists of commands that must run at normal priority) — possible future work; not v1.
- N4 — renice of already-running processes; memory/IO weighting (`ionice`, cgroups) — future candidates.

## 4. Requirements

### 4.1 Functional requirements

| ID | Requirement |
| --- | --- |
| FR-1 | For every `tool_call` event with `toolName === "bash"`, the handler rewrites `event.input.command` in place to the wrapped form (§5.2). |
| FR-2 | The niceness increment defaults to `2` (two levels below normal; resolved from open question §10.3 after real-world feedback) and is overridden by `PI_BASH_NICE_LEVEL` (integer, clamped to 1–19). |
| FR-3 | Setting `PI_BASH_NICE_DISABLE=1` disables all rewriting for the session. |
| FR-4 | Commands that are already nice-wrapped (trimmed command's first word is `nice`, or equals `nice`) are passed through unmodified (no double wrapping). |
| FR-5 | Empty or whitespace-only commands are passed through unmodified. |
| FR-6 | On session start the extension probes the platform (§5.4); if `nice` cannot adjust priority, the extension disables itself for the session. |
| FR-7 | On native Windows (`process.platform === "win32"` without WSL) the extension is inert (PRD-002 defines the Windows strategy). |
| FR-8 | Nested bash calls issued by codemode scripts (`parentToolCallId` set) are wrapped like any other call — no extra work, but must be regression-tested. |
| FR-9 | The probe and any internal diagnostics must not run through the `bash` tool (no recursive wrapping). |

### 4.2 Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-1 | The `tool_call` handler performs no I/O on the hot path (probe result and config resolved at `session_start`). Handler overhead < 1 ms per call. |
| NFR-2 | The package installs as a pi package (`pi.extensions` entry) and loads with `pi --extension ./index.ts` during development. |
| NFR-3 | Pure rewrite logic lives in `src/nice.ts` with no pi imports so it is unit-testable without the host. |
| NFR-4 | TypeScript strict mode; `npm run check` (typecheck + tests) must pass. |

## 5. Detailed design

### 5.1 Extension shape

```ts
// index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildNiceCommand, resolveConfig } from "./src/nice.ts";
import { probeNice } from "./src/probe.ts";

export default function (pi: ExtensionAPI) {
  let wrap: ((command: string) => string | null) | undefined;

  pi.on("session_start", async (event, ctx) => {
    const config = resolveConfig(process.env, process.platform);
    wrap = undefined;
    if (config.disabled || !config.supportedPlatform) return;
    if (!(await probeNice(config.level))) return; // fail-open (FR-6)
    wrap = (command) => buildNiceCommand(command, config.level);
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" || !wrap) return;
    const command = event.input.command as string | undefined;
    if (typeof command !== "string") return;
    const wrapped = wrap(command);
    if (wrapped !== null) event.input.command = wrapped;
  });
}
```

The factory registers handlers only; per-session state (`wrap`) is reset in `session_start` because reload/session replacement invalidates the old runtime (extensions doc, runtime lifecycle).

### 5.2 The rewrite

Given original command `C` and level `N`, the executed command becomes:

```
nice -n N bash -c '<C with ' replaced by '\'' >'
```

- Single-quote escaping: every `'` in `C` becomes the sequence `'\''` (close quote, escaped literal quote, reopen). This is POSIX-correct and preserves newlines, `$`, backticks, `"`, and globs literally. Non-interactive bash performs no history expansion, so `!` is safe.
- The outer shell (pi's own `bash -c`) parses the wrapper and forks `nice`; `nice` execs the inner `bash` in the same process, so the visible tree is `bash(pi) → bash(inner, nice N) → …descendants inherit N`.
- Exit code: the outer shell propagates the inner bash's status unchanged (G2).
- Legacy WSL stdin transport: the rewritten *text* is piped to `bash -s`; identical semantics (G6).

### 5.3 Skip rules (order matters)

1. Extension disabled (`PI_BASH_NICE_DISABLE=1`) or platform unsupported (FR-3/FR-7) → no handler work at all.
2. Probe failed this session (FR-6) → pass-through.
3. `command` missing / not a string / empty after trim → pass-through.
4. Already wrapped: first whitespace-delimited token of the trimmed command is `nice` (covers `nice -n 19 heavy-task` the model wrote itself) → pass-through (FR-4).
5. Otherwise → wrap.

### 5.4 Platform probe

At `session_start`, run via `child_process.execFile` (never the bash tool, FR-9):

```
nice -n <level> true
```

Success criteria: exit code 0 **and** stderr does not contain `cannot set niceness` (GNU/BSD/busybox warn on refused adjustments but still exit with the child's status — `true` exits 0, so the warning check is what catches the RLIMIT_NICE/EPERM case). On probe failure the extension disables itself for the session (fail-open, G4) and reports one diagnostic line via `ctx.ui.notify` when a UI is present (`ctx.hasUI`), silently otherwise.

Probe budget: one `execFile`, ~5 ms; no timeout extension needed beyond a 5 s guard.

### 5.5 Niceness level semantics

- `nice -n N` is an **increment** relative to pi's own niceness (usually 0). Commands therefore land at `min(pi_nice + N, 19)`. Documented, not clamped against pi's own niceness — if the user niced pi itself, deeper politeness is the correct interpretation.
- `PI_BASH_NICE_LEVEL` parsing: integer; out-of-range values clamp into 1–19; unparsable values fall back to 10 with a one-time diagnostic.

### 5.6 Interaction with other extensions

- Ownership-free: nothing is re-registered (G3). `pi-ui-enhancement` or `pi-patty-bg-tasks` may own the `bash` tool; execution consumes whatever `event.input.command` holds after the full handler chain runs.
- Handler order: pi runs `tool_call` handlers in extension load order; our rewrite composes (mutations chain). Permission gates that run *after* us see the wrapped command (correct: they judge what executes). Gates that run *before* us judge the original command (also correct: semantics are unchanged).
- One assistant message can issue parallel tool calls; each call gets its own `tool_call` event — no shared state, no ordering assumptions (extensions doc, events & concurrency).

### 5.7 What the model sees

The transcript and the TUI display the model's **original** command; only execution is rewritten. This is considered a feature (clean context) and is called out here so debuggers know to look for `nice` in `ps` output, not in the transcript. `details`-level annotation of rewritten calls is deliberately not pursued in v1 (would require tool ownership).

### 5.8 Cancellation, timeout, and kill-tree

pi spawns the shell `detached` and kills via `killProcessTree(child.pid)` on abort/timeout. Our wrapper adds no new sessions or daemonizing constructs, so the inner bash and all its descendants remain inside the killed tree. Timeout and ESC-abort behavior are byte-identical to unwrapped runs (G2).

### 5.9 Subagents and sessions

Child pi sessions (subagents) load the same user extensions and therefore inherit the rewrite. Session replacement (`/new`, `/resume`) and reload re-run `session_start`, re-probing and re-resolving config.

## 6. Alternatives considered

| Alternative | Verdict | Rationale |
| --- | --- | --- |
| **A. `tool_call` rewrite (chosen)** | ✅ default | Zero ownership conflicts; ~40 lines; covers nested calls; official mutation contract ("mutate `event.input` in place"). |
| B. Re-register `bash` via `createBashTool` + `spawnHook` | Deferred | The literal "tool override" (official `bash-spawn-hook.ts` example); single point of control and *visible* in `details`, but collides with other bash-owning extensions (last registration wins) and needs the deferred `session_start` registration dance. Revisit as an opt-in "strict mode" if ownership ever becomes free. |
| C. Process-wide `os.setPriority` at `session_start` | Rejected for core | One line, covers everything including Windows priority classes — but nices pi's own event loop and is not command-scoped. Retained as the native-Windows fallback in PRD-002. |
| D. `renice` the shell after spawn | Rejected | Requires controlling the spawn to learn the PID → forces mechanism B; racy (command may finish before renice lands). |
| E. `commandPrefix` option | Rejected | Only reachable via mechanism B; prefix runs inside the same shell and cannot priority-wrap arbitrary multi-command input. |

## 7. Rollout plan

1. **R1 — Skeleton (this repo):** pure logic in `src/nice.ts`, probe in `src/probe.ts`, factory in `index.ts`, unit tests.
2. **R2 — Local validation:** `pi --extension ./index.ts` in a scratch project; run a CPU-heavy command (`yes > /dev/null` with a timeout) and confirm via `ps -o pid,ni,comm` that the tree runs at the configured niceness; confirm ESC-abort and timeout still kill the tree; run a command containing single quotes, `$()`, newlines to confirm quoting.
   - *Status: executed successfully (2026-02-27, pi 1.4.0, Linux).* `tests/smoke.ts` proves byte-identical stdout/exit modulo the intended niceness self-report; a live print-mode session (`pi -p --no-session -e ./index.ts`) ran a model-issued `ps -o pid,ppid,ni,comm -p $$` and observed the designed topology: inner bash at **NI 10**, pi's outer shell at NI 0.
   - *Finding:* commands whose quoting is already invalid (e.g. an unbalanced single quote) fail identically wrapped and unwrapped (same stderr, exit 2) — the wrapper never changes semantics, including for broken input (G2).
3. **R3 — Coexistence test:** enable alongside `pi-ui-enhancement` (bash rendering on) and a permission-gate-style extension; verify rendering, gating, and wrapping all function.
4. **R4 — Package:** publish/tag; install via `packages` in `~/.pi/agent/settings.json`; document the env vars in the README.

## 8. Testing and acceptance criteria

### 8.1 Unit tests (`tests/nice.test.ts`, no host dependency)

- escaping: plain command; single quotes (`don't`); `$()`/backticks; newlines; embedded `'\''` sequences — assert exact wrapped output.
- skip rules: empty/whitespace; first token `nice`; `PI_BASH_NICE_DISABLE`; unsupported platform.
- level parsing: default 2; `PI_BASH_NICE_LEVEL=15`; clamp 0 → 1, 25 → 19; unparsable → 2.

### 8.2 Integration acceptance (manual, R2/R3)

| ID | Criterion |
| --- | --- |
| AC-1 | `nice -n 10 sleep 5`-style call observed at niceness 10 in `ps -o ni` for the whole process tree. |
| AC-2 | Command output and exit code identical with and without the extension (same command, e.g. `sh -c 'exit 3'` → exit 3; quoting-heavy command → identical stdout). |
| AC-3 | ESC-abort during a wrapped long-running command terminates all processes (no orphaned inner bash). |
| AC-4 | Timeout parameter produces the normal timeout error; tree is killed. |
| AC-5 | With `nice` shadowed by a PATH shim that fails, commands still execute (fail-open) and the session logs exactly one diagnostic. |
| AC-6 | Codemode script calling bash through `ctx.executeTool` is wrapped. |
| AC-7 | `pi-ui-enhancement` bash rendering still works with the extension loaded. |
| AC-8 | Second `session_start` (e.g. `/resume`) re-probes and re-enables correctly after a previously failing probe environment is fixed. |

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `nice` missing/minimal environment (containers, non-coreutils) | Commands unwrapped or probe failure | Fail-open + single diagnostic (FR-6); probe at `session_start` only. |
| RLIMIT_NICE refuses the increment on exotic kernels | Silent no-op | Probe checks stderr for `cannot set niceness` and disables with a notice. |
| Quoting regression corrupts a command | High (wrong command runs) | POSIX single-quote escaping is total for arbitrary input; exhaustive unit tests (§8.1); integration test AC-2. |
| Other `tool_call` extensions assume ownership of `command` content | Low | Ownership-free design; composition documented (§5.6); coexistence test AC-7. |
| Model gets confused seeing `nice` in `ps` output but not in transcript | Cosmetic | Documented behavior (§5.7); optional `details` annotation deferred until ownership-free annotation exists. |
| ARG_MAX pressure from wrapping very long commands | Negligible | Wrapper adds ~20 chars + 4 per quote; Linux ARG_MAX ≈ 2 MB. |

## 10. Open questions

1. Should a future version expose per-command exclusions (e.g. never wrap `docker`, wrap everything else)? Deferred (N3) — needs a config story first.
2. Should wrapped calls surface a hint in `details` (requires tool ownership) or a `# nice:` comment convention like pi-ui-enhancement's intent headers? Parked.
3. ~~Default level 10 vs 15~~ **Resolved (2026-10-24):** default is `2` — two levels below normal, enough to keep agent workloads from interfering with interactive foreground work while leaving CI-style jobs essentially unaffected. Override with `PI_BASH_NICE_LEVEL` for stronger politeness.
