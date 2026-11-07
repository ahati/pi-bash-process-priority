/**
 * pi-bash-process-priority
 *
 * PRD-001: every model-issued bash command runs at a lower CPU priority.
 * PRD-003: background tasks — the extension adds the `background_task` and
 * `manage_background_task` tools and an agy-style task UI (dock below the
 * editor, status-line count, /tasks panel, Task Details, notification
 * renderer).
 *
 * docs/background-task-design-and-ui.md is the spec. Failure philosophy is
 * fail-open everywhere: priority claims and UI may degrade, execution never
 * blocks on them.
 *
 * Environment variables:
 *   PI_BASH_NICE_LEVEL     fg nice increment, clamped to 1..19 (default 10)
 *   PI_BG_NICE_LEVEL       bg nice, clamped to fgNice..19 (default 19)
 *   PI_BG_IONICE_CLASS     bg IO class 0-3 (default 3 = idle; 0 = off)
 *   PI_BG_TASK_LOG_DIR     task log dir (default <cwd>/.pi/bg-tasks)
 *   PI_BG_TASKS_MAX        finished tasks retained (default 100)
 *   PI_BG_KILL_GRACE_MS    SIGTERM→SIGKILL grace (default 3000)
 *   PI_BG_LOG_BYTES        model-visible log read cap (default 50000)
 *   PI_BG_DOCK_MAX_HEIGHT_SHARE  expanded dock height cap as a share of
 *                          terminal rows, 0.2..0.9 or "50%" (default 0.5)
 *   PI_BASH_NICE_DISABLE   set to "1" to disable all nice wrapping (PRD-001)
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { buildNiceCommand, resolveConfig, type NiceConfig } from "./src/nice.ts";
import { probeIonice, probeNice, resolveBinPath } from "./src/probe.ts";
import { resolveBgConfig, resolveLogDir } from "./src/config.ts";
import { debugLog, debugLogError, initDebugLog } from "./src/debug.ts";
import { createTaskManager } from "./src/registry.ts";
import {
	createBackgroundTaskTool,
	createManageBackgroundTaskTool,
} from "./src/bash-override.ts";
import { DockController, handleDockInput, installDock } from "./src/ui/dock.ts";
import { resolveDockMaxHeightShare } from "./src/ui/dock-layout.ts";
import { DockEditor } from "./src/dock-editor.ts";
import { formatDuration } from "./src/ui/format.ts";
import { renderBgNotification } from "./src/ui/notification.ts";
import type { BgNotificationDetails, BgTask, TaskManagerApi } from "./src/types.ts";

/** True when the value looks like a persisted BgTask details payload. */
function isBgTaskDetails(value: unknown): value is BgTask {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		v.id.startsWith("task-") &&
		typeof v.command === "string" &&
		typeof v.logPath === "string" &&
		typeof v.status === "string" &&
		["running", "completed", "failed", "killed"].includes(v.status)
	);
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** §7.6 model-facing notification body. */
function notificationXml(task: BgTask): string {
	const lines = [
		"<background-task-notification>",
		`  <task-id>${task.id}</task-id>`,
		`  <task-name>${escapeXml(task.name ?? task.command)}</task-name>`,
		`  <origin>${task.origin}</origin>`,
		`  <status>${task.status}</status>`,
	];
	if (task.exitCode !== null && task.exitCode !== undefined) lines.push(`  <exit-code>${task.exitCode}</exit-code>`);
	if (task.signal) lines.push(`  <signal>${task.signal}</signal>`);
	if (task.reason) lines.push(`  <reason>${escapeXml(task.reason)}</reason>`);
	lines.push(`  <output-file>${escapeXml(task.logPath)}</output-file>`);
	const detail = task.signal
		? `signal ${task.signal}`
		: task.exitCode !== null && task.exitCode !== undefined
			? `exit ${task.exitCode}`
			: task.status;
	lines.push(`  <summary>${escapeXml(`Background task "${task.name ?? task.command}" ${task.status} (${detail})`)}</summary>`);
	lines.push("</background-task-notification>");
	return lines.join("\n");
}

export const SHARED_TASK_MANAGER_KEY = Symbol.for("pi-bash:shared-task-manager");
export const SHARED_DOCK_COORDINATOR_KEY = Symbol.for("pi-bash:dock-coordinator");

interface SharedRegistryEntry {
	registry: TaskManagerApi;
	mainSessionId?: string;
}

