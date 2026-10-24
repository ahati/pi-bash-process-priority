# Research: can a pi extension start all bash commands at a lower nice priority?

**Date:** 2026-02-27 · **Question:** Is a pi-agent "bash tool override that starts all commands with a lower nice priority" possible?

**Answer: Yes.** Three independent hook points exist in the extension API, plus a process-level fallback. No existing community package was found that implements this (see §6).

All references are to the pi-coding-agent release installed at
`~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/` (referred to as `PKG/` below).

---

## 1. How the built-in bash tool executes commands

`PKG/dist/core/tools/bash.js` (`createLocalShellOperations`):

```js
const commandFromStdin = shellConfig.commandTransport === "stdin";
const child = spawn(
    shellConfig.shell,
    commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
    { cwd, detached: process.platform !== "win32", env, stdio: [...], windowsHide: true },
);
```

- On Unix the shell config resolves to `/bin/bash` with args `["-c"]` (`PKG/dist/utils/shell.js`, `getShellConfig` / `getBashShellConfig`) — i.e. every command runs as `/bin/bash -c <command>`.
- Legacy WSL bash (`bash.exe` under System32/Sysnative) uses transport `"stdin"`: the command text is piped to `bash -s`. A rewrite that produces *shell script text* works under both transports.
- The child is spawned `detached`; `killProcessTree(child.pid)` (abort/timeout) kills the whole descendant tree. Any wrapper we inject stays inside that tree as long as it does not daemonize, so cancellation keeps working.
- The tool contract (`PKG/dist/core/tools/bash.d.ts`): input schema is `{ command: string; timeout?: number }`; pluggable `BashOperations`, `BashToolOptions.commandPrefix`, and `BashSpawnHook` (`command/cwd/env` adjuster) are exported.

## 2. Mechanism A — `tool_call` input mutation (chosen default)

`PKG/docs/extensions.md`:

- "`tool_call` can mutate input or block execution."
- "Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation."
- `ToolCallEventResult` (`PKG/dist/core/extensions/types.d.ts:1089`): "To modify arguments, mutate `event.input` in place instead."

`PKG/examples/extensions/permission-gate.ts` shows the canonical filter:

```ts
pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command as string;
    ...
});
```

Coverage: model-issued calls **and** nested calls (`codemode` scripts calling bash via `ctx.executeTool` go through the same `tool_call` handlers, per the extensions doc).

Properties:

- **No tool ownership.** The extension re-registers nothing, so it cannot conflict with other extensions that own the `bash` tool. This matters in practice: `pi-ui-enhancement` (installed in this environment) re-registers `bash` via `createBashTool` for compact rendering (`pi-ui-enhancement/src/tool-overrides.ts`), and its changelog records startup conflicts with other bash-owning extensions (their PR #34 defers ownership to `session_start` to mitigate it). A `tool_call` handler composes with *any* owner because execution consumes whatever the final `event.input.command` is.
- Handlers run in extension load order; mutation chains with other `tool_call` consumers (permission gates see the rewritten command — desirable: they gate what actually executes).
- The transcript records the model's original command; only execution is rewritten. Cosmetic divergence, documented in PRD-001 §5.9.

## 3. Mechanism B — re-register the tool (`createBashTool` + `spawnHook`)

`PKG/examples/extensions/bash-spawn-hook.ts` is the official override pattern:

```ts
const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd, env }) => ({
        command: `source ~/.profile\n${command}`, cwd, env,
    }),
});
pi.registerTool({ ...bashTool, execute: ... });
```

`BashToolOptions` (`bash.d.ts`) also allows `operations` (full execution backend replacement) and `commandPrefix`. This is a true single-owner override — the `tool-override.ts` example documents that registering a tool with a built-in's name replaces it — but:

- It takes ownership of `bash` and therefore **collides with other bash-owning extensions** (whoever registers last silently wins).
- Correct usage requires deferred registration at `session_start`/`before_agent_start` (the pi-ui-enhancement #34 pattern) to avoid startup races.

Verdict: viable and semantically cleanest for a *strict* override mode, but wrong default for an ecosystem where renderers legitimately own the bash tool. Documented as the alternative in PRD-001 §6.

## 4. Mechanism C — process-wide `os.setPriority`

`node:os.setPriority(0, nice)` at `session_start` lowers the pi process's own scheduling priority; every subsequently spawned child (bash, PowerShell, git, ripgrep…) inherits the niceness.

- Covers *everything*, cross-platform: on Windows, `os.setPriority` maps to priority classes (`PRIORITY_BELOW_NORMAL`, etc.), so it is the only low-effort lever that survives native Windows (PRD-002).
- Downsides: it also nices pi's own event loop, and it is not command-scoped (no per-call opt-out).

Verdict: rejected for the core MVP, retained as the recommended native-Windows fallback in PRD-002.

## 5. Adjacent surfaces investigated

| Surface | Finding | Relevance |
| --- | --- | --- |
| `user_bash` event | Fires for interactive `!` commands; a handler may return `operations` to take over execution (types.d.ts:898, :1099) | Out of scope for v1 (user decision); noted for future |
| `powershell` tool | Distinct tool name (`createShellToolDefinition` with `shellName: "powershell"`); `nice` does not exist there | PRD-002 |
| `pi.getSettings()` | Extensions can read merged global/project settings | Kept out of v1 config scope; env vars suffice |
| Subagent sessions | Child pi sessions load the same user extensions, so coverage extends to subagents automatically | PRD-001 §5.11 |
| Timeout/kill semantics | `killProcessTree` + `detached` spawn; wrapper must stay in-tree (no `setsid`/daemonizing) | PRD-001 §5.8 |

## 6. Prior art

Web search (2026-02-27) for existing pi packages covering nice/renice/process priority found none — only permission systems (`pi-permission-system`), interactive shells (`pi-interactive-shell`), and general tool-override discussions. `pi-bash-process-priority` would be the first package in this niche.

## 7. `nice` semantics that constrain the design (POSIX)

- `nice -n N cmd` applies an **increment** `N` to the current niceness; unprivileged processes may only increase niceness (positive increments), and values cap at `+19`. We never request negative adjustments, so unprivileged operation is safe.
- GNU/BSD/busybox `nice` fail **open**: if the priority adjustment is refused (e.g. RLIMIT_NICE), they print a warning to stderr and still run the command. Command execution must therefore never be broken by `nice` — worst case is "ran at normal priority with a warning".
- The inner shell is a plain descendant: `bash -c` forks `nice`, which `exec`s the inner `bash` (same PID). Exit codes propagate; `killProcessTree` still reaches the whole tree.
