/**
 * Background-aware `bash` tool override (PRD-003 §7.1 / §7.2).
 *
 * The definition is the built-in bash definition (schema, description,
 * renderers, truncation, PI_* env) with only `execute` replaced and only the
 * process seam replaced via BashOperations. `execute` races the built-in run
 * against a per-toolCallId "background this call" request (ctrl+b), so a move
 * to the background ends the tool row immediately without restarting work.
 *
 * Spawn choice (documented per task): `buildNiceCommand` returns a full shell
 * string (`nice -n N bash -c '…'`). Instead of re-parsing that string or
 * using `shell: true`, we use its *decision* (null when already wrapped /
 * empty) and spawn the equivalent explicit argv without a shell:
 *   ["nice", "-n", String(fgNice), "bash", "-c", originalCommand]
 *   ["bash", "-c", originalCommand]            (already-wrapped case)
 * `detached: true` makes the child its own process-group leader (pgid = pid),
 * which is what ctrl+b adoption and group kills rely on.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { createBashToolDefinition, type BashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { buildNiceCommand } from "./nice.ts";
import type { BgTask, TaskManagerApi } from "./types.ts";

/**
 * Foreground spawn argv (PRD-001/PRD-004): absolute `nice` binary when probed
 * and configured, otherwise the plain shell — never a bare `nice` name lookup,
 * which fails with ENOENT under restricted PATHs.
 */
export function buildForegroundArgv(command: string, fgNice: number, niceBin?: string): string[] {
	if (!niceBin || fgNice <= 0) return ["bash", "-c", command];
	return [niceBin, "-n", String(fgNice), "bash", "-c", command];
}

export interface BashOverrideDeps {
	registry: TaskManagerApi;
	/** Foreground nice level (PRD-001 contract). */
	fgNice: number;
	/** Notified when a foreground bash command starts/ends (ctrl+b hint/UI). */
	onForegroundChange?: (inFlight: { command: string } | null) => void;
	/** Adoption tail buffer bound (§8 PI_BG_LOG_BYTES). Default 50_000. */
	logBytes?: number;
	/** SIGTERM→SIGKILL grace for abort/timeout kills. Default 3000 ms. */
	killGraceMs?: number;
	/** Absolute `nice` binary (from probe). When absent, no nice prefix is applied. */
	niceBin?: string;
	/** Foreground timeout cap in seconds (§8 PI_BASH_FG_TIMEOUT_MAX). Default 60. */
	fgTimeoutMax?: number;
	/** Background timeout cap in seconds (§8 PI_BASH_TIMEOUT_BG_MAX). Default 300. */
	bgTimeoutMax?: number;
}

const DEFAULT_LOG_BYTES = 50_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

interface ForegroundSlot {
	toolCallId: string;
	child: ChildProcess;
	pgid: number;
	command: string;
	cwd: string;
	startedAt: number;
	/** Bounded tail of everything emitted before adoption. */
	tail: Buffer[];
	tailBytes: number;
	logBytes: number;
	/** Forward child data to the built-in call (false after adoption/close). */
	accepting: boolean;
	/** Set once; makes requestBackground idempotent. */
	backgrounded: boolean;
	/** Resolve the abandoned exec so the built-in call settles immediately. */
	settle: (result: { exitCode: number | null }) => void;
	/** Remove abort listener / timeout timer / grace kill timer. */
	detach: () => void;
}

const slots = new Map<string, ForegroundSlot>();
const pendingBackground = new Map<string, (task: BgTask) => void>();
/** Per-call working-directory override (PRD-004 §4.1 `cwd`), consumed by exec. */
const cwdOverrides = new Map<string, string>();
/**
 * The masked tool's executor, shared with the bash execution hook (PRD-004
 * §7 priority transport). Set by createBackgroundAwareBashTool.
 */
let sharedOperations: BashOperations | undefined;

/** PRD-004 §7 — the operations behind the masked tool (undefined while inactive). */
export function getSharedOperations(): BashOperations | undefined {
	return sharedOperations;
}

export type TaskAction = "list" | "status" | "kill" | "input" | "adopt";

export interface TaskActionParams {
	taskAction: TaskAction;
	taskId?: string;
	input?: string;
}

export interface TaskActionResult {
	text: string;
	details?: BgTask;
	isError?: boolean;
}

/** Local "HH:MM:SS" for task lines. */
function clock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function taskLine(task: BgTask): string {
	return `${task.id}  ${task.command}  ${task.status}  (started ${clock(task.startedAt)})`;
}

