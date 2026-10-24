# PRD-002: Cross-platform support (Windows, macOS, WSL)

| | |
| --- | --- |
| **Status** | Draft — ready for review |
| **Version** | 1.0 |
| **Date** | 2026-02-27 |
| **Owner** | pi-bash-process-priority maintainers |
| **Depends on** | PRD-001 (core rewrite), [RESEARCH.md](RESEARCH.md) §7 |
| **Scope decision** | User-selected for v1 PRD set (user_bash coverage and config/UX phase are explicitly excluded) |

---

## 1. Summary

PRD-001's mechanism is POSIX-flavored (`nice` exists on Linux, macOS, and WSL, and inside MSYS/Git Bash). This PRD defines how `pi-bash-process-priority` behaves on every platform pi supports: which platforms get per-command wrapping, which degrade to no-op, and which (if any) get a process-wide fallback — so that a Windows user installing the package sees a quiet no-op, never a broken command.

## 2. Platform matrix (v1 target)

| Platform | pi shell tool | `nice` available | v1 behavior |
| --- | --- | --- | --- |
| Linux (glibc, coreutils) | `bash` | ✅ | Full rewrite (PRD-001) |
| Linux (busybox/Alpine) | `bash`/`sh` | ✅ (busybox nice) | Full rewrite, probe-gated |
| macOS (BSD) | `bash`/`zsh`-resolved bash | ✅ (BSD nice) | Full rewrite, probe-gated |
| WSL (native `bash.exe` legacy path) | `bash` via **stdin transport** | ✅ | Full rewrite — wrapper is plain script text, transport-agnostic (PRD-001 G6) |
| Windows + Git Bash selected as shell | `bash` (MSYS) | ⚠️ MSYS `nice` emulates priority | Best effort: probe decides; inert when probe fails |
| Windows native (PowerShell tool) | `powershell` | ❌ | **Inert** (Phase W1, §4) |

Key design invariant carried over from PRD-001: **the probe is the gate**. Nothing is assumed about a platform; `nice -n <level> true` is executed once per session and its success (exit 0, no `cannot set niceness` warning) enables wrapping. Platform checks are only used as fast pre-filters.

## 3. Requirements

| ID | Requirement |
| --- | --- |
| XR-1 | On any platform where the probe fails, the extension is completely inert: no rewrite, no warnings beyond one diagnostic, no per-call overhead. |
| XR-2 | On native Windows (default PowerShell tool) the extension must never attempt `nice` and must never rewrite `powershell` tool calls — `toolName` filtering already guarantees this (only `bash` is rewritten). |
| XR-3 | WSL stdin-transport sessions must wrap identically to argv-transport sessions (unit-test the wrapper text; integration-test under WSL where available). |
| XR-4 | `process.platform` and probe results are resolved at `session_start` only; the per-call path stays pure (PRD-001 NFR-1). |
| XR-5 | The README documents the platform matrix and the exact env-var behavior per platform. |

## 4. Windows strategy (phased)

### Phase W1 — inert no-op (v1, ships with PRD-001)

Native Windows: extension disables itself when `process.platform === "win32"` **unless** a probe succeeding later proves MSYS `nice` works (see W2). Rationale: `nice` has no native Win32 meaning; pi's default Windows shell is PowerShell, which this package does not touch. Users get a documented no-op.

### Phase W2 — probe-based best effort (Git Bash users)

Replace the hard `win32` pre-filter with the probe alone. Git Bash/MSYS2 environments ship a `nice` whose behavior is emulated by the MSYS runtime; if `nice -n <level> true` succeeds there, `bash`-tool commands run through the same wrapper as on Unix. Risk: emulation fidelity of MSYS nice is uneven across Git for Windows releases — acceptable because the probe is per-session and fail-open.

### Phase W3 — process-wide priority fallback (optional, config-gated)

For users who want coverage of the `powershell` tool too: at `session_start`, set the pi process to a lower priority class via `node:os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)`. Every spawned child (PowerShell, bash, git, ripgrep) inherits it.

- Triggered only by an explicit opt-in env var (e.g. `PI_BASH_PRIORITY_CLASS=below-normal`), never by default.
- Trade-off documented in RESEARCH.md §4: this also lowers pi's own scheduling priority and is not command-scoped.
- On Unix this var is ignored (mechanism A already covers it).

### Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Wrapping PowerShell calls with `Start-Process -Priority BelowNormal` | Does not capture stdout/stderr into the tool result without restructuring output plumbing; breaks the shell-tool contract. |
| Post-spawn `Process.PriorityClass` adjustment (renice analog) | Requires owning the spawn to know the PID → drags in mechanism B and its ownership conflicts (PRD-001 §6). |
| `cmd /c start /low /b /wait` wrapper | `start` redirects/attaches console unpredictably; breaks streaming output and exit-code propagation. |

## 5. Testing and acceptance criteria

| ID | Platform | Criterion |
| --- | --- | --- |
| XC-1 | Linux/macOS | PRD-001 acceptance suite passes unchanged (these are the reference platforms). |
| XC-2 | WSL (if available in CI/dev) | Wrapped call observed at the configured niceness via stdin transport; ESC-abort kills the tree. |
| XC-3 | Windows native | Package installs, loads, logs nothing, rewrites nothing; a full agent session behaves identically with and without it. |
| XC-4 | Windows + Git Bash shell | Probe outcome decides: either wrapped MSYS calls with correct exit codes/output, or clean inert no-op — never a corrupted command. |
| XC-5 | All | `npm run check` passes on every CI OS in the matrix (unit tests assert platform pre-filter logic with injected `platform` values, not the host's). |

## 6. Rollout

1. **W1** ships inside PRD-001's R1–R4 (platform pre-filter + probe + README matrix).
2. **W2** is a follow-up release gated on one Git-for-Windows validation report (community or maintainer).
3. **W3** is opt-in and lands only after W2 evidence, since its value is mostly for Windows users with the PowerShell tool.

## 7. Open questions

1. Is there measurable demand for PowerShell-tool coverage (W3), or are Windows pi users predominantly on WSL/Git Bash? Decide W3 after W2 feedback.
2. Should `PI_BASH_PRIORITY_CLASS` also expose `idle` (Windows `IDLE_PRIORITY_CLASS`)? Depends on W3.
3. Does macOS App-Nap / QoS interact with BSD nice in ways worth documenting? Low priority; cosmetic.
