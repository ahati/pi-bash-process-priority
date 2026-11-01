/**
 * Unified Background Tasks Dock & Master-Detail UI.
 *
 * Implements:
 * 1. Compact 3-row clamped dock below editor for active running tasks.
 * 2. Unified Master-Detail screen for /tasks and task inspection:
 *    - Top: Master list of tasks with completion markers (✓, ●, ✗), duration, and task ID.
 *    - Bottom: Live Task Details group (Command, Status, Type, Started, Cwd, Log)
 *      and live scrollable Output tail for whichever task is currently selected.
 * 3. Reactive selection tracking: moving the `>` cursor (↑/↓ or mouse click)
 *    immediately updates the details, Cwd, Log, and Output tail in real time.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { BgTask, TaskManagerApi } from "../types.ts";
import {
	dockRow,
	formatCleanTaskRow,
	formatHeaderLine,
	formatOutputStatusLine,
	RULE_CHAR,
	taskMetadataLines,
} from "./format.ts";
import { boundedRead, DETAIL_TAIL_BYTES, toOutputLines } from "../log-reader.ts";
import { debugLog } from "../debug.ts";
import { disableTerminalMouse, enableTerminalMouse, type WritableTerminalHost } from "./terminal-mouse.ts";

export const DOCK_WIDGET_KEY = "bg-tasks";
export const MAX_DOCK_VISIBLE = 3;

export interface DockOptions {
	/** Color function for the dock's divider rule. */
	borderColor?: (text: string) => string;
	/** Fallback accessor for the TUI instance if capturedTui is not yet set. */
	getTui?: () => TUI | undefined;
}

export class DockController {
	private readonly getRunningTasks: () => BgTask[];
	private readonly getAllTasks: () => BgTask[];
	private index = 0;
	private listOffset = 0;
	private active = false;
	private expanded = false;
	private view: "list" | "detail" = "list";
	private detailTask: BgTask | undefined;

	// Output log scroll state
	private logScroll = 0;
	private logFollow = true;
	private logMaxScroll = 0;

	constructor(getRunningTasks: () => BgTask[], getAllTasks?: () => BgTask[]) {
		this.getRunningTasks = getRunningTasks;
		this.getAllTasks = getAllTasks ?? getRunningTasks;
	}

	getTasks(): BgTask[] {
		return this.isExpanded() ? this.getAllTasks() : this.getRunningTasks();
	}

	getAllTasksList(): BgTask[] {
		return this.getAllTasks();
	}

	isExpanded(): boolean {
		return this.expanded || this.view === "detail";
	}

	expandTasks(taskId?: string): boolean {
		const all = this.getAllTasks();
		if (all.length === 0) {
			return false;
		}
		this.expanded = true;
		this.active = true;
		this.view = "list";
		this.detailTask = undefined;

		if (taskId) {
			const idx = all.findIndex((t) => t.id === taskId);
			if (idx >= 0) {
				this.index = idx;
			} else {
				this.index = 0;
			}
		} else if (this.index >= all.length) {
			this.index = 0;
		}

		this.logScroll = 0;
		this.logFollow = true;
		this.reconcile();
		return true;
	}

	collapseTasks(): void {
		this.expanded = false;
		this.view = "list";
		this.detailTask = undefined;
		this.reconcile();
	}

	/** Detail view and expanded view are unified into the master-detail screen. */
	openDetail(task?: BgTask): void {
		const all = this.getAllTasks();
		const t = task ?? this.selected() ?? all[0];
		if (!t) return;
		this.active = true;
		this.view = "detail";
		this.detailTask = t;
		const idx = all.findIndex((item) => item.id === t.id);
		if (idx >= 0) {
			this.index = idx;
		}
		this.logScroll = 0;
		this.logFollow = false;
	}

	closeDetail(): void {
		this.view = "list";
		this.expanded = false;
		this.detailTask = undefined;
		this.logScroll = 0;
		this.logFollow = false;
		this.reconcile();
	}

	isDetail(): boolean {
		return this.view === "detail";
	}

	getDetailTask(): BgTask | undefined {
		if (this.view === "detail" && this.detailTask) {
			return this.detailTask;
		}
		const tasks = this.getTasks();
		if (tasks.length === 0) return undefined;
		const idx = Math.max(0, Math.min(tasks.length - 1, this.index));
		return tasks[idx];
	}

	selected(): BgTask | undefined {
		if (!this.active && !this.isExpanded()) return undefined;
		const tasks = this.getTasks();
		if (tasks.length === 0) return undefined;
		const idx = Math.max(0, Math.min(tasks.length - 1, this.index));
		return tasks[idx];
	}