/**
 * Management verbs on the Bash surface (PRD-004 §4.1 `taskAction`).
 * Pure delegation to the registry — no process work here.
 */
export async function runTaskAction(
	registry: TaskManagerApi,
	params: TaskActionParams,
): Promise<TaskActionResult> {
	const { taskAction } = params;

	if (taskAction === "list") {
		const tasks = registry.list();
		if (tasks.length === 0) return { text: "No background tasks." };
		return { text: tasks.map(taskLine).join("\n") };
	}

	if (taskAction === "adopt") {
		const foreground = getForeground();
		if (!foreground) return { text: "No foreground command is currently running.", isError: true };
		const task = requestBackground(foreground.toolCallId);
		if (!task) return { text: "No foreground command is currently running.", isError: true };
		return {
			text: `Moved to background: ${task.id} (${task.command})\nOutput: ${task.logPath}`,
			details: task,
		};
	}

	const target = params.taskId;
	if (!target) return { text: `Missing required parameter: taskId (for "${taskAction}").`, isError: true };
	const task = registry.get(target);
	if (!task) return { text: `Unknown task: ${target}.`, isError: true };

	if (taskAction === "status") {
		const log = await registry.logs(task.id);
		return { text: `${taskLine(task)}\n\n${log}`, details: task };
	}
	if (taskAction === "kill") {
		await registry.kill(task.id);
		return { text: `Killed ${task.id} (${task.command})`, details: task };
	}
	// taskAction === "input"
	if (params.input === undefined) {
		return { text: `Missing required parameter: input (for "input").`, isError: true };
	}
	return { text: registry.sendInput(task.id, params.input), details: task };
}

/** §4.3 wording — exact. */
export function formatBackgroundToolResult(task: BgTask): string {
	return [
		`Tool is running as a background task with task id: ${task.id}`,
		`Output: ${task.logPath}`,
		"Do not poll. You will be notified when it finishes.",
	].join("\n");
}

/**
 * Normalize raw bash tool arguments BEFORE schema validation (PRD-004
 * §4.1, wired via ToolDefinition.prepareArguments). Models routinely emit
 * empty strings for optional parameters ("taskAction": "", "cwd": "" …),
 * which fails the taskAction enum; they also stringify booleans/numbers.
 * Rules: blank strings become absent; "true"/"false" coerce to booleans;
 * numeric strings coerce to numbers; an unrecognized taskAction is dropped
 * (the call then executes as a normal foreground command).
 */
/**
 * Immediate timeout validation (PRD-004 §4.1): a timeout above the mode's cap
 * is REJECTED with an actionable error — never silently clamped (a silent
 * clamp makes the model believe it has 999s when it has 60s).
 */
export function validateTimeout(
	timeout: number | undefined,
	background: boolean,
	caps: { fg: number; bg: number },
): string | undefined {
	if (timeout === undefined) return undefined;
	const cap = background ? caps.bg : caps.fg;
	const label = background ? "background" : "foreground";
	if (timeout > cap) {
		return (
			background
				? `Timeout ${timeout}s exceeds the background cap of ${cap}s (PI_BASH_TIMEOUT_BG_MAX).`
				: `Timeout ${timeout}s exceeds the foreground cap of ${cap}s (PI_BASH_FG_TIMEOUT_MAX). For long-running work, set background=true (background cap: ${caps.bg}s) instead.`
		);
	}
	if (timeout < 1) {
		return `Timeout must be at least 1 second.`;
	}
	return undefined;
}

export interface NormalizedBashArgs {
	command?: string;
	timeout?: number;
	background?: boolean;
	taskName?: string;
	cwd?: string;
	intent?: string;
	tool?: string;
	taskAction?: "list" | "status" | "kill" | "input" | "adopt";
	taskId?: string;
	input?: string;
}

const TASK_ACTIONS = new Set(["list", "status", "kill", "input", "adopt"]);