export function isSubagentSession(ctx: ExtensionContext): boolean {
	if (ctx.sessionManager?.getHeader?.()?.parentSession) return true;
	const name = ctx.sessionManager?.getSessionName?.();
	if (name && /#([a-f0-9]{4,17})$/i.test(name)) return true;
	const shared = (globalThis as any)[SHARED_TASK_MANAGER_KEY] as SharedRegistryEntry | undefined;
	if (!ctx.hasUI && shared) return true;
	if (!ctx.hasUI && !ctx.sessionManager?.getSessionFile?.()) return true;
	return false;
}

export function getSubagentLabel(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager?.getSessionName?.() || undefined;
}

export default function (pi: ExtensionAPI) {
	// PRD-001 state: nice priority for foreground bash commands.
	let niceConfig: NiceConfig | undefined;
	let isSubagentRuntime = false;

	// PRD-003 session state.
	let registry: TaskManagerApi | undefined;
	let ctxRef: ExtensionContext | undefined;
	let disposeUI: (() => void) | undefined;
	let editorInstalled = false;

	// Registered once per extension runtime (not session-bound).
	pi.registerMessageRenderer("bg-task-notification", renderBgNotification);

	/** §6 — one structured entry per transition; RPC clients see entry_appended. */
	const appendTaskState = (
		kind: "spawned" | "terminal" | "still-running",
		task: BgTask,
	) => {
		try {
			pi.appendEntry("bg-task-state", { kind, task, timestamp: Date.now() });
		} catch {
			// Event emission never blocks the registry (PRD-004 FR-3).
		}
	};

	// PRD-001 hook: rewrite every model-issued bash command to run under nice.
	// Native bash tool executes the rewritten command with native rendering.
	pi.on("tool_call", (event) => {
		if (!niceConfig || event.toolName !== "bash") return;
		const command = event.input.command;
		if (typeof command !== "string") return;
		const wrapped = buildNiceCommand(command, niceConfig.level);
		if (wrapped !== null) event.input.command = wrapped;
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		niceConfig = undefined;
		registry = undefined;
		disposeUI = undefined;
		editorInstalled = false;

		isSubagentRuntime = isSubagentSession(ctx);
		const subagentName = isSubagentRuntime ? getSubagentLabel(ctx) : undefined;

		// 1. Probe nice for native foreground bash rewrite
		const resolvedNice = resolveConfig(process.env, process.platform);
		if (!resolvedNice.disabled && resolvedNice.supportedPlatform) {
			if (await probeNice(resolvedNice.level)) {
				niceConfig = resolvedNice;
			} else if (ctx.hasUI) {
				ctx.ui.notify(
					"pi-bash-process-priority: nice probe failed — commands run at normal priority this session",
					"warning",
				);
			}
		}

		// 2. Background task configuration & priority probes
		const bg = resolveBgConfig(process.env, process.platform);
		initDebugLog(resolveLogDir(bg, ctx.cwd));
		debugLog("session_start", { mode: ctx.mode, hasUI: ctx.hasUI, cwd: ctx.cwd, bgNice: bg.bgNice });

		const ioniceOk = bg.ioniceClass > 0 ? await probeIonice(bg.ioniceClass) : false;
		const warnings: string[] = [];
		if (!niceConfig && !resolvedNice.disabled) warnings.push("nice unavailable — commands run at normal priority");
		if (bg.ioniceClass > 0 && !ioniceOk) warnings.push("ionice unavailable — background IO class not applied");
		if (ctx.hasUI) for (const w of warnings) ctx.ui.notify(`pi-bash-process-priority: ${w}`, "warning");

		const bgNice = bg.bgNice;
		const ioniceClass = ioniceOk ? bg.ioniceClass : 0;
		const [niceBin, ioniceBin] = await Promise.all([
			resolveBinPath("nice"),
			bg.ioniceClass > 0 && ioniceOk ? resolveBinPath("ionice") : Promise.resolve(undefined),
		]);
		// PI_BASH_NICE_DISABLE disables all nice wrapping, background spawns included.
		const bgNiceBin = resolvedNice.disabled ? undefined : niceBin;

		const shared = (globalThis as any)[SHARED_TASK_MANAGER_KEY] as SharedRegistryEntry | undefined;
		if (isSubagentRuntime && shared) {
			debugLog("session_start: attaching subagent to shared task registry", { subagentName });
			registry = shared.registry;
		} else {
			registry = createTaskManager({
				logDir: resolveLogDir(bg, ctx.cwd),
				sessionId: ctx.sessionManager?.getSessionId?.(),
				killGraceMs: bg.killGraceMs,
				logBytes: bg.logBytes,
				maxFinished: bg.tasksMax,
				niceBin: bgNiceBin,
				ioniceBin,
				bgNice,
				ioniceClass,
				onChange: () => {
					// Dock/footer refresh themselves via registry listeners installed below.
				},
				onTransition: (kind, task) => {
					debugLog("onTransition", { kind, id: task.id });
					appendTaskState(kind, task);
				},
				onTerminal: (task) => {
					debugLog("onTerminal", task);
					appendTaskState("terminal", task);
					const details: BgNotificationDetails = {
						kind: "terminal",
						task,
						durationText: task.endedAt ? formatDuration(Math.max(0, task.endedAt - task.startedAt)) : undefined,
					};
					debugLog("sendMessage:followUp", { id: task.id, status: task.status });
					try {
						pi.sendMessage(
							{
								customType: "bg-task-notification",
								content: notificationXml(task),
								display: true,
								details,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
						debugLog("sendMessage:followUp returned", task.id);
					} catch (error) {
						debugLogError("sendMessage:followUp threw", error);
					}
				},
				onStillRunning: (task, elapsedSeconds) => {
					debugLog("onStillRunning", { id: task.id, elapsedSeconds });
					appendTaskState("still-running", task);
					const details: BgNotificationDetails = {
						kind: "still-running",
						task,
						elapsedSeconds,
						startedClock: new Date(task.startedAt).toLocaleTimeString(),
					};
					pi.sendMessage(
						{
							customType: "bg-task-notification",
							content: `Background command is still running after ${elapsedSeconds}s: ${task.command}`,
							display: true,
							details,
						},
						{ deliverAs: "followUp", triggerTurn: false },
					);
				},
			});

			if (!isSubagentRuntime) {
				(globalThis as any)[SHARED_TASK_MANAGER_KEY] = {
					registry,
					mainSessionId: ctx.sessionManager?.getSessionId?.(),
				};
			}
		}

		// Rebuild branch-aware state from prior tool results and task notifications (§7.3).
		try {
			const seen = new Map<string, BgTask>();
			for (const entry of ctx.sessionManager.getBranch()) {
				const entryAny = entry as {
					type?: string;
					customType?: string;
					data?: unknown;
					message?: { role?: string; customType?: string; details?: unknown };
				};
				if (entryAny.type === "custom") {
					const data = entryAny.data as { task?: unknown } | undefined;
					if (data && isBgTaskDetails(data.task)) {
						seen.set(data.task.id, data.task);
					} else if (isBgTaskDetails(entryAny.data)) {
						seen.set(entryAny.data.id, entryAny.data);
					}
					continue;
				}
				if (entryAny.type === "message") {
					const message = entryAny.message;
					if (!message) continue;
					if (message.role === "toolResult") {
						if (isBgTaskDetails(message.details)) {
							seen.set(message.details.id, message.details);
						} else if (
							message.details &&
							typeof message.details === "object" &&
							isBgTaskDetails((message.details as { task?: unknown }).task)
						) {
							const t = (message.details as { task: BgTask }).task;
							seen.set(t.id, t);
						}
					} else if (message.customType === "bg-task-notification") {
						const details = message.details as { task?: unknown } | undefined;
						if (details && isBgTaskDetails(details.task)) {
							seen.set(details.task.id, details.task);
						}
					}
				}
			}
			if (seen.size > 0) registry.rebuild([...seen.values()]);
		} catch {
			// Rebuild is best-effort; a fresh empty registry is fine.
		}

		// Register background_task and manage_background_task (+ aliases) as independent tools.
		try {
			const callerType: "agent" | "subagent" = isSubagentRuntime ? "subagent" : "agent";
			const toolDeps = {
				registry,
				callerType,
				subagentName,
				fgTimeoutMax: bg.fgTimeoutMax,
				bgTimeoutMax: bg.bgTimeoutMax,
			};

			pi.registerTool(createBackgroundTaskTool(ctx.cwd, toolDeps, "background_task"));
			pi.registerTool(createBackgroundTaskTool(ctx.cwd, toolDeps, "backgroundTask"));
			pi.registerTool(createManageBackgroundTaskTool(toolDeps, "manage_background_task"));
			pi.registerTool(createManageBackgroundTaskTool(toolDeps, "manageBackgroundTask"));
		} catch (error) {
			registry = undefined;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-bash-process-priority: background tools registration failed (${error instanceof Error ? error.message : String(error)})`,
					"warning",
				);
			}
			return;
		}

		// /tasks and /bg-tasks commands: expanded bottom view of all tasks,
		// capped at PI_BG_DOCK_MAX_HEIGHT_SHARE of the terminal (default 50%).
		let dockControllerRef: DockController | undefined;
		let dockRef: ReturnType<typeof installDock> | undefined;

		const handleTasksCommand = async (args: string, commandCtx: ExtensionCommandContext) => {
			if (!registry) {
				if (commandCtx.hasUI) commandCtx.ui.notify("Background tasks are not active this session.", "info");
				return;
			}
			if (commandCtx.mode !== "tui") {
				const all = registry.list();
				commandCtx.ui.notify(
					all.length === 0 ? "No background tasks." : `${all.length} tasks: ${all.map((task) => `${task.id} (${task.status})`).join(", ")}`,
					"info",
				);
				return;
			}
			if (dockControllerRef) {
				if (typeof args === "string" && args.trim()) {
					const specific = registry.get(args.trim());
					if (specific) {
						dockControllerRef.openDetail(specific);
						dockRef?.refresh();
						return;
					}
				}
				const opened = dockControllerRef.expandTasks();
				if (!opened && commandCtx.hasUI) {
					commandCtx.ui.notify("No background tasks.", "info");
				}
				dockRef?.refresh();
			}
		};

		pi.registerCommand("tasks", {
			description: "Open the background task manager UI",
			handler: handleTasksCommand,
		});

		// UI (TUI only, §7.7-§7.9).
		if (ctx.mode === "tui" && ctx.hasUI) {
			// PRD-004 v3.2: the normal pi footer is left untouched; the dock
			// is the only injected chrome — a below-editor widget that renders above the footer.
			const controller = new DockController(
				() => (registry ? registry.list().filter((task) => task.status === "running") : []),
				() => (registry ? registry.list() : []),
				// Height cap: the expanded dock never covers more than this share of
				// the terminal (default 50%). Override with PI_BG_DOCK_MAX_HEIGHT_SHARE.
				{ maxHeightShare: resolveDockMaxHeightShare(process.env.PI_BG_DOCK_MAX_HEIGHT_SHARE) },
			);
			dockControllerRef = controller;
			const dock = installDock(ctx, registry, controller, {});
			dockRef = dock;

			(globalThis as any)[SHARED_DOCK_COORDINATOR_KEY] = {
				inDock: () => controller.inDock(),
				isDetail: () => controller.isDetail(),
				isExpanded: () => controller.isExpanded(),
				hasTasks: () => controller.getTasks().length > 0,
				taskCount: () => controller.getTasks().length,
				enterDock: (fromBottom = false) => {
					const ok = controller.enterDock(fromBottom);
					if (ok) {
						(dock.getTui?.() ?? (ctx as any).ui)?.requestRender();
						const fleet = (globalThis as any)[Symbol.for("pi-subagents:fleet-coordinator")];
						fleet?.update?.();
					}
					return ok;
				},
				exitDock: () => {
					controller.exitDock();
					(dock.getTui?.() ?? (ctx as any).ui)?.requestRender();
					const fleet = (globalThis as any)[Symbol.for("pi-subagents:fleet-coordinator")];
					fleet?.update?.();
				},
			};

			const inputUnsub = ctx.ui.onTerminalInput((data) => {
				return handleDockInput(
					data,
					ctx,
					controller,
					registry,
					() => dock.getTui?.(),
					{
						onKillTask: (task: BgTask) => {
							void registry?.kill(task.id, "dock key kill");
						},
					},
				);
			});

			disposeUI = () => {
				inputUnsub();
				delete (globalThis as any)[SHARED_DOCK_COORDINATOR_KEY];
				dock.dispose();
			};
		}
	});

	pi.on("session_shutdown", async () => {
		if (isSubagentRuntime) {
			debugLog("session_shutdown: subagent session ending, preserving shared registry");
			return;
		}
		delete (globalThis as any)[SHARED_TASK_MANAGER_KEY];
		delete (globalThis as any)[SHARED_DOCK_COORDINATOR_KEY];
		disposeUI?.();
		disposeUI = undefined;
		try {
			await registry?.disposeAll("session shutdown");
		} catch {
			// Idempotent best-effort teardown.
		}
		registry = undefined;
		niceConfig = undefined;
		ctxRef = undefined;
	});
}
