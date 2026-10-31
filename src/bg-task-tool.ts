/**
 * `bg_task` model-facing tool (PRD-003 §7.5).
 *
 * One action-parameterized tool: run / list / status / kill / input.
 * Wordings mirror agy exactly (§4.3, §7.5). All process work is delegated to
 * the TaskManagerApi registry — this module only formats results.
 */

import { Type, type Static } from "typebox";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { BgTask, TaskManagerApi } from "./types.ts";

const bgTaskSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("run"),
			Type.Literal("list"),
			Type.Literal("status"),
			Type.Literal("kill"),
			Type.Literal("input"),
		],
		{ description: "Operation to perform" },
	),
	command: Type.Optional(Type.String({ description: 'Shell command to run in the background (required for "run")' })),
	name: Type.Optional(Type.String({ description: "Optional human-readable task name" })),
	taskId: Type.Optional(Type.String({ description: 'Task id such as "task-7" (required for status/kill/input)' })),
	input: Type.Optional(Type.String({ description: 'Text to write to the task stdin (required for "input")' })),
	notificationTimeoutSeconds: Type.Optional(
		Type.Number({ description: "Send a still-running notice after this many seconds (optional)" }),
	),
});

type BgTaskParams = Static<typeof bgTaskSchema>;

/** Local wall-clock "HH:MM:SS" — kept local to this module by design (§7.5). */
function clock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `task-7  sleep 120  running  (started 10:56:57)` — running first (§7.5). */
export function formatTaskLine(task: BgTask): string {
	return `${task.id}  ${task.command}  ${task.status}  (started ${clock(task.startedAt)})`;
}

export function formatRunResult(task: BgTask): string {
	return [
		`Tool is running as a background task with task id: ${task.id}`,
		`Output: ${task.logPath}`,
		"Do not poll. You will be notified when it finishes.",
	].join("\n");
}

export interface BgTaskToolDeps {
	registry: TaskManagerApi;
	/** Log directory (kept for callers/tests; registry owns log paths). */
	logDir: string;
}

function text(value: string, isError = false) {
	return { content: [{ type: "text" as const, text: value }], details: undefined, isError };
}

export function createBgTaskTool(deps: BgTaskToolDeps): ToolDefinition {
	const { registry } = deps;

	return {
		name: "bg_task",
		label: "Background task",
		description:
			"Start long-running shell commands as background tasks and manage them. " +
			"Actions: run (start a command, returns task-N immediately), list (all tasks, running first), " +
			"status (state plus output tail), kill (terminate a task), input (write to a task stdin). " +
			"Background tasks run at lower CPU/IO priority than foreground bash commands.",
		promptSnippet: "Start long-running commands as background tasks (task-N) and manage them",
		promptGuidelines: [
			"After starting a background task, proceed with other work or end your turn — you will be woken when it completes. Never poll.",
		],
		executionMode: "parallel",
		parameters: bgTaskSchema,

		async execute(_toolCallId: string, params: BgTaskParams) {
			const { action } = params;
			if (action === "run") {
				if (!params.command || params.command.trim() === "") {
					return text("Missing required parameter: command.", true);
				}
				const task = await registry.run(params.command, process.cwd(), {
					name: params.name,
					notificationTimeoutSeconds: params.notificationTimeoutSeconds,
				});
				return text(formatRunResult(task));
			}

			if (action === "list") {
				const tasks = registry.list();
				if (tasks.length === 0) return text("No background tasks.");
				return text(tasks.map(formatTaskLine).join("\n"));
			}

			const target = params.taskId;
			if (!target) return text(`Missing required parameter: taskId (for "${action}").`, true);
			const task = registry.get(target);
			if (!task) return text(`Unknown task: ${target}.`, true);

			if (action === "status") {
				const log = await registry.logs(task.id);
				return text(`${formatTaskLine(task)}\n\n${log}`);
			}
			if (action === "kill") {
				return text(await registry.kill(task.id));
			}
			// action === "input"
			if (params.input === undefined) {
				return text(`Missing required parameter: input (for "input").`, true);
			}
			return text(registry.sendInput(task.id, params.input));
		},

		renderCall(args: BgTaskParams, theme: Theme) {
			const label = theme.fg("accent", "bg_task");
			const detail = args.action === "run" ? (args.command ?? "") : `${args.action} ${args.taskId ?? ""}`.trim();
			const line = `${label} ${theme.fg("dim", detail)}`;
			return {
				render(_width: number): string[] {
					return [line];
				},
				invalidate() {},
			} satisfies Component;
		},
	} as unknown as ToolDefinition;
}