export function normalizeBashArgs(raw: unknown): NormalizedBashArgs {
	const args = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const out: NormalizedBashArgs = {};

	const str = (key: keyof NormalizedBashArgs): void => {
		const value = args[key];
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		// Models sometimes emit literal "null"/"undefined" — treat as absent.
		if (trimmed === "" || trimmed === "null" || trimmed === "undefined") return;
		out[key] = value as never;
	};

	str("command");
	str("taskName");
	str("cwd");
	str("intent");
	str("tool");
	str("taskId");
	str("input");

	if (typeof args.timeout === "number" && Number.isFinite(args.timeout)) {
		out.timeout = args.timeout;
	} else if (typeof args.timeout === "string" && args.timeout.trim() !== "" && !Number.isNaN(Number(args.timeout))) {
		out.timeout = Number(args.timeout);
	}

	if (typeof args.background === "boolean") out.background = args.background;
	else if (args.background === "true") out.background = true;
	else if (args.background === "false") out.background = false;

	if (typeof args.taskAction === "string" && TASK_ACTIONS.has(args.taskAction)) {
		out.taskAction = args.taskAction as NormalizedBashArgs["taskAction"];
	}

	return out;
}

/**
 * Drop a redundant leading `cd <tool-cwd> &&` (PRD-004 §4.1): models often
 * emit `cd <current-dir-full-path> && …` although the tool already runs in
 * that directory. Only an exact match against `cwd` (after unquoting and
 * trailing-slash normalization) is stripped — any other `cd` is preserved.
 */
export function stripCdPrefix(command: string, cwd: string): string {
	const match = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))(\s*&&)/.exec(command);
	if (!match) return command;
	const raw = match[1] ?? match[2] ?? match[3] ?? "";
	// `.` and unexpanded $PWD always mean "the current directory" — the model
	// emits them interchangeably with the absolute path (field finding).
	const normalized =
		raw === "." || raw === "$PWD" || raw === "\"$PWD\"" || raw === "'$PWD'"
			? cwd.replace(/\/+$/, "")
			: raw.replace(/\/+$/, "");
	const target = cwd.replace(/\/+$/, "");
	if (normalized !== target) return command;
	return command.slice(match.index + match[0].length).replace(/^\s*/, "");
}

/**
 * ctrl+b entry point: adopt the in-flight bash call as a background task.
 * Idempotent — a second call for the same (or an unknown) toolCallId returns
 * undefined. Returns the adopted BgTask on success.
 */
export function requestBackground(toolCallId: string): BgTask | undefined {
	const slot = slots.get(toolCallId);
	if (!slot || slot.backgrounded) return undefined;
	slot.backgrounded = true;
	slot.accepting = false;
	slot.detach();
	const preOutput = Buffer.concat(slot.tail, slot.tailBytes);
	// Register first (§7.2 step 1); adoption never fails because of priority work.
	const task = depsRegistry?.adopt({
		child: slot.child,
		pgid: slot.pgid,
		command: slot.command,
		cwd: slot.cwd,
		startedAt: slot.startedAt,
		preOutput,
	});
	slots.delete(toolCallId);
	slot.settle({ exitCode: null });
	const resolve = pendingBackground.get(toolCallId);
	pendingBackground.delete(toolCallId);
	if (resolve && task) resolve(task);
	if (task) lastDeps?.onForegroundChange?.(null);
	return task;
}

/** The most recently started still-foreground call, for the ctrl+b handler. */
export function getForeground(): { toolCallId: string; command: string } | null {
	let found: { toolCallId: string; command: string } | null = null;
	for (const slot of slots.values()) {
		if (!slot.backgrounded) found = { toolCallId: slot.toolCallId, command: slot.command };
	}
	return found;
}

// Module-level wiring used by requestBackground (the extension owns one tool
// instance per session; tests may reset via resetBashOverrideState()).
let depsRegistry: TaskManagerApi | undefined;
let lastDeps: BashOverrideDeps | undefined;

/** Test seam: clear module state between sessions/tests. */
export function resetBashOverrideState(): void {
	slots.clear();
	pendingBackground.clear();
	depsRegistry = undefined;
	lastDeps = undefined;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// ESRCH: already gone — fine.
	}
}

function startKill(child: ChildProcess, graceMs: number): NodeJS.Timeout | undefined {
	if (!child.pid) return undefined;
	const pid = child.pid;
	killGroup(pid, "SIGTERM");
	const timer = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
	timer.unref?.();
	return timer;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > 2_147_483_647) {
		throw new Error("Invalid timeout: maximum is 2147483 seconds");
	}
	return timeoutMs;
}

