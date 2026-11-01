/**
 * pi-bash-process-priority
 *
 * PRD-001: every model-issued bash command runs at a lower CPU priority.
 * PRD-003: background tasks — the extension takes over the built-in `bash`
 * tool (owning the process), adds the `bg_task` tool, a `ctrl+b` hotkey that
 * moves a running foreground command into a background task (renice + ionice
 * on adoption), and an agy-style task UI (dock below the editor, status-line
 * count, /tasks panel, Task Details, notification renderer).
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
 *   PI_BASH_NICE_DISABLE   set to "1" to disable all nice wrapping (PRD-001)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { buildNiceCommand, resolveConfig, type NiceConfig } from "./src/nice.ts";
import { probeIonice, probeNice, probeRenice } from "./src/probe.ts";
import { resolveBgConfig, resolveLogDir } from "./src/config.ts";
import { debugLog, debugLogError, initDebugLog } from "./src/debug.ts";
import { createTaskManager } from "./src/registry.ts";
import {
	createBackgroundAwareBashTool,
	getForeground,
	getSharedOperations,
	requestBackground,
	resetBashOverrideState,
} from "./src/bash-override.ts";
import { DockController, installDock } from "./src/ui/dock.ts";
import { DockEditor } from "./src/dock-editor.ts";
import { formatDuration } from "./src/ui/format.ts";
import { renderBgNotification } from "./src/ui/notification.ts";
import { buildBashIntentSystemPrompt } from "./src/ui/bash-intent.ts";
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
	// Legacy PRD-001 state: active only when PRD-003 is not.
	let legacyConfig: NiceConfig | undefined;
	let overrideActive = false;
	let isSubagentRuntime = false;

	// PRD-003 session state.
	let registry: TaskManagerApi | undefined;
	let ctxRef: ExtensionContext | undefined;
	let disposeUI: (() => void) | undefined;
	let editorInstalled = false;

	// Registered once per extension runtime (not session-bound).
	pi.registerMessageRenderer("bg-task-notification", renderBgNotification);

	// PRD-004 §7 — priority transport: the hook's entire body routes RPC/!
	// shell executions into the masked tool's operations (fg nice). No control
	// logic, no parsing (G4). Inert until the override activates this session.
	pi.on("user_bash", () => {
		const operations = getSharedOperations();
		return operations ? { operations } : undefined;
	});

	// Opt-in: teach the bash intent-comment convention so the model supplies it
	// without the user having to ask (when PI_BASH_INTENT_MODE=render-and-instruct).
	pi.on("before_agent_start", async (event) => {
		const mode = process.env.PI_BASH_INTENT_MODE;
		if (mode === "render-and-instruct") {
			const prompt = buildBashIntentSystemPrompt(event.systemPrompt);
			if (prompt !== undefined) {
				return { systemPrompt: prompt };
			}
		}
	});

	/** §6 — one structured entry per transition; RPC clients see entry_appended. */
	const appendTaskState = (
		kind: "spawned" | "adopted" | "terminal" | "still-running",
		task: BgTask,
	) => {
		try {
			pi.appendEntry("bg-task-state", { kind, task, timestamp: Date.now() });
		} catch {
			// Event emission never blocks the registry (PRD-004 FR-3).
		}
	};

	// Legacy PRD-001 rewrite: only while the override is NOT active.
	pi.on("tool_call", (event) => {
		if (overrideActive) return;
		if (!legacyConfig || event.toolName !== "bash") return;
		const command = event.input.command;
		if (typeof command !== "string") return;
		const wrapped = buildNiceCommand(command, legacyConfig.level);
		if (wrapped !== null) event.input.command = wrapped;
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		overrideActive = false;
		legacyConfig = undefined;
		registry = undefined;
		disposeUI = undefined;
		editorInstalled = false;
		resetBashOverrideState();

		isSubagentRuntime = isSubagentSession(ctx);
		const subagentName = isSubagentRuntime ? getSubagentLabel(ctx) : undefined;

		const bg = resolveBgConfig(process.env, process.platform);
		initDebugLog(resolveLogDir(bg, ctx.cwd));
		debugLog("session_start", { mode: ctx.mode, hasUI: ctx.hasUI, cwd: ctx.cwd, bgNice: bg.bgNice });

		// Unsupported platform → exact PRD-001 behavior.
		if (!bg.supportedPlatform) {
			legacyConfig = resolveConfig(process.env, process.platform);
			if (legacyConfig.disabled || !legacyConfig.supportedPlatform) return;
			if (!(await probeNice(legacyConfig.level))) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"pi-bash-process-priority: nice probe failed — commands run at normal priority this session",
						"warning",
					);
				}
				return;
			}
			return;
		}

		// PRD-003 path: probe priorities once, fail-open per claim (§7.4).
		const [niceOk, reniceOk, ioniceOk] = await Promise.all([
			probeNice(bg.fgNice),
			probeRenice(bg.bgNice),
			bg.ioniceClass > 0 ? probeIonice(bg.ioniceClass) : Promise.resolve(false),
		]);
		const warnings: string[] = [];
		if (!niceOk) warnings.push("nice unavailable — commands run at normal priority");
		if (!reniceOk) warnings.push("renice unavailable — ctrl+b adoption keeps the current nice level");
		if (bg.ioniceClass > 0 && !ioniceOk) warnings.push("ionice unavailable — background IO class not applied");
		if (ctx.hasUI) for (const w of warnings) ctx.ui.notify(`pi-bash-process-priority: ${w}`, "warning");

		const fgNice = niceOk ? bg.fgNice : 0;
		const bgNice = niceOk ? bg.bgNice : 0;
		const ioniceClass = niceOk && ioniceOk ? bg.ioniceClass : 0;

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

		// Take over the built-in bash tool + register bg_task (§7.1, §7.5).
		try {
			pi.registerTool(
				createBackgroundAwareBashTool(ctx.cwd, {
					registry,
					fgNice,
					callerType: isSubagentRuntime ? "subagent" : "agent",
					subagentName,
					logBytes: bg.logBytes,
					killGraceMs: bg.killGraceMs,
					fgTimeoutMax: bg.fgTimeoutMax,
					bgTimeoutMax: bg.bgTimeoutMax,
				}),
			);
			overrideActive = true;
		} catch (error) {
			// Fail back to the PRD-001 hook path entirely.
			resetBashOverrideState();
			registry = undefined;
			legacyConfig = resolveConfig(process.env, process.platform);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-bash-process-priority: bash override failed (${error instanceof Error ? error.message : String(error)}) — PRD-001 rewrite active`,
					"warning",
				);
			}
			return;
		}

		// Adoption hotkey (§7.2). Default ctrl+h — the only ctrl-letter not
		// bound by pi's defaults (ctrl+b is tui.editor.cursorLeft; ctrl+t is
		// app.thinking.toggle; ctrl+y is yank). Opt back into ctrl+b with
		// PI_BG_ADOPT_KEY=ctrl+b if you accept shadowing cursor-left.
		const adoptKeyRaw = (process.env.PI_BG_ADOPT_KEY || "ctrl+h").toLowerCase().trim();
		// Light guard: accept modifier+key strings pi's KeyId union understands.
		const adoptKey = /^(ctrl\+|alt\+|shift\+|super\+)*([a-z0-9]|f[1-9]|f1[0-2]|[=[\\\;'/.,`\-])$/.test(adoptKeyRaw)
			? adoptKeyRaw
			: "ctrl+h";
		pi.registerShortcut(adoptKey as KeyId, {
			description: "Move the running foreground bash command to a background task",
			handler: () => {
				if (!registry) return;
				const foreground = getForeground();
				if (!foreground) return;
				requestBackground(foreground.toolCallId);
			},
		});

		// UI (TUI only, §7.7-§7.9).
		if (ctx.mode === "tui" && ctx.hasUI) {
			// PRD-004 v3.2: the normal pi footer is left untouched; the dock
			// is the only injected chrome — a below-editor widget that renders above the footer.
			const controller = new DockController(() => (registry ? registry.list().filter((task) => task.status === "running") : []));
			let dockEditorRef: DockEditor | undefined;
			const dock = installDock(ctx, registry, controller, {
				// The bottom rule reuses the live editor's border color so the
				// dock reads as part of the editor frame.
				borderColor: (text) => dockEditorRef?.borderColor?.(text) ?? text,
				getTui: () => dockEditorRef?.getTui?.(),
			});
			const prevEditor = ctx.ui.getEditorComponent();
			if (!prevEditor) {
				ctx.ui.setEditorComponent((tui, theme, keybindings) => {
					// embedWorkingStatus keeps pi's "⎇ Working" indicator inside the
					// editor's top border (native behavior); without it pi renders it
					// as a separate line above the input.
					const editor = new DockEditor(tui, theme, keybindings, controller, { embedWorkingStatus: true });
					dockEditorRef = editor;
					editor.onOpenTask = (_task: BgTask) => {
						// Detail view opens in-place below the editor without duplicate dividers
					};
					editor.onKillTask = (task: BgTask) => {
						void registry?.kill(task.id, "dock key kill");
					};
					return editor;
				});
				editorInstalled = true;
			} else if (ctx.hasUI) {
				debugLog("editor install skipped: another extension owns the editor component");
				ctx.ui.notify("pi-bash-process-priority: another extension owns the editor — dock selection disabled", "info");
			}
			disposeUI = () => {
				dock.dispose();
				if (editorInstalled) ctx.ui.setEditorComponent(undefined);
				editorInstalled = false;
			};
		}
	});

	pi.on("session_shutdown", async () => {
		if (isSubagentRuntime) {
			debugLog("session_shutdown: subagent session ending, preserving shared registry");
			return;
		}
		delete (globalThis as any)[SHARED_TASK_MANAGER_KEY];
		disposeUI?.();
		disposeUI = undefined;
		try {
			await registry?.disposeAll("session shutdown");
		} catch {
			// Idempotent best-effort teardown.
		}
		registry = undefined;
		resetBashOverrideState();
		overrideActive = false;
		legacyConfig = undefined;
		ctxRef = undefined;
	});
}
