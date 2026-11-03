/**
 * Background-task tool definitions.
 *
 * The built-in `bash` tool is no longer overridden or rendered by this
 * extension; `index.ts` re-nices bash commands through a `tool_call` hook.
 * This module owns the `background_task` and `manage_background_task` tools.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BgTask, TaskManagerApi } from "./types.ts";
import {
	renderBackgroundTaskCall,
	renderManageBackgroundTaskCall,
	type BackgroundTaskCallArgs,
	type ManageBackgroundTaskCallArgs,
} from "./ui/bash-display.ts";
import {
	renderBackgroundTaskResult,
	renderManageBackgroundTaskResult,
	type BashRenderTheme,
	type BashResultRenderOptions,
} from "./ui/bash-result.ts";

export interface BashOverrideDeps {
	registry: TaskManagerApi;
	/** Whether this tool instance is configured for a subagent or main agent session. */
	callerType?: "agent" | "subagent";
	/** Optional subagent name/id. */
	subagentName?: string;
	/** Foreground timeout cap in seconds (§8 PI_BASH_FG_TIMEOUT_MAX). Default 60. */
	fgTimeoutMax?: number;
	/** Background timeout cap in seconds (§8 PI_BASH_TIMEOUT_BG_MAX). Default 300. */
	bgTimeoutMax?: number;
}

export type TaskAction = "list" | "status" | "logs" | "kill" | "input";
export const VALID_ACTIONS = new Set<TaskAction>(["list", "status", "logs", "kill", "input"]);

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

export function isNilOrEmpty(val: unknown): boolean {
	if (val === null || val === undefined) return true;
	if (typeof val === "string") {
		const t = val.trim().toLowerCase();
		return t === "" || t === "null" || t === "undefined";
	}
	return false;
}