	selectedIndex(): number {
		return this.active || this.isExpanded() ? this.index : -1;
	}

	getMaxVisible(termHeight?: number): number {
		if (!this.isExpanded()) {
			return MAX_DOCK_VISIBLE;
		}
		const h = termHeight ?? (typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : 24);
		return Math.max(3, Math.floor(h * 0.4));
	}

	enterDock(): boolean {
		if (this.getTasks().length === 0 && !this.detailTask) {
			this.active = false;
			this.index = 0;
			this.listOffset = 0;
			return false;
		}
		this.active = true;
		return true;
	}

	exitDock(): void {
		this.active = false;
		if (this.view !== "detail") {
			this.expanded = false;
		}
	}

	inDock(): boolean {
		return this.active;
	}

	move(delta: number, termHeight?: number): void {
		const tasks = this.getTasks();
		const count = tasks.length;
		if (count === 0) {
			this.exitDock();
			return;
		}
		const prevIndex = this.index;
		const maxVisible = this.getMaxVisible(termHeight);
		this.index = Math.max(0, Math.min(count - 1, this.index + delta));

		if (this.index < this.listOffset) {
			this.listOffset = this.index;
		} else if (this.index >= this.listOffset + maxVisible) {
			this.listOffset = this.index - maxVisible + 1;
		}

		if (this.index !== prevIndex) {
			this.detailTask = tasks[this.index];
			this.logScroll = 0;
			this.logFollow = true;
		}
	}

	scrollList(delta: number, termHeight?: number): void {
		const count = this.getTasks().length;
		const maxVisible = this.getMaxVisible(termHeight);
		if (count <= maxVisible) return;
		const maxOffset = Math.max(0, count - maxVisible);
		this.listOffset = Math.max(0, Math.min(maxOffset, this.listOffset + delta));

		if (this.index < this.listOffset) {
			this.index = this.listOffset;
		} else if (this.index >= this.listOffset + maxVisible) {
			this.index = this.listOffset + maxVisible - 1;
		}
	}

	getListOffset(termHeight?: number): number {
		const count = this.getTasks().length;
		const maxVisible = this.getMaxVisible(termHeight);
		const maxOffset = Math.max(0, count - maxVisible);
		return Math.max(0, Math.min(maxOffset, this.listOffset));
	}

	scrollDetail(delta: number): void {
		this.logFollow = false;
		this.logScroll = Math.max(0, Math.min(this.logMaxScroll, this.logScroll + delta));
		if (this.logScroll >= this.logMaxScroll) {
			this.logFollow = true;
		}
	}

	scrollDetailTop(): void {
		this.logFollow = false;
		this.logScroll = 0;
	}

	scrollDetailBottom(): void {
		this.logFollow = true;
		this.logScroll = this.logMaxScroll;
	}

	setMaxScroll(max: number): void {
		this.logMaxScroll = Math.max(0, max);
	}

	getDetailScroll(): { scroll: number; follow: boolean } {
		return { scroll: this.logScroll, follow: this.logFollow };
	}

	reconcile(termHeight?: number): void {
		if (this.view === "detail") {
			if (this.detailTask) {
				const updated = this.getAllTasks().find((t) => t.id === this.detailTask?.id);
				if (updated) this.detailTask = updated;
			}
			return;
		}
		const count = this.getTasks().length;
		if (count === 0) {
			this.active = false;
			this.expanded = false;
			this.index = 0;
			this.listOffset = 0;
		} else {
			if (this.index >= count) this.index = count - 1;
			const maxVisible = this.getMaxVisible(termHeight);
			const maxOffset = Math.max(0, count - maxVisible);
			if (this.listOffset > maxOffset) this.listOffset = maxOffset;
		}
	}
}

interface DockWidget {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
	handleMouse?(event: TuiMouseEvent): { handled: boolean } | undefined;
}

