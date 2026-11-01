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
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { buildNiceCommand } from "./nice.ts";
import type { BgTask, TaskManagerApi } from "./types.ts";
import {
	renderBashCall,
	renderBackgroundTaskCall,
	renderManageBackgroundTaskCall,
	type BashCallArgs,
	type BackgroundTaskCallArgs,
	type ManageBackgroundTaskCallArgs,
	type BashCallRenderOptions,
} from "./ui/bash-display.ts";
import {
	renderBashResult,
	renderBackgroundTaskResult,
	renderManageBackgroundTaskResult,
	type BashRenderTheme,
	type BashResultRenderOptions,
} from "./ui/bash-result.ts";

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
	/** Whether this tool instance is configured for a subagent or main agent session. */
	callerType?: "agent" | "subagent";
	/** Optional subagent name/id. */
	subagentName?: string;
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
	/** Optional bash call render options (intentMode, showCommand, maxCommandChars). */
	renderOptions?: BashCallRenderOptions;
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

export type TaskAction = "list" | "status" | "logs" | "kill" | "input" | "adopt";

export interface TaskActionParams {
	taskAction?: TaskAction;
	action?: TaskAction;
	taskId?: string;
	input?: string;
	lines?: number;
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
	const taskAction = params.action ?? params.taskAction;
	if (!taskAction) {
		return { text: "Missing required parameter: action (list, status, logs, kill, input, adopt).", isError: true };
	}

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