export function parseOptionalNumber(val: unknown): number | undefined {
	if (isNilOrEmpty(val)) return undefined;
	if (typeof val === "number" && Number.isFinite(val)) return val;
	if (typeof val === "string") {
		const parsed = Number(val.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * Background-task management verbs. Pure delegation to the registry — no
 * process work here.
 */
export async function runTaskAction(
	registry: TaskManagerApi,
	params: TaskActionParams,
): Promise<TaskActionResult> {
	const rawAction = !isNilOrEmpty(params.action)
		? params.action
		: !isNilOrEmpty(params.taskAction)
			? params.taskAction
			: undefined;
	const taskAction = typeof rawAction === "string" ? (rawAction.trim().toLowerCase() as TaskAction) : undefined;
	if (!taskAction || !VALID_ACTIONS.has(taskAction)) {
		return { text: "Missing required parameter: action (list, status, logs, kill, input).", isError: true };
	}

	if (taskAction === "list") {
		const tasks = registry.list();
		if (tasks.length === 0) return { text: "No background tasks." };
		return { text: tasks.map(taskLine).join("\n") };
	}

	const target = !isNilOrEmpty(params.taskId) && typeof params.taskId === "string" ? params.taskId.trim() : undefined;
	if (!target) return { text: `Missing required parameter: taskId (for "${taskAction}").`, isError: true };
	const task = registry.get(target);
	if (!task) return { text: `Unknown task: ${target}.`, isError: true };

	if (taskAction === "status" || taskAction === "logs") {
		let log = await registry.logs(task.id);
		const lines = parseOptionalNumber(params.lines);
		if (lines && lines > 0) {
			const split = log.split("\n");
			if (split.length > lines) {
				log = split.slice(-lines).join("\n");
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
	if (
		params.input === undefined ||
		params.input === null ||
		(typeof params.input === "string" &&
			(params.input.trim().toLowerCase() === "null" || params.input.trim().toLowerCase() === "undefined"))
	) {
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
 * Immediate timeout validation (PRD-004 §4.1): a timeout above the mode's cap
 * is REJECTED with an actionable error — never silently clamped (a silent
 * clamp makes the model believe it has 999s when it has 60s).
 */
export function validateTimeout(
	timeout: unknown,
	background: boolean,
	caps: { fg: number; bg: number },
): string | undefined {
	if (isNilOrEmpty(timeout)) return undefined;
	const num = typeof timeout === "number" ? timeout : Number(timeout);
	if (!Number.isFinite(num)) {
		return "Invalid timeout: must be a finite number of seconds.";
	}
	const cap = background ? caps.bg : caps.fg;
	if (num > cap) {
		return (
			background
				? `Timeout ${num}s exceeds the background cap of ${cap}s (PI_BASH_TIMEOUT_BG_MAX).`
				: `Timeout ${num}s exceeds the foreground cap of ${cap}s (PI_BASH_FG_TIMEOUT_MAX). For long-running work, set background=true (background cap: ${caps.bg}s) instead.`
		);
	}
	if (num < 1) {
		return `Timeout must be at least 1 second.`;
	}
	return undefined;
}

export interface NormalizedBackgroundTaskArgs {
	command?: string;
	taskName?: string;
	timeout?: number;
	cwd?: string;
}

export function normalizeBackgroundTaskArgs(raw: unknown): NormalizedBackgroundTaskArgs {
	const args = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const out: NormalizedBackgroundTaskArgs = {};

	for (const key of ["command", "taskName", "cwd"] as const) {
		const val = args[key];
		if (typeof val === "string" && !isNilOrEmpty(val)) {
			out[key] = val;
		}
	}

	const timeout = parseOptionalNumber(args.timeout);
	if (timeout !== undefined) {
		out.timeout = timeout;
	}

	return out;
}

export interface NormalizedManageBackgroundTaskArgs {
	action?: TaskAction;
	taskId?: string;
	input?: string;
	lines?: number;
}

export function normalizeManageBackgroundTaskArgs(raw: unknown): NormalizedManageBackgroundTaskArgs {
	const args = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const out: NormalizedManageBackgroundTaskArgs = {};

	const actionRaw =
		!isNilOrEmpty(args.action) && typeof args.action === "string"
			? args.action.trim().toLowerCase()
			: !isNilOrEmpty(args.taskAction) && typeof args.taskAction === "string"
				? args.taskAction.trim().toLowerCase()
				: undefined;
	if (actionRaw && VALID_ACTIONS.has(actionRaw as TaskAction)) {
		out.action = actionRaw as TaskAction;
	}

	for (const key of ["taskId", "input"] as const) {
		const val = args[key];
		if (typeof val === "string" && !isNilOrEmpty(val)) {
			out[key] = val;
		}
	}

	const lines = parseOptionalNumber(args.lines);
	if (lines !== undefined) {
		out.lines = lines;
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

export function createBackgroundTaskTool(
	cwd: string,
	deps: BashOverrideDeps,
	toolName = "background_task",
): ToolDefinition {
	const bgCap = Math.max(1, deps.bgTimeoutMax ?? 300);
	const fgCap = Math.max(1, deps.fgTimeoutMax ?? 60);

	const backgroundTaskParams = Type.Object(
		{
			command: Type.String({
				description:
					"The exact command line to run in the background. A leading `cd <current-directory> &&` for the current directory is dropped automatically.",
			}),
			taskName: Type.Optional(
				Type.Union([
					Type.String(),
					Type.Null(),
				], {
					description:
						"Optional short human-readable label for the background task (shown in the task list and notifications).",
				}),
			),
			timeout: Type.Optional(
				Type.Union([
					Type.Number(),
					Type.Null(),
					Type.String(),
				], {
					description: `Optional timeout in seconds (cap: ${bgCap}s). A timeout above this cap is rejected.`,
				}),
			),
			cwd: Type.Optional(
				Type.Union([
					Type.String(),
					Type.Null(),
				], {
					description: "Optional working directory. Defaults to the current execution directory.",
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
		const effectiveTimeout = parseOptionalNumber(params?.timeout);
		const timeoutProblem = validateTimeout(effectiveTimeout, true, { fg: fgCap, bg: bgCap });
		if (timeoutProblem) {
			return {
				content: [{ type: "text", text: timeoutProblem }],
				isError: true,
			};
		}
		if (isNilOrEmpty(params?.command)) {
			return {
				content: [{ type: "text", text: "Missing required parameter: command." }],
				isError: true,
			};
		}

		const rawCwd = !isNilOrEmpty(params.cwd) && typeof params.cwd === "string" ? params.cwd.trim() : undefined;
		const effectiveCwd = rawCwd && rawCwd !== "" ? rawCwd : cwd;
		const command = stripCdPrefix(String(params.command), effectiveCwd);

		const isSubagent = deps.callerType === "subagent" || (ctx ? !(ctx as any).hasUI : false);
		const callerType = isSubagent ? "subagent" : (deps.callerType ?? "agent");
		const subagentName =
			deps.subagentName ?? (isSubagent && ctx ? (ctx as any).sessionManager?.getSessionName?.() : undefined);

		const taskName = !isNilOrEmpty(params.taskName) && typeof params.taskName === "string" ? params.taskName.trim() : undefined;

		const task = await deps.registry.run(command, effectiveCwd, {
			name: taskName,
			callerType,
			subagentName,
			timeoutSeconds: effectiveTimeout,
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
		label: "BackgroundTask",
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
	const manageBackgroundTaskParams = Type.Object(
		{
			action: Type.Union(
				[
					Type.Literal("list", { description: "Report all background tasks, running first." }),
					Type.Literal("status", { description: "Show one task's state plus the tail of its output (requires taskId)." }),
					Type.Literal("logs", { description: "Show recent log output for a task (requires taskId, optional lines)." }),
					Type.Literal("kill", { description: "Terminate one background task (requires taskId)." }),
					Type.Literal("input", { description: "Write text to one background task's stdin (requires taskId and input)." }),
				],
				{ description: "Management action to perform: list, status, logs, kill, input." },
			),
			taskId: Type.Optional(
				Type.Union([
					Type.String(),
					Type.Null(),
				], { description: 'Task id such as "task-1" (required for status, logs, kill, input).' }),
			),
			input: Type.Optional(
				Type.Union([
					Type.String(),
					Type.Null(),
				], { description: "Text to write to the task stdin (required for action 'input', newline appended)." }),
			),
			lines: Type.Optional(
				Type.Union([
					Type.Number(),
					Type.Null(),
					Type.String(),
				], { description: "Optional maximum number of lines to return for status or logs." }),
			),
		},
		{
			description:
				"Manage background tasks: list running tasks, check status/logs, stop tasks, or send stdin input.",
		},
	);

	const execute = async (
		_toolCallId: string,
		params: NormalizedManageBackgroundTaskArgs,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const rawAction = !isNilOrEmpty(params?.action)
			? params.action
			: !isNilOrEmpty((params as any)?.taskAction)
				? (params as any).taskAction
				: undefined;
		const action = typeof rawAction === "string" ? rawAction.trim().toLowerCase() : undefined;
		if (!action || !VALID_ACTIONS.has(action as TaskAction)) {
			return {
				content: [{ type: "text", text: "Missing required parameter: action (list, status, logs, kill, input)." }],
				isError: true,
			};
		}

		const taskId = !isNilOrEmpty(params.taskId) && typeof params.taskId === "string" ? params.taskId.trim() : undefined;
		const input = isNilOrEmpty(params.input) ? undefined : typeof params.input === "string" ? params.input : String(params.input);
		const lines = parseOptionalNumber(params.lines);

		const outcome = await runTaskAction(deps.registry, {
			action: action as TaskAction,
			taskId,
			input,
			lines,
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
		promptSnippet: "Manage background tasks (list, status, logs, kill, input)",
		description: `Manage background tasks: list running tasks, inspect status/logs, stop tasks, or send input to stdin.

Actions:
- list: List all background tasks (running and finished).
- status: View task status and recent log output (requires taskId).
- logs: View recent log output of a task (requires taskId; optional lines).
- kill: Terminate a background task (requires taskId).
- input: Send text to the task's stdin (requires taskId and input).`,
		parameters: manageBackgroundTaskParams,
		prepareArguments: (args: unknown) => normalizeManageBackgroundTaskArgs(args) as unknown,
		renderCall,
		renderResult,
		execute: execute as any,
	} as unknown as ToolDefinition;
}
