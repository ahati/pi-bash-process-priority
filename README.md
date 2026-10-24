# pi-bash-process-priority

A [Pi coding agent](https://github.com/mariozechner/pi) extension that runs **every model-issued `bash` command at a lower CPU priority** (a higher nice value), so agent-driven workloads — builds, test suites, greps over big trees — stop starving your foreground work.

**Status: design phase.** The implementation follows the PRDs in [`docs/`](docs/); the repository currently ships the documented skeleton.

- [`docs/RESEARCH.md`](docs/RESEARCH.md) — feasibility investigation: the three viable pi hook points, with source references.
- [`docs/PRD-001-bash-nice-override.md`](docs/PRD-001-bash-nice-override.md) — core product requirements (default mechanism: `tool_call` command rewrite).
- [`docs/PRD-002-cross-platform.md`](docs/PRD-002-cross-platform.md) — Windows / cross-platform strategy.

## How it works (planned)

The extension registers a `tool_call` handler. For every call to the built-in `bash` tool it rewrites the command in place:

```
nice -n 10 bash -c '<original command>'
```

The outer shell forks `nice`, which execs an inner `bash` at the requested niceness; every descendant process inherits it. No tool is re-registered, so the extension composes cleanly with other bash-owning extensions (renderers, background-task managers, permission gates).

## Usage (after implementation)

```bash
pi --extension ./index.ts
```

or install as a pi package and add `npm:pi-bash-process-priority` to `packages` in `~/.pi/agent/settings.json`.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_BASH_NICE_LEVEL` | `10` | Nice increment applied to each command (1–19). |
| `PI_BASH_NICE_DISABLE` | unset | Set to `1` to disable the rewrite entirely. |

## Scope

- Covers the model-issued `bash` tool (including nested/codemode calls). Interactive `!` commands and the Windows PowerShell tool are out of scope for v1 (see PRD-002).

## License

MIT — see [LICENSE](LICENSE).