export function createBackgroundAwareBashTool(cwd: string, deps: BashOverrideDeps): ToolDefinition {
	depsRegistry = deps.registry;
	lastDeps = deps;
	const logBytes = Math.max(1024, deps.logBytes ?? DEFAULT_LOG_BYTES);
	const killGraceMs = Math.max(0, deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS);

	const operations: BashOperations = {
		exec: (command, execCwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) return Promise.reject(new Error("aborted"));

			// PRD-004 §4.1: per-call `cwd` parameter overrides the spawn directory.
			const spawnCwd = cwdOverrides.get(currentToolCallId) ?? execCwd;
			cwdOverrides.delete(currentToolCallId);

			const argv = buildForegroundArgv(command, deps.fgNice, deps.niceBin);
			// Never let a restricted child env drop PATH — the shell still needs it.
			const childEnv = { ...process.env, ...(env ?? {}) };
			const child = spawn(argv[0], argv.slice(1), {
				cwd: spawnCwd,
				detached: process.platform !== "win32",
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const toolCallId = currentToolCallId;
				const pgid = child.pid ?? 0;
				let timedOut = false;
				let settled = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				let graceHandle: NodeJS.Timeout | undefined;
				let accept = true;
				const tail: Buffer[] = [];
				let tailBytes = 0;

				const appendTail = (data: Buffer) => {
					tail.push(data);
					tailBytes += data.length;
					while (tailBytes > logBytes && tail.length > 1) {
						const dropped = tail.shift()!;
						tailBytes -= dropped.length;
					}
					if (tailBytes > logBytes && tail.length === 1) {
						const only = tail[0]!;
						tail[0] = only.subarray(only.length - logBytes);
						tailBytes = tail[0]!.length;
					}
				};

				const finish = (result: { exitCode: number | null }, error?: Error) => {
					if (settled) return;
					settled = true;
					if (graceHandle) clearTimeout(graceHandle);
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
					slots.delete(toolCallId);
					deps.onForegroundChange?.(null);
					if (error) reject(error);
					else resolve(result);
				};

				const onAbort = () => {
					if (graceHandle) return;
					graceHandle = startKill(child, killGraceMs);
				};

				const slot: ForegroundSlot = {
					toolCallId,
					child,
					pgid,
					command,
					cwd: spawnCwd,
					startedAt: Date.now(),
					tail,
					tailBytes,
					logBytes,
					accepting: true,
					backgrounded: false,
					settle: (result) => finish(result),
					detach: () => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
						if (signal) signal.removeEventListener("abort", onAbort);
					},
				};
				// Keep tail accounting live on the slot after adoption reads it.
				Object.defineProperty(slot, "tailBytes", { get: () => tailBytes });
				slots.set(toolCallId, slot);

				const forward = (data: Buffer) => {
					appendTail(data);
					if (accept && slot.accepting) onData(data);
				};
				child.stdout?.on("data", forward);
				child.stderr?.on("data", forward);

				child.once("error", (err) => {
					finish({ exitCode: null }, err);
				});
				child.once("close", (code, sig) => {
					accept = false;
					if (signal?.aborted) {
						finish({ exitCode: null }, new Error("aborted"));
						return;
					}
					if (timedOut) {
						finish({ exitCode: null }, new Error(`timeout:${timeout}`));
						return;
					}
					const exitCode = code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1);
					finish({ exitCode });
				});

				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						graceHandle = startKill(child, killGraceMs);
					}, timeoutMs);
					timeoutHandle.unref?.();
				}
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				deps.onForegroundChange?.({ command });
			});
		},
	};

	const builtin = createBashToolDefinition(cwd, { operations });
	sharedOperations = operations;

	// The in-flight toolCallId is set by ourExecute immediately around the
	// delegated built-in call; exec runs inside that call.
	let currentToolCallId = "";

	const fgCap = Math.max(1, deps.fgTimeoutMax ?? 60);
	const bgCap = Math.max(1, deps.bgTimeoutMax ?? 300);

	// PRD-004 §4.1: extended schema — execution (command/timeout/background/
	// taskName/cwd) and management (taskAction/taskId/input) in one tool.
	const bashParams = Type.Object({
		command: Type.Optional(
			Type.String({
				description:
					"The exact command line to execute. A leading `cd <current-directory> &&` for the current directory is dropped automatically. Required unless taskAction is set.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: `Optional. Max seconds to run. Foreground commands may run at most ${fgCap}s and background tasks at most ${bgCap}s — larger values are rejected.`,
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Run as a background task (task-N) at low priority: returns immediately, notifies on completion. Use for dev servers, watchers, long test suites. Never poll — you will be notified when it finishes.",
			}),
		),
		taskName: Type.Optional(
			Type.String({ description: "Optional short name for the background task (shown in the task list and notifications)." }),
		),
		cwd: Type.Optional(
			Type.String({ description: "Optional working directory. Defaults to the current execution directory." }),
		),
		intent: Type.Optional(
			Type.String({
				description:
					"Optional short intent shown as the call header by compatible renderers (e.g. pi-ui-enhancement), e.g. 'check which files are dirty'.",
			}),
		),
		tool: Type.Optional(
			Type.String({
				description:
					"Optional header label shown by compatible renderers (e.g. pi-ui-enhancement), e.g. 'git status'.",
			}),
		),
		taskAction: Type.Optional(
			Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("status"),
					Type.Literal("kill"),
					Type.Literal("input"),
					Type.Literal("adopt"),
				],
				{
					description:
						"Manage background tasks instead of executing a command: 'list' reports tasks (running first), " +
						"'status' shows a task's state plus output tail, 'kill' terminates a task, 'input' writes to a task's " +
						"stdin, 'adopt' moves the currently running foreground command into a background task. " +
						"When set, all execution parameters are ignored.",
				},
			),
		),
		taskId: Type.Optional(Type.String({ description: 'Task id such as "task-7" (required for status/kill/input).' })),
		input: Type.Optional(Type.String({ description: "Text to write to the task stdin (required with taskAction 'input')." })),
	});
	type BashParams = Static<typeof bashParams>;

	// Fully overridden description (PRD-004 §4.1): documents every parameter,
	// both execution modes, the timeout caps and rejection semantics, priority,
	// and management verbs. The model should never have to guess a limit.
	const amendedDescription = `Execute a shell command in the session's workspace.

## Execution modes

**Foreground (default).** Output streams back while the command runs; the
result contains stdout+stderr (truncated when large) and the exit code.
Foreground commands may run at most ${fgCap}s (PI_BASH_FG_TIMEOUT_MAX); a
timeout above that cap is rejected immediately.

**Background (background=true).** The command starts immediately as a
background task at low CPU/IO priority and the call returns at once with a
task id (task-N) and a log path. Background tasks may run at most
${bgCap}s (PI_BASH_TIMEOUT_BG_MAX); a timeout above that cap is rejected.
Label the task with taskName.

## Parameters

- command: the exact command line. A leading \`cd <current-directory> &&\`
  (or \`cd .\` / \`cd $PWD\`) is redundant — the tool already runs in the
  current directory — and is dropped automatically. A \`cd\` to a DIFFERENT
  directory is meaningful and is preserved.
- cwd: optional working directory for this command; defaults to the current
  execution directory.
- timeout: optional, in seconds. Foreground cap ${fgCap}s, background cap
  ${bgCap}s; supplying more is rejected immediately with the cap named.
- background: set true for dev servers, watchers, long test suites, or any
  command that outlives a single turn.
- taskName: short human-readable label for a background task (shown in the
  task list and notifications).

## Background tasks — rules

1. After starting a background task, either continue other work or end your
   turn. The system notifies you when the task finishes — NEVER poll, and
   never use sleep to wait for a task.
2. Manage tasks with taskAction: "list" (all tasks, running first), "status"
   (state + recent output), "kill" (terminate), "input" (write to a task's
   stdin), "adopt" (move the currently running foreground command to the
   background). When taskAction is set, all execution parameters are ignored.
3. If the user asks to move a running foreground command to the background,
   use taskAction "adopt".

## Priority

Foreground commands run at reduced CPU priority (nice, configurable) so the
user's machine stays responsive; background tasks run at an even lower
priority and idle IO class. An optional \`intent\` and \`tool\` label describe
the call for compatible UI renderers.`;

	const ourExecute = async (
		toolCallId: string,
		params: BashParams,
		signal: AbortSignal | undefined,
		onUpdate: Parameters<typeof builtin.execute>[3],
		ctx: Parameters<typeof builtin.execute>[4],
	): Promise<unknown> => {
		// ---- timeout validation (reject, never clamp) --------------------
		const timeoutProblem = validateTimeout(
			params.timeout,
			params.background === true,
			{ fg: fgCap, bg: bgCap },
		);
		if (timeoutProblem) {
			return {
				content: [{ type: "text", text: timeoutProblem }],
				isError: true,
			};
		}

		// ---- management branch (PRD-004 §4.1 taskAction) ----------------
		if (params.taskAction) {
			const outcome = await runTaskAction(deps.registry, {
				taskAction: params.taskAction,
				taskId: params.taskId,
				input: params.input,
			});
			return {
				content: [{ type: "text", text: outcome.text }],
				details: outcome.details,
				isError: outcome.isError === true,
			};
		}
		if (params.command === undefined || params.command.trim() === "") {
			return {
				content: [{ type: "text", text: "Missing required parameter: command (or set taskAction)." }],
				isError: true,
			};
		}

		// PRD-004 §4.1: drop a redundant `cd <current-dir> &&` and resolve cwd.
		const effectiveCwd = params.cwd?.trim() ? params.cwd : cwd;
		const command = stripCdPrefix(params.command, effectiveCwd);

		// ---- background branch (PRD-004 §4.1) ---------------------------
		if (params.background) {
			const timeoutSeconds = params.timeout;
			const task = await deps.registry.run(command, effectiveCwd, {
				name: params.taskName,
				timeoutSeconds,
			});
			return {
				content: [{ type: "text", text: formatBackgroundToolResult(task) }],
				details: task,
				isError: false,
			};
		}

		// ---- foreground branch: validated timeout, cwd override, race ----
		const clampedTimeout = params.timeout;
		if (effectiveCwd !== cwd) cwdOverrides.set(toolCallId, effectiveCwd);

		let resolveBg!: (task: BgTask) => void;
		const bgPromise = new Promise<{ __bgTask: BgTask }>((resolve) => {
			resolveBg = (task) => resolve({ __bgTask: task });
		});
		pendingBackground.set(toolCallId, (task) => resolveBg(task));
		currentToolCallId = toolCallId;

		const builtinParams = { command, timeout: clampedTimeout };
		const builtinRun = builtin.execute(toolCallId, builtinParams, signal, onUpdate, ctx);
		// Defuse the eventual loser regardless of who wins the race.
		void builtinRun.catch(() => {});
		try {
			const raced = (await Promise.race([builtinRun, bgPromise])) as
				| { __bgTask: BgTask }
				| Awaited<typeof builtinRun>;
			if ("__bgTask" in raced) {
				const task = raced.__bgTask;
				return {
					content: [{ type: "text", text: formatBackgroundToolResult(task) }],
					details: task,
					isError: false,
				};
			}
			return raced;
		} finally {
			pendingBackground.delete(toolCallId);
		}
	};

	// Expanded (ctrl+o) view shows the resolved working directory (PRD-004 §4.1).
	const baseRenderCall = builtin.renderCall;
	const renderCall = (
		args: BashParams,
		theme: Parameters<NonNullable<typeof builtin.renderCall>>[1],
		context: Parameters<NonNullable<typeof builtin.renderCall>>[2],
	) => {
		// Junk-safe: models emit literal "null"/"undefined" strings for absent
		// optionals — those count as absent here too (display-side guard;
		// execution-side is covered by prepareArguments normalization).
		const junk = (v: unknown): string => {
			if (typeof v !== "string") return "";
			const t = v.trim();
			return t === "" || t === "null" || t === "undefined" ? "" : t;
		};
		const taskActionDisplay = junk(args.taskAction);
		const managementLine = taskActionDisplay
			? [truncateToWidth(theme.fg("accent", "bash") + theme.fg("dim", ` tasks ${taskActionDisplay}${junk(args.taskId) ? ` ${junk(args.taskId)}` : ""}`), context.expanded ? Number.MAX_SAFE_INTEGER : 200)]
			: undefined;
		const base = managementLine ? undefined : baseRenderCall?.(args as { command: string }, theme, context);
		if (!base) {
			const lines = managementLine ?? [];
			return {
				invalidate() {},
				render(width: number): string[] {
					const out = context.expanded && !managementLine && args.cwd?.trim() ? lines : lines;
					if (!managementLine) {
						const effectiveCwd = args.cwd?.trim() ? args.cwd : context.cwd || cwd;
						if (context.expanded) out.push(truncateToWidth(theme.fg("dim", `cwd: ${effectiveCwd}`), width));
					}
					return out.map((line) => truncateToWidth(line, width));
				},
			};
		}
		const effectiveCwd = args.cwd?.trim() ? args.cwd : context.cwd || cwd;
		return {
			invalidate() {
				base.invalidate?.();
			},
			render(width: number): string[] {
				const lines = base.render(width);
				if (!context.expanded) return lines;
				return [...lines, truncateToWidth(theme.fg("dim", `cwd: ${effectiveCwd}`), width)];
			},
		};
	};

	return {
		...builtin,
		parameters: bashParams,
		description: amendedDescription,
		prepareArguments: (args: unknown) => normalizeBashArgs(args) as unknown,
		renderCall,
		execute: ourExecute,
	} as unknown as ToolDefinition;
}