	if (taskAction === "status" || taskAction === "logs") {
		let log = await registry.logs(task.id);
		if (params.lines && params.lines > 0) {
			const split = log.split("\n");
			if (split.length > params.lines) {
				log = split.slice(-params.lines).join("\n");
			}
		}
		if (taskAction === "logs") {
			return { text: log || "(no log output yet)", details: task };
		}
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

export interface NormalizedBackgroundTaskArgs {
	command?: string;
	taskName?: string;
	timeout?: number;
	cwd?: string;
	intent?: string;
	tool?: string;
}

export function normalizeBackgroundTaskArgs(raw: unknown): NormalizedBackgroundTaskArgs {
	const args = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const out: NormalizedBackgroundTaskArgs = {};

	for (const key of ["command", "taskName", "cwd", "intent", "tool"] as const) {
		const val = args[key];
		if (typeof val === "string") {
			const trimmed = val.trim();
			if (trimmed !== "" && trimmed !== "null" && trimmed !== "undefined") {
				out[key] = val;
			}
		}
	}

	if (typeof args.timeout === "number" && Number.isFinite(args.timeout)) {
		out.timeout = args.timeout;
	} else if (typeof args.timeout === "string" && args.timeout.trim() !== "" && !Number.isNaN(Number(args.timeout))) {
		out.timeout = Number(args.timeout);
	}

	return out;
}

export interface NormalizedManageBackgroundTaskArgs {
	action?: TaskAction;
	taskId?: string;
	input?: string;
	lines?: number;
}

const VALID_ACTIONS = new Set<TaskAction>(["list", "status", "logs", "kill", "input", "adopt"]);

export function normalizeManageBackgroundTaskArgs(raw: unknown): NormalizedManageBackgroundTaskArgs {
	const args = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const out: NormalizedManageBackgroundTaskArgs = {};

	const actionRaw =
		typeof args.action === "string"
			? args.action.trim()
			: typeof args.taskAction === "string"
				? args.taskAction.trim()
				: undefined;
	if (actionRaw && VALID_ACTIONS.has(actionRaw as TaskAction)) {
		out.action = actionRaw as TaskAction;
	}

	for (const key of ["taskId", "input"] as const) {
		const val = args[key];
		if (typeof val === "string") {
			const trimmed = val.trim();
			if (trimmed !== "" && trimmed !== "null" && trimmed !== "undefined") {
				out[key] = val;
			}
		}
	}

	if (typeof args.lines === "number" && Number.isFinite(args.lines)) {
		out.lines = args.lines;
	} else if (typeof args.lines === "string" && args.lines.trim() !== "" && !Number.isNaN(Number(args.lines))) {
		out.lines = Number(args.lines);
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
	const task = depsRegistry?.adopt(
		{
			child: slot.child,
			pgid: slot.pgid,
			command: slot.command,
			cwd: slot.cwd,
			startedAt: slot.startedAt,
			preOutput,
		},
		{
			callerType: lastDeps?.callerType,
			subagentName: lastDeps?.subagentName,
		},
	);
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

/**
 * Flatten mutually exclusive object variants into one provider-safe tool schema.
 *
 * The variants are the contract: each declares its own parameters plainly, so
 * `command` is required in the execute variant and `taskAction` (+ `taskId`,
 * `input`) is required in the management variants — no `Type.Optional` around
 * the fields that matter.
 *
 * A bare `Type.Union(variants)` cannot be used as the tool schema, though: pi's
 * Anthropic adapter rebuilds `input_schema` as
 * `{ type: "object", properties: schema.properties ?? {} }`, so a top-level
 * union would ship `properties: {}` and leave the model with no arguments.
 * Flattening therefore emits
 *
 *     { type: "object", properties: {…}, oneOf: [{required: […]}, …] }
 *
 * which stays object-shaped for every provider while the validator still
 * requires exactly one variant. Properties are inevitably re-declared optional
 * at the root — JSON Schema property optionality is per-object, not per-branch
 * — so that mechanical (and lossless) part is generated here rather than
 * hand-written at the declaration site.
 */
function flattenVariants(
	executeVariant: TObject,
	manageVariants: TObject[],
	options: Record<string, unknown> = {},
): TObject {
	/** key → every distinct schema any variant declares for it. */
	const byKey = new Map<string, TSchema[]>();
	const addProperty = (key: string, schema: TSchema): void => {
		const known = byKey.get(key) ?? [];
		const fingerprint = JSON.stringify(schema);
		if (!known.some((existing) => JSON.stringify(existing) === fingerprint)) known.push(schema);
		byKey.set(key, known);
	};

	for (const [key, schema] of Object.entries(executeVariant.properties as Record<string, TSchema>)) {
		addProperty(key, schema);
	}
	for (const variant of manageVariants) {
		for (const [key, schema] of Object.entries(variant.properties as Record<string, TSchema>)) {
			addProperty(key, schema);
		}
	}

	const branches: Array<{
		required: string[];
		properties?: Record<string, TSchema>;
		not?: { required: string[] };
	}> = [];

	// Execution branch: requires command, forbids taskAction
	branches.push({
		required: [...((executeVariant.required ?? ["command"]) as string[])],
		not: { required: ["taskAction"] },
	});

	// Management branches: each requires taskAction (+ action params), forbids command
	for (const variant of manageVariants) {
		const properties = variant.properties as Record<string, TSchema>;
		const discriminator: Record<string, TSchema> = {};
		for (const [key, schema] of Object.entries(properties)) {
			if (typeof (schema as { const?: unknown }).const === "string") discriminator[key] = schema;
		}

		branches.push({
			required: [...((variant.required ?? []) as string[])],
			...(Object.keys(discriminator).length > 0 ? { properties: discriminator } : {}),
			not: { required: ["command"] },
		});
	}

	const properties: Record<string, TSchema> = {};
	for (const [key, schemas] of byKey) {
		const unionOptions = key === "taskAction" ? { description: "Manage background tasks: list, status, kill, input, adopt." } : undefined;
		properties[key] = Type.Optional(schemas.length === 1 ? schemas[0]! : Type.Union(schemas, unionOptions));
	}

	return Type.Object(properties, { ...options, oneOf: branches } as never);
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

	const bashParams = Type.Object({
		command: Type.String({
			description:
				"The exact command line to execute. A leading `cd <current-directory> &&` for the current directory is dropped automatically.",
		}),
		timeout: Type.Optional(
			Type.Number({
				description: `Optional. Max seconds to run (cap: ${fgCap}s). Large values are rejected. For long-running commands, use background_task.`,
			}),
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
	}, {
		description:
			`Execute a shell command in the foreground. Output streams back while the command runs; the result contains stdout+stderr and exit code. ` +
			`Foreground commands may run at most ${fgCap}s. For long-running commands, use background_task. To manage tasks, use manage_background_task.`,
	});

	type BashParams = {
		command?: string;
		timeout?: number;
		background?: boolean;
		taskName?: string;
		cwd?: string;
		intent?: string;
		tool?: string;
		taskAction?: TaskAction;
		action?: TaskAction;
		taskId?: string;
		input?: string;
		lines?: number;
	};

	const amendedDescription = `Execute a shell command in the session's workspace in the foreground.

## Execution

Output streams back while the command runs; the result contains stdout+stderr (truncated when large) and the exit code.
Foreground commands may run at most ${fgCap}s (PI_BASH_FG_TIMEOUT_MAX); a timeout above that cap is rejected immediately.

## Dedicated Tools

- For long-running commands, dev servers, watchers, or builds, use \`background_task\` instead.
- To view, inspect, or manage background tasks, use \`manage_background_task\`.

## Parameters

- command: the exact command line to run. A leading \`cd <current-directory> &&\` (or \`cd .\` / \`cd $PWD\`) is redundant and dropped automatically.
- cwd: optional working directory for this command; defaults to the current execution directory.
- timeout: optional, in seconds (cap: ${fgCap}s).

## Priority

Foreground commands run at reduced CPU priority (nice, configurable) so the user's machine stays responsive.`;

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

		// ---- fail-open management branch if model called bash with taskAction ----
		if (params.taskAction || params.action) {
			const outcome = await runTaskAction(deps.registry, {
				taskAction: params.action ?? params.taskAction,
				taskId: params.taskId,
				input: params.input,
				lines: params.lines,
			});
			return {
				content: [{ type: "text", text: outcome.text }],
				details: outcome.details,
				isError: outcome.isError === true,
			};
		}
		if (params.command === undefined || params.command.trim() === "") {
			return {
				content: [{ type: "text", text: "Missing required parameter: command." }],
				isError: true,
			};
		}

		// PRD-004 §4.1: drop a redundant `cd <current-dir> &&` and resolve cwd.
		const effectiveCwd = params.cwd?.trim() ? params.cwd : cwd;
		const command = stripCdPrefix(params.command, effectiveCwd);

		// ---- fail-open background branch if model called bash with background: true ----
		if (params.background) {
			const timeoutSeconds = params.timeout;
			const isSubagent = deps.callerType === "subagent" || (ctx ? !ctx.hasUI : false);
			const callerType = isSubagent ? "subagent" : (deps.callerType ?? "agent");
			const subagentName =
				deps.subagentName ?? (isSubagent && ctx ? ctx.sessionManager?.getSessionName?.() : undefined);
			const task = await deps.registry.run(command, effectiveCwd, {
				name: params.taskName,
				callerType,
				subagentName,
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

	// Full self-contained Bash tool call renderer (animated spinner, timer, intent headers,
	// background badges, redundant cd stripping, and expanded cwd display).
	const renderCall = (
		args: BashParams,
		theme: Parameters<NonNullable<typeof builtin.renderCall>>[1],
		context: Parameters<NonNullable<typeof builtin.renderCall>>[2],
	) => {
		return renderBashCall(
			args as BashCallArgs,
			theme,
			context as Parameters<typeof renderBashCall>[2],
			deps.renderOptions ?? {
				intentMode: (process.env.PI_BASH_INTENT_MODE as BashCallRenderOptions["intentMode"]) || "render",
			},
		);
	};

	// Full self-contained Bash tool result renderer (streaming live preview,
	// background task formatting, error results, quiet command detection, and truncation hints).
	const renderResult = (
		result: Record<string, unknown>,
		options: BashResultRenderOptions,
		theme: BashRenderTheme,
		context?: unknown,
	) => {
		return renderBashResult(
			result,
			options,
			theme,
			context as Parameters<typeof renderBashResult>[3],
		);
	};

	return {
		...builtin,
		name: "bash",
		label: "bash",
		promptSnippet: "Execute foreground shell commands synchronously",
		parameters: bashParams,
		description: amendedDescription,
		prepareArguments: (args: unknown) => normalizeBashArgs(args) as unknown,
		renderCall,
		renderResult,
		execute: ourExecute,
	} as unknown as ToolDefinition;
}

export const createForegroundBashTool = createBackgroundAwareBashTool;

export function createBackgroundTaskTool(
	cwd: string,
	deps: BashOverrideDeps,
	toolName = "background_task",
): ToolDefinition {
	depsRegistry = deps.registry;
	lastDeps = deps;
	const bgCap = Math.max(1, deps.bgTimeoutMax ?? 300);
	const fgCap = Math.max(1, deps.fgTimeoutMax ?? 60);

	const backgroundTaskParams = Type.Object(
		{
			command: Type.String({
				description:
					"The exact command line to run in the background. A leading `cd <current-directory> &&` for the current directory is dropped automatically.",
			}),
			taskName: Type.Optional(
				Type.String({
					description:
						"Optional short human-readable label for the background task (shown in the task list and notifications).",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: `Optional timeout in seconds (cap: ${bgCap}s). A timeout above this cap is rejected.`,
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Optional working directory. Defaults to the current execution directory.",
				}),
			),
			intent: Type.Optional(
				Type.String({
					description: "Optional short intent description.",
				}),
			),
			tool: Type.Optional(
				Type.String({
					description: "Optional header label.",
				}),
			),
		},
		{
			description:
				"Run a shell command as a background task at low CPU/IO priority. Returns immediately with a task ID (e.g. task-1) and log path. Do not poll.",
		},
	);

	const execute = async (
		_toolCallId: string,
		params: NormalizedBackgroundTaskArgs,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: unknown,
	) => {
		const timeoutProblem = validateTimeout(params.timeout, true, { fg: fgCap, bg: bgCap });
		if (timeoutProblem) {
			return {
				content: [{ type: "text", text: timeoutProblem }],
				isError: true,
			};
		}
		if (!params.command || params.command.trim() === "") {
			return {
				content: [{ type: "text", text: "Missing required parameter: command." }],
				isError: true,
			};
		}

		const effectiveCwd = params.cwd?.trim() ? params.cwd : cwd;
		const command = stripCdPrefix(params.command, effectiveCwd);

		const isSubagent = deps.callerType === "subagent" || (ctx ? !(ctx as any).hasUI : false);
		const callerType = isSubagent ? "subagent" : (deps.callerType ?? "agent");
		const subagentName =
			deps.subagentName ?? (isSubagent && ctx ? (ctx as any).sessionManager?.getSessionName?.() : undefined);

		const task = await deps.registry.run(command, effectiveCwd, {
			name: params.taskName,
			callerType,
			subagentName,
			timeoutSeconds: params.timeout,
		});

		return {
			content: [{ type: "text", text: formatBackgroundToolResult(task) }],
			details: task,
			isError: false,
		};
	};

	const renderCall = (
		args: NormalizedBackgroundTaskArgs,
		theme: Parameters<typeof renderBackgroundTaskCall>[1],
		context: Parameters<typeof renderBackgroundTaskCall>[2],
	) => {
		return renderBackgroundTaskCall(
			args as BackgroundTaskCallArgs,
			theme,
			context,
			deps.renderOptions,
		);
	};

	const renderResult = (
		result: Record<string, unknown>,
		options: BashResultRenderOptions,
		theme: BashRenderTheme,
		context?: unknown,
	) => {
		return renderBackgroundTaskResult(
			result,
			options,
			theme,
			context as Parameters<typeof renderBackgroundTaskResult>[3],
		);
	};

	return {
		name: toolName,
		label: toolName,
		promptSnippet: "Run long-running background tasks (dev servers, watchers, builds)",
		description: `Run a shell command as a background task at low CPU/IO priority.

Use this for long-running processes: dev servers, file watchers, test runners, builds, persistent services, or any command that should run asynchronously.

Returns immediately with a task ID (e.g. task-1) and a log file path.
DO NOT poll for completion or use sleep to wait; the system automatically notifies you when the task finishes.
To check status, view logs, or terminate a task, use \`manage_background_task\`.`,
		parameters: backgroundTaskParams,
		prepareArguments: (args: unknown) => normalizeBackgroundTaskArgs(args) as unknown,
		renderCall,
		renderResult,
		execute: execute as any,
	} as unknown as ToolDefinition;
}

export function createManageBackgroundTaskTool(
	deps: BashOverrideDeps,
	toolName = "manage_background_task",
): ToolDefinition {
	depsRegistry = deps.registry;
	lastDeps = deps;

	const manageBackgroundTaskParams = Type.Object(
		{
			action: Type.Union(
				[
					Type.Literal("list", { description: "Report all background tasks, running first." }),
					Type.Literal("status", { description: "Show one task's state plus the tail of its output (requires taskId)." }),
					Type.Literal("logs", { description: "Show recent log output for a task (requires taskId, optional lines)." }),
					Type.Literal("kill", { description: "Terminate one background task (requires taskId)." }),
					Type.Literal("input", { description: "Write text to one background task's stdin (requires taskId and input)." }),
					Type.Literal("adopt", { description: "Move the currently running foreground command into a background task." }),
				],
				{ description: "Management action to perform: list, status, logs, kill, input, adopt." },
			),
			taskId: Type.Optional(
				Type.String({ description: 'Task id such as "task-1" (required for status, logs, kill, input).' }),
			),
			input: Type.Optional(
				Type.String({ description: "Text to write to the task stdin (required for action 'input', newline appended)." }),
			),
			lines: Type.Optional(
				Type.Number({ description: "Optional maximum number of lines to return for status or logs." }),
			),
		},
		{
			description:
				"Manage background tasks: list running tasks, check status/logs, stop tasks, send stdin input, or adopt foreground command.",
		},
	);

	const execute = async (
		_toolCallId: string,
		params: NormalizedManageBackgroundTaskArgs,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const action = params.action;
		if (!action) {
			return {
				content: [{ type: "text", text: "Missing required parameter: action (list, status, logs, kill, input, adopt)." }],
				isError: true,
			};
		}

		const outcome = await runTaskAction(deps.registry, {
			action,
			taskId: params.taskId,
			input: params.input,
			lines: params.lines,
		});

		return {
			content: [{ type: "text", text: outcome.text }],
			details: outcome.details,
			isError: outcome.isError === true,
		};
	};

	const renderCall = (
		args: NormalizedManageBackgroundTaskArgs,
		theme: Parameters<typeof renderManageBackgroundTaskCall>[1],
		context: Parameters<typeof renderManageBackgroundTaskCall>[2],
	) => {
		return renderManageBackgroundTaskCall(
			args as ManageBackgroundTaskCallArgs,
			theme,
			context,
			deps.renderOptions,
		);
	};

	const renderResult = (
		result: Record<string, unknown>,
		options: BashResultRenderOptions,
		theme: BashRenderTheme,
		context?: unknown,
	) => {
		return renderManageBackgroundTaskResult(
			result,
			options,
			theme,
			context as Parameters<typeof renderManageBackgroundTaskResult>[3],
		);
	};

	return {
		name: toolName,
		label: toolName,
		promptSnippet: "Manage background tasks (list, status, logs, kill, input, adopt)",
		description: `Manage background tasks: list running tasks, inspect status/logs, stop tasks, send input to stdin, or adopt a running foreground command.

Actions:
- list: List all background tasks (running and finished).
- status: View task status and recent log output (requires taskId).
- logs: View recent log output of a task (requires taskId; optional lines).
- kill: Terminate a background task (requires taskId).
- input: Send text to the task's stdin (requires taskId and input).
- adopt: Move the currently running foreground bash command into a background task.`,
		parameters: manageBackgroundTaskParams,
		prepareArguments: (args: unknown) => normalizeManageBackgroundTaskArgs(args) as unknown,
		renderCall,
		renderResult,
		execute: execute as any,
	} as unknown as ToolDefinition;
}
