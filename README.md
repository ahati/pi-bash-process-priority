# pi-bash-process-priority

A [Pi coding agent](https://github.com/mariozechner/pi) extension that runs **every model-issued `bash` command at a lower CPU priority** (a higher nice value), so agent-driven workloads — builds, test suites, greps over big trees — stop starving your foreground work.

**Status: working implementation.** The core mechanism (PRD-001 R1) is implemented, unit-tested (8/8), and live-validated on Linux (PRD-001 R2): a real pi session showed the wrapped command's process tree at NI 10 while pi's own shell stayed at NI 0, with byte-identical output and exit codes (see [`docs/PRD-001`](docs/PRD-001-bash-nice-override.md) §7).

## How it works

The extension registers a `tool_call` handler. For every call to the built-in `bash` tool it rewrites the command in place:

```
nice -n 10 bash -c '<original command>'
```

The outer shell forks `nice`, which execs an inner `bash` at the requested niceness; every descendant process inherits it. No tool is re-registered, so the extension composes cleanly with other bash-owning extensions (renderers, background-task managers, permission gates). The transcript keeps showing the model's original command — only execution changes.

## What is implemented

- **Per-session probe** — runs `nice -n <level> true` once at `session_start`; on refusal (missing binary, `RLIMIT_NICE`) the extension fails open: one diagnostic, commands run at normal priority (FR-6, FR-9)
- **Skip rules** — already-niced commands (first token `nice`), empty/whitespace commands, and non-string inputs pass through unmodified (FR-4, FR-5)
- **Semantics preservation** — POSIX single-quote escaping keeps `$`, backticks, newlines, and quotes literal; exit codes, stdout/stderr, and pi's kill-tree on ESC/timeout behave byte-identically to unwrapped runs (validated: `tests/smoke.ts`)
- **Nested calls** — codemode scripts calling bash through `ctx.executeTool` are wrapped like model-issued calls (FR-8)
- **Composition** — permission gates that run after the rewrite judge what actually executes; renderers keep showing the original command (G3)

## Install

```bash
# from GitHub
pi install git:github.com/ahati/pi-bash-process-priority

# or from npm (once published)
pi install npm:pi-bash-process-priority
```

For development: `pi --extension ./index.ts`.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_BASH_NICE_LEVEL` | `10` | Nice increment applied to each command (1–19). |
| `PI_BG_ADOPT_KEY` | `ctrl+b` | Hotkey that moves the running foreground command to a background task. Overrides the built-in `tui.editor.cursorLeft` emacs binding (arrows still work); set e.g. `ctrl+t` to avoid the conflict. |
| `PI_BASH_NICE_DISABLE` | unset | Set to `1` to disable the rewrite entirely. |

## Scope

- Covers the model-issued `bash` tool (including nested/codemode calls) on Linux, macOS, and WSL. Interactive `!` commands and native Windows (PowerShell tool) are out of scope for v1 (see PRD-002; Git Bash best-effort and the process-wide fallback are planned there).

## Design docs

- [`docs/RESEARCH.md`](docs/RESEARCH.md) — feasibility investigation: the three viable pi hook points, with source references.
- [`docs/PRD-001-bash-nice-override.md`](docs/PRD-001-bash-nice-override.md) — core product requirements, acceptance criteria, and validation log.
- [`docs/PRD-002-cross-platform.md`](docs/PRD-002-cross-platform.md) — Windows / cross-platform strategy (W1 shipped; W2/W3 planned).

## License

MIT — see [LICENSE](LICENSE).