export function installDock(
	ctx: ExtensionContext,
	registry: TaskManagerApi,
	controller: DockController,
	options: DockOptions = {},
): { dispose(): void; refresh(): void; setBorderColor(fn: (text: string) => string): void } {
	let ticker: ReturnType<typeof setInterval> | undefined;
	let borderColorFn: ((text: string) => string) | undefined = options.borderColor;
	let disposed = false;
	let capturedTui: { requestRender(): void } | undefined;

	let cachedDetailTaskId: string | undefined;
	let cachedOutputLines: string[] = [];
	let cachedBytesRead = 0;
	let cachedTotalBytes = 0;
	let cachedTruncated = false;
	let refreshing = false;

	async function refreshDockTail(task: BgTask): Promise<void> {
		if (refreshing || !task.logPath || disposed) return;
		refreshing = true;
		try {
			const read = await boundedRead(task.logPath, DETAIL_TAIL_BYTES, true);
			cachedOutputLines = toOutputLines(read.content);
			cachedBytesRead = read.bytesRead;
			cachedTotalBytes = read.totalBytes;
			cachedTruncated = read.truncated;
			cachedDetailTaskId = task.id;
		} catch {
			cachedOutputLines = [];
		} finally {
			refreshing = false;
			if (!disposed) (capturedTui ?? options.getTui?.())?.requestRender();
		}
	}

	const unsubscribe = registry.onChange(() => {
		const wasInDock = controller.inDock();
		controller.reconcile();
		if (wasInDock && !controller.inDock()) {
			debugLog("dock: auto-exited dock mode (no running rows left) — input restored");
		}
		render();
		(capturedTui ?? options.getTui?.())?.requestRender();
	});

	function render(): void {
		if (disposed) return;
		const all = controller.getTasks();
		if (all.length === 0 && !controller.isExpanded()) {
			stopTicker();
			ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}
		ctx.ui.setWidget(DOCK_WIDGET_KEY, factory, { placement: "belowEditor" });
		startTicker();
		(capturedTui ?? options.getTui?.())?.requestRender();
	}

	const factory = (tui: TUI, theme: Theme): DockWidget => {
		capturedTui = tui;
		const component: DockWidget = {
			invalidate() {},
			render(width: number): string[] {
				if (disposed) return [];

				const all = controller.getTasks();
				if (all.length === 0) return [];

				const now = Date.now();
				const count = all.length;
				const termHeight =
					tui?.terminal?.rows ??
					(typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : 24);

				// ===================================================================
				// Unified Master-Detail View (/tasks or detail)
				// ===================================================================
				if (controller.isExpanded()) {
					const maxVisible = controller.getMaxVisible(termHeight);
					const visibleCount = Math.min(count, maxVisible);
					const offset = controller.getListOffset(termHeight);
					const visibleTasks = all.slice(offset, offset + visibleCount);
					const selectedIndex = controller.selectedIndex();

					const lines: string[] = [];

					// 1. Header rule: ── Background Tasks ──────────────────────────
					lines.push(formatHeaderLine("Background Tasks", width, theme));

					// 2. Subtitle: N tasks  current session branch
					lines.push(
						theme
							? theme.fg("dim", `${count} task${count === 1 ? "" : "s"}  current session branch`)
							: `${count} task${count === 1 ? "" : "s"}  current session branch`,
					);
					lines.push("");

					// 3. Master List of Tasks with completion markers
					for (let i = 0; i < visibleTasks.length; i++) {
						const taskIndex = offset + i;
						const task = visibleTasks[i];
						const isSelected = taskIndex === selectedIndex;
						lines.push(formatCleanTaskRow(task, isSelected, width, now, theme));
					}

					// Pagination hint if tasks exceed visible window
					if (count > visibleCount) {
						lines.push(
							theme
								? theme.fg("dim", `  (${offset + 1}–${offset + visibleCount} of ${count} · scroll with mouse/arrows)`)
								: `  (${offset + 1}–${offset + visibleCount} of ${count} · scroll with mouse/arrows)`,
						);
					}

					lines.push("");

					// Active selected task for details and output
					const activeTask =
						selectedIndex >= 0 && selectedIndex < all.length ? all[selectedIndex] : visibleTasks[0];

					if (activeTask) {
						// Trigger log tail refresh if selected task changed
						if (cachedDetailTaskId !== activeTask.id) {
							void refreshDockTail(activeTask);
						}

						// 4. Task Details Section
						lines.push(theme?.bold ? theme.bold("Task Details") : "Task Details");
						lines.push(
							...taskMetadataLines(activeTask, width, now, {
								theme,
								showMetadata: false,
							}),
						);

						// 5. Divider Rule
						const rule = (borderColorFn ?? ((t: string) => theme.fg("dim", t)))(
							RULE_CHAR.repeat(Math.max(1, width)),
						);
						lines.push(rule);

						// 6. Output Header
						lines.push("Output");
						lines.push("");

						// 7. Output Tail
						const outputLines =
							cachedDetailTaskId === activeTask.id ? cachedOutputLines : [];
						const maxOutputHeight = Math.max(4, Math.min(8, Math.floor(termHeight * 0.25)));

						const totalLines = outputLines.length;
						const maxScroll = Math.max(0, totalLines - maxOutputHeight);
						controller.setMaxScroll(maxScroll);

						const scrollInfo = controller.getDetailScroll();
						let startLine = 0;
						if (scrollInfo.follow || totalLines <= maxOutputHeight) {
							startLine = Math.max(0, totalLines - maxOutputHeight);
						} else {
							startLine = Math.min(scrollInfo.scroll, maxScroll);
						}

						const slice = outputLines.slice(startLine, startLine + maxOutputHeight);
						if (slice.length === 0) {
							lines.push(theme.fg("dim", "(no output yet)"));
						} else {
							for (const line of slice) {
								lines.push(truncateToWidth(line, width));
							}
						}

						lines.push("");

						// 8. Interactive Hint Line
						const statusText = formatOutputStatusLine({
							follow: scrollInfo.follow,
							totalLines,
							scrollTop: startLine,
							visibleLines: maxOutputHeight,
							bytesRead: cachedBytesRead,
							totalBytes: cachedTotalBytes,
							truncated: cachedTruncated,
						});
						lines.push(
							theme.fg(
								"dim",
								`${statusText} · ↑/↓ select · PgUp/PgDn scroll log · k kill · esc close`,
							),
						);
					}

					return lines;
				}

				// ===================================================================
				// Compact Dock View (collapsed mode for running tasks)
				// ===================================================================
				const runningTasks = all.filter((t) => t.status === "running");
				if (runningTasks.length === 0) return [];

				const maxVisible = MAX_DOCK_VISIBLE;
				const visibleCount = Math.min(runningTasks.length, maxVisible);
				const offset = controller.getListOffset(termHeight);
				const visibleRunning = runningTasks.slice(offset, offset + visibleCount);
				const selectedIndex = controller.selectedIndex();

				const lines: string[] = [];
				for (let i = 0; i < visibleRunning.length; i++) {
					const taskIndex = offset + i;
					const task = visibleRunning[i];
					const isSelected = controller.inDock() && taskIndex === selectedIndex;
					lines.push(dockRow(task, isSelected, width, now, theme));
				}

				if (runningTasks.length > maxVisible) {
					const hint = `  (${offset + 1}–${offset + visibleCount} of ${runningTasks.length} · scroll with mouse/arrows)`;
					lines.push(theme.fg("dim", hint));
				}

				const rule = (borderColorFn ?? ((t: string) => theme.fg("dim", t)))(
					RULE_CHAR.repeat(Math.max(1, width)),
				);
				lines.push(rule);
				return lines;
			},

			handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
				if (event.type === "wheel") {
					const delta = (event.wheelDelta ?? 0) !== 0 ? (event.wheelDelta! > 0 ? 1 : -1) : 0;
					if (delta !== 0) {
						if (controller.isExpanded()) {
							if ((event.y ?? 0) > 8) {
								controller.scrollDetail(delta * 2);
							} else {
								controller.move(delta);
							}
						} else {
							controller.scrollList(delta);
						}
						(capturedTui ?? options.getTui?.())?.requestRender();
						return { handled: true };
					}
				}

				if (event.type === "click") {
					const all = controller.getTasks();
					const offset = controller.getListOffset();
					const clickedIndex = offset + (event.y ?? 0) - 3;
					if (clickedIndex >= 0 && clickedIndex < all.length) {
						controller.expandTasks(all[clickedIndex].id);
						(capturedTui ?? options.getTui?.())?.requestRender();
						return { handled: true };
					}
				}

				return undefined;
			},
		};
		return component;
	};

	function startTicker(): void {
		if (ticker !== undefined) return;
		ticker = setInterval(() => {
			const all = controller.getTasks();
			if (all.length === 0 && !controller.isExpanded()) {
				stopTicker();
				render();
				return;
			}
			if (controller.isExpanded()) {
				const active = controller.getDetailTask();
				if (active && active.status === "running") {
					void refreshDockTail(active);
				}
			}
			(capturedTui ?? options.getTui?.())?.requestRender();
		}, 1000);
		(ticker as { unref?: () => void }).unref?.();
	}

	function stopTicker(): void {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	function dispose(): void {
		disposed = true;
		disableTerminalMouse((capturedTui ?? options.getTui?.()) as unknown as WritableTerminalHost);
		stopTicker();
		unsubscribe();
		ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
	}

	render();
	enableTerminalMouse((capturedTui ?? options.getTui?.()) as unknown as WritableTerminalHost);

	return {
		dispose,
		refresh: render,
		setBorderColor(fn: (text: string) => string) {
			borderColorFn = fn;
			render();
		},
	};
}
