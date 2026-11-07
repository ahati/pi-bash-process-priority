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
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { isKeyRelease, isViewportTUI, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { BgTask, TaskManagerApi } from "../types.ts";
import {
	dockRow,
	formatCleanTaskRow,
	formatHeaderLine,
	formatOutputStatusLine,
	formatResizeHandle,
	RULE_CHAR,
	taskMetadataLines,
} from "./format.ts";
import {
	clampToRange,
	computeLayout,
	DOCK_META_ROWS,
	DOCK_MIN_LIST_ROWS,
	DOCK_TAIL_CACHE_SIZE,
	resolveTermHeight,
	type DockLayoutMetrics,
} from "./dock-layout.ts";
import { boundedRead, DETAIL_TAIL_BYTES, toOutputLines } from "../log-reader.ts";
import { debugLog } from "../debug.ts";
import { disableTerminalMouse, enableTerminalMouse, parseMouseInput, type WritableTerminalHost } from "./terminal-mouse.ts";

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

	// PRD-007 Approach A: fixed two-panel layout state.
	/** User-resized master-list pane height; undefined = derive the default split. */
	private requestedListRows: number | undefined;
	/** Active handle drag: absolute screen Y + pane size at drag start. */
	private handleDragOrigin: { screenY: number; listRows: number } | undefined;

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

	/**
	 * Master-list rows for the current mode.
	 * Compact mode caps at MAX_DOCK_VISIBLE; expanded mode returns the
	 * effective pane size of the fixed two-panel layout (PRD-007 Approach A).
	 */
	getMaxVisible(termHeight?: number): number {
		if (!this.isExpanded()) {
			return MAX_DOCK_VISIBLE;
		}
		return this.getLayoutMetrics(termHeight).listRows;
	}

	/** Fixed two-panel layout metrics (row boundaries, pane sizes) — PRD-007. */
	getLayoutMetrics(termHeight?: number): DockLayoutMetrics {
		return computeLayout(resolveTermHeight(termHeight), this.requestedListRows);
	}

	/** Effective output-tail rows in the expanded two-panel layout. */
	getOutputRows(termHeight?: number): number {
		return this.isExpanded() ? this.getLayoutMetrics(termHeight).outputRows : 0;
	}

	/**
	 * Resize the master-list pane by `delta` rows (output pane absorbs the
	 * difference). True when the pane size changed.
	 */
	resizeList(delta: number, termHeight?: number): boolean {
		if (!this.isExpanded()) return false;
		const metrics = this.getLayoutMetrics(termHeight);
		return this.applyListRows((this.requestedListRows ?? metrics.defaultListRows) + delta, metrics);
	}

	/** Begin a mouse drag of the handle row; rows derive from absolute screen Y. */
	beginHandleDrag(screenY: number, termHeight?: number): void {
		this.handleDragOrigin = { screenY, listRows: this.getLayoutMetrics(termHeight).listRows };
	}

	/** Track an active handle drag to a new absolute screen Y. True on change. */
	dragHandleTo(screenY: number, termHeight?: number): boolean {
		if (!this.handleDragOrigin) return false;
		const metrics = this.getLayoutMetrics(termHeight);
		return this.applyListRows(
			this.handleDragOrigin.listRows + (screenY - this.handleDragOrigin.screenY),
			metrics,
		);
	}

	endHandleDrag(): void {
		this.handleDragOrigin = undefined;
	}

	isHandleDragActive(): boolean {
		return this.handleDragOrigin !== undefined;
	}

	private applyListRows(next: number, metrics: DockLayoutMetrics): boolean {
		const clamped = clampToRange(next, DOCK_MIN_LIST_ROWS, metrics.maxListRows);
		if (clamped === metrics.listRows) return false;
		this.requestedListRows = clamped;
		// Keep the list window consistent with the new pane size.
		const maxOffset = Math.max(0, this.getTasks().length - clamped);
		if (this.listOffset > maxOffset) this.listOffset = maxOffset;
		return true;
	}

	enterDock(fromBottom = false): boolean {
		const tasks = this.getTasks();
		if (tasks.length === 0 && !this.detailTask) {
			this.active = false;
			this.index = 0;
			this.listOffset = 0;
			return false;
		}
		this.active = true;
		if (fromBottom && tasks.length > 0) {
			this.index = tasks.length - 1;
			const maxVisible = this.getMaxVisible();
			if (this.index >= maxVisible) {
				this.listOffset = this.index - maxVisible + 1;
			} else {
				this.listOffset = 0;
			}
		}
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
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

export function installDock(
	ctx: ExtensionContext,
	registry: TaskManagerApi,
	controller: DockController,
	options: DockOptions = {},
): { dispose(): void; refresh(): void; setBorderColor(fn: (text: string) => string): void; getTui?: () => any } {
	let ticker: ReturnType<typeof setInterval> | undefined;
	let borderColorFn: ((text: string) => string) | undefined = options.borderColor;
	let disposed = false;
	let capturedTui: { requestRender(): void } | undefined;
	let widgetInstalled = false;

	const requestRender = (): void => {
		(capturedTui ?? options.getTui?.())?.requestRender();
	};

	/**
	 * Per-task output-tail cache (PRD-007 G2). Selection changes re-render from
	 * the cache instead of collapsing to "(no output yet)" while the async read
	 * is in flight — the geometry never blanks out.
	 */
	interface TailEntry {
		lines: string[];
		bytesRead: number;
		totalBytes: number;
		truncated: boolean;
	}
	const tailCache = new Map<string, TailEntry>();
	const pendingTails = new Set<string>();

	async function refreshDockTail(task: BgTask): Promise<void> {
		if (!task.logPath || disposed || pendingTails.has(task.id)) return;
		pendingTails.add(task.id);
		try {
			const read = await boundedRead(task.logPath, DETAIL_TAIL_BYTES, true);
			tailCache.delete(task.id); // re-insert => freshest at eviction-order tail
			tailCache.set(task.id, {
				lines: toOutputLines(read.content),
				bytesRead: read.bytesRead,
				totalBytes: read.totalBytes,
				truncated: read.truncated,
			});
			while (tailCache.size > DOCK_TAIL_CACHE_SIZE) {
				const oldest = tailCache.keys().next().value;
				if (oldest === undefined) break;
				tailCache.delete(oldest);
			}
		} catch {
			// Keep any previous cache entry; the render falls back to the
			// placeholder row for tasks that were never read successfully.
		} finally {
			pendingTails.delete(task.id);
			if (!disposed) requestRender();
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
			if (widgetInstalled) {
				// PRD-007 G4: only toggle registration when it actually changes —
				// setWidget() tears down and recreates the component on every call.
				widgetInstalled = false;
				ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
			}
			return;
		}
		if (!widgetInstalled) {
			widgetInstalled = true;
			ctx.ui.setWidget(DOCK_WIDGET_KEY, factory, { placement: "belowEditor" });
		}
		startTicker();
		requestRender();
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
				const termHeight = resolveTermHeight(tui?.terminal?.rows);

				// ===================================================================
				// Unified Master-Detail View (/tasks or detail)
				// Fixed two-panel layout — PRD-007 Approach A: every section is
				// pinned to a fixed row offset; the widget's total height is a pure
				// function of (termHeight, user-resized list pane), never of the
				// selection, task count, or output volume.
				// ===================================================================
				if (controller.isExpanded()) {
					const metrics = controller.getLayoutMetrics(termHeight);
					const listRows = metrics.listRows;
					const offset = controller.getListOffset(termHeight);
					const visibleTasks = all.slice(offset, offset + listRows);
					const rawSelected = controller.selectedIndex();
					const selectedIndex =
						rawSelected >= 0 ? Math.min(rawSelected, count - 1) : Math.min(offset, count - 1);

					const lines: string[] = [];

					// 1. Header rule with task count + list window indicator
					const visibleCount = Math.min(count - offset, listRows);
					const windowed = count > listRows || offset > 0;
					const hint = windowed
						? `${count} task${count === 1 ? "" : "s"} · ${offset + 1}–${offset + visibleCount} of ${count}`
						: `${count} task${count === 1 ? "" : "s"}`;
					lines.push(formatHeaderLine("Background Tasks", width, theme, hint, borderColorFn));

					// 2. Subtitle (fixed row 2)
					lines.push(theme ? theme.fg("dim", "current session branch") : "current session branch");

					// 3. Blank separator (fixed row 3)
					lines.push("");

					// 4. Master list — always exactly listRows rows. Blank pad rows
					// keep the details pane at a fixed vertical offset.
					for (let i = 0; i < listRows; i++) {
						const taskIndex = offset + i;
						const task = visibleTasks[i];
						const isSelected = taskIndex === selectedIndex;
						lines.push(task ? formatCleanTaskRow(task, isSelected, width, now, theme) : "");
					}

					// 5. Resize handle (fixed single row; drag or +/- to resize)
					lines.push(formatResizeHandle(width, theme));

					// 6. Task Details title
					lines.push(theme?.bold ? theme.bold("Task Details") : "Task Details");

					// 7. Metadata group — always exactly DOCK_META_ROWS rows (padded
					// when the task has no Cwd/Log).
					const activeTask = all[selectedIndex];
					const meta = activeTask
						? taskMetadataLines(activeTask, width, now, { theme, showMetadata: false })
						: [];
					for (let i = 0; i < DOCK_META_ROWS; i++) {
						lines.push(meta[i] ?? "");
					}

					// 8. Divider rule
					const rule = (borderColorFn ?? ((t: string) => theme.fg("dim", t)))(
						RULE_CHAR.repeat(Math.max(1, width)),
					);
					lines.push(rule);

					// 9. Output header
					lines.push("Output");
					lines.push("");

					// 10. Output tail — always exactly outputRows rows. The per-task
					// tail cache (PRD-007 G2) keeps content stable across selection
					// changes while the async read is in flight.
					const entry = activeTask && activeTask.logPath ? tailCache.get(activeTask.id) : undefined;
					if (activeTask && !entry && activeTask.logPath) {
						void refreshDockTail(activeTask);
					}
					const outputLines = entry?.lines ?? [];
					const outputRows = metrics.outputRows;

					const totalLines = outputLines.length;
					const maxScroll = Math.max(0, totalLines - outputRows);
					controller.setMaxScroll(maxScroll);

					const scrollInfo = controller.getDetailScroll();
					let startLine = 0;
					if (scrollInfo.follow || totalLines <= outputRows) {
						startLine = Math.max(0, totalLines - outputRows);
					} else {
						startLine = Math.min(scrollInfo.scroll, maxScroll);
					}

					const slice = outputLines.slice(startLine, startLine + outputRows);
					const outputStart = lines.length;
					if (slice.length === 0) {
						lines.push(theme.fg("dim", "(no output yet)"));
					} else {
						for (const line of slice) {
							lines.push(truncateToWidth(line, width));
						}
					}
					while (lines.length - outputStart < outputRows) {
						lines.push("");
					}

					// 11. Interactive hint line (fixed final row). Log-scroll keys are
					// mode-dependent: fullscreen pi binds PageUp/PageDown to the
					// transcript scroller (alt-screen consumes them before extension
					// input listeners), so there the log scrolls with Home/End;
					// regular mode has no viewport handler and PgUp/PgDn reach the
					// dock's raw input path. (e2e finding, PRD-007 §11.)
					const logScrollKeys = tui && isViewportTUI(tui) ? "Home/End log" : "PgUp/PgDn log";
					const statusText = formatOutputStatusLine({
						follow: scrollInfo.follow,
						totalLines,
						scrollTop: startLine,
						visibleLines: outputRows,
						bytesRead: entry?.bytesRead ?? 0,
						totalBytes: entry?.totalBytes ?? 0,
						truncated: entry?.truncated ?? false,
					});
					lines.push(
						theme.fg(
							"dim",
							`${statusText} · ↑/↓ select · +/- resize · ${logScrollKeys} · k kill · esc close`,
						),
					);

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
					const scrollHint = `  (${offset + 1}–${offset + visibleCount} of ${runningTasks.length} · scroll with mouse/arrows)`;
					lines.push(theme.fg("dim", scrollHint));
				}

				const SHARED_FLEET_COORDINATOR_KEY = Symbol.for("pi-subagents:fleet-coordinator");
				const fleetCoordinator = (globalThis as any)[SHARED_FLEET_COORDINATOR_KEY];
				const hasFleet = !!fleetCoordinator?.hasRows?.();
				if (!hasFleet) {
					const rule = (borderColorFn ?? ((t: string) => theme.fg("dim", t)))(
						RULE_CHAR.repeat(Math.max(1, width)),
					);
					lines.push(rule);
				}
				return lines;
			},

			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				const termHeight = resolveTermHeight(tui?.terminal?.rows);
				const metrics = controller.getLayoutMetrics(termHeight);

				// Active handle drag: pi-tui (viewport TUIs) retargets drag/release
				// to this component because press returned { capture: true }.
				if (controller.isHandleDragActive()) {
					if (event.type === "drag") {
						if (controller.dragHandleTo(event.screenY, termHeight)) requestRender();
						return { handled: true };
					}
					if (event.type === "release") {
						controller.endHandleDrag();
						requestRender();
						return { handled: true };
					}
					// Swallow other events (move, extra presses) mid-drag.
					return { handled: true };
				}

				if (event.type === "wheel") {
					const delta = (event.wheelDelta ?? 0) !== 0 ? (event.wheelDelta! > 0 ? 1 : -1) : 0;
					if (delta !== 0) {
						if (controller.isExpanded()) {
							// Wheel scrolls the region it is over (PRD-007: wheel
							// scrolls, arrows select); boundaries come from the
							// layout metrics, not literals.
							const y = event.y ?? 0;
							if (y >= metrics.listStart && y < metrics.listEnd) {
								controller.scrollList(delta, termHeight);
							} else {
								controller.scrollDetail(delta * 2);
							}
						} else {
							controller.scrollList(delta, termHeight);
						}
						requestRender();
						return { handled: true };
					}
				}

				// Resize handle: press starts a drag; capture routes the following
				// drag/release events back here even outside the widget bounds.
				if (
					event.type === "press" &&
					event.button === "left" &&
					controller.isExpanded() &&
					(event.y ?? -1) === metrics.handleIndex
				) {
					controller.beginHandleDrag(event.screenY, termHeight);
					return { handled: true, capture: true };
				}

				if (event.type === "click") {
					const all = controller.getTasks();
					const y = event.y ?? 0;
					if (controller.isExpanded()) {
						// Only clicks on actual list rows select a task; pad rows,
						// the handle row, and the detail/output panes are inert.
						if (y >= metrics.listStart && y < metrics.listEnd) {
							const offset = controller.getListOffset(termHeight);
							const clickedIndex = offset + (y - metrics.listStart);
							if (clickedIndex >= 0 && clickedIndex < all.length) {
								controller.expandTasks(all[clickedIndex].id);
								requestRender();
								return { handled: true };
							}
						}
						return undefined;
					}
					// Compact dock: task rows start at the top of the widget; the
					// scroll hint / bottom rule are inert (bounds-checked, so clicks
					// past the visible rows no longer select hidden tasks).
					const visibleCount = Math.min(all.length, MAX_DOCK_VISIBLE);
					if (y >= 0 && y < visibleCount) {
						const offset = controller.getListOffset(termHeight);
						const clickedIndex = offset + y;
						if (clickedIndex >= 0 && clickedIndex < all.length) {
							controller.expandTasks(all[clickedIndex].id);
							requestRender();
							return { handled: true };
						}
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
		widgetInstalled = false;
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
		getTui: () => capturedTui,
		setBorderColor(fn: (text: string) => string) {
			borderColorFn = fn;
			render();
		},
	};
}

function kittyArrow(data: string): "up" | "down" | "left" | "right" | undefined {
	const match = new RegExp("^\\u001b(?:O([ABCD])|\\[[0-9;:]*([ABCD]))$").exec(data);
	if (!match) return undefined;
	const letter = match[1] ?? match[2];
	return letter === "A" ? "up" : letter === "B" ? "down" : letter === "C" ? "right" : "left";
}

const DOWN_SEQUENCES = ["\x1b[B", "\x1bOB"];
const UP_SEQUENCES = ["\x1b[A", "\x1bOA"];
const LEFT_SEQUENCES = ["\x1b[D", "\x1bOD"];

function isDownKey(data: string): boolean {
	return matchesKey(data, Key.down) || DOWN_SEQUENCES.includes(data) || kittyArrow(data) === "down";
}
function isUpKey(data: string): boolean {
	return matchesKey(data, Key.up) || UP_SEQUENCES.includes(data) || kittyArrow(data) === "up";
}
function isLeftKey(data: string): boolean {
	return matchesKey(data, Key.left) || LEFT_SEQUENCES.includes(data) || kittyArrow(data) === "left";
}
function isPageUpKey(data: string): boolean {
	return matchesKey(data, Key.pageUp) || /^\u001b\[5(;[0-9:]+)?~$/.test(data);
}
function isPageDownKey(data: string): boolean {
	return matchesKey(data, Key.pageDown) || /^\u001b\[6(;[0-9:]+)?~$/.test(data);
}
function isHomeKey(data: string): boolean {
	return matchesKey(data, Key.home) || /^\u001b\[(H|1~|1;[0-9:]+H)$/.test(data);
}
function isEndKey(data: string): boolean {
	return matchesKey(data, Key.end) || /^\u001b\[(F|4~|1;[0-9:]+F)$/.test(data);
}

export interface DockInputContext {
	getEditorText?: () => string;
	onOpenTask?: (task: BgTask) => void;
	onKillTask?: (task: BgTask) => void;
}

export function handleDockInput(
	data: string,
	ctx: { ui?: { getEditorText?: () => string } } | DockInputContext,
	controller: DockController,
	registry?: TaskManagerApi,
	getTui?: () => TUI | undefined,
	callbacks?: { onOpenTask?: (task: BgTask) => void; onKillTask?: (task: BgTask) => void },
): { consume?: boolean; data?: string } | undefined {
	if (isKeyRelease(data)) return undefined;

	const mouse = parseMouseInput(data);
	if (mouse.sawMouse) {
		const tui = getTui?.();
		// Viewport TUIs (fullscreen mode) parse the raw mouse sequences
		// themselves and dispatch normalized events to the dock component; they
		// register their input listener before extensions, so by the time we see
		// data here it is regular (main-screen) mode — where raw wheel routes by
		// the keyboard-oriented rules below because widget screen origins are
		// unknown. PgUp/PgDn remain the log-scroll path in regular mode.
		if (tui && isViewportTUI(tui)) return undefined;
		if (mouse.wheelDelta !== 0) {
			if (controller.isDetail?.()) {
				controller.scrollDetail?.(mouse.wheelDelta * 2);
				tui?.requestRender();
				return { consume: true };
			}
			if (controller.inDock() || controller.isExpanded()) {
				controller.scrollList?.(mouse.wheelDelta, tui?.terminal?.rows);
				tui?.requestRender();
				return { consume: true };
			}
		}
		return undefined;
	}

	const getTextFn = (ctx as any).getEditorText ?? (ctx as any).ui?.getEditorText;
	const editorText = typeof getTextFn === "function" ? getTextFn() : "";
	const tui = getTui?.();
	const SHARED_FLEET_COORDINATOR_KEY = Symbol.for("pi-subagents:fleet-coordinator");
	const fleetCoordinator = (globalThis as any)[SHARED_FLEET_COORDINATOR_KEY];

	if (!controller.inDock()) {
		// If Subagents Fleet is currently active, yield all keys so fleet can navigate
		if (fleetCoordinator?.isActive?.()) {
			return undefined;
		}

		// ↓ on an empty editor enters dock mode
		if (isDownKey(data)) {
			if (editorText.trim() !== "") {
				return undefined;
			}
			if (controller.getTasks().length > 0 || controller.isDetail?.()) {
				if (controller.enterDock(false)) {
					debugLog("dock-input: ↓ entered dock mode");
					tui?.requestRender();
					fleetCoordinator?.update?.();
					return { consume: true };
				}
			}
			return undefined;
		}

		// Esc on empty editor closes expanded / detail view if showing
		if (editorText.trim() === "") {
			const isEscape = matchesKey(data, Key.escape) || data === "\u001b" || /^\u001b\[1?27(;[0-9:]+)?u$/.test(data);
			if (isEscape) {
				if (controller.isDetail?.()) {
					controller.closeDetail?.();
					tui?.requestRender();
					fleetCoordinator?.update?.();
					return { consume: true };
				}
				if (controller.isExpanded?.()) {
					controller.collapseTasks?.();
					tui?.requestRender();
					fleetCoordinator?.update?.();
					return { consume: true };
				}
			}
		}

		return undefined;
	}

	debugLog("dock-input: dock-mode key", JSON.stringify(data));

	// If all tasks vanished, exit dock mode cleanly
	if (!controller.isDetail?.() && !controller.selected()) {
		controller.exitDock();
		tui?.requestRender();
		fleetCoordinator?.update?.();
		return undefined;
	}

	// Ctrl+c safety valve
	if (data === "\x03") {
		controller.exitDock();
		tui?.requestRender();
		fleetCoordinator?.update?.();
		return undefined;
	}

	// Escape closes expanded / detail view and exits dock mode
	const isEscape = matchesKey(data, Key.escape) || data === "\u001b" || /^\u001b\[1?27(;[0-9:]+)?u$/.test(data);
	if (isEscape) {
		if (controller.isExpanded?.()) {
			controller.collapseTasks?.();
		}
		if (controller.isDetail?.()) {
			controller.closeDetail?.();
		}
		controller.exitDock();
		tui?.requestRender();
		fleetCoordinator?.update?.();
		return { consume: true };
	}

	// Tab switches focus between Tasks dock and Subagents fleet if fleet is present
	const isTab = matchesKey(data, Key.tab) || data === "\t";
	if (isTab && fleetCoordinator?.hasRows?.()) {
		debugLog("dock-input: Tab switching from dock to fleet list");
		controller.exitDock();
		fleetCoordinator.activate?.(true);
		tui?.requestRender();
		return { consume: true };
	}

	// ← switches to fleet list when not in detail screen
	if (!controller.isDetail?.() && isLeftKey(data)) {
		if (fleetCoordinator?.hasRows?.()) {
			debugLog("dock-input: ← switching from dock to fleet list");
			controller.exitDock();
			fleetCoordinator.activate?.(true);
			tui?.requestRender();
			return { consume: true };
		}
	}

	// Output log scrolling via PgUp / PgDn / Home / End
	if (isPageUpKey(data)) {
		controller.scrollDetail?.(-10);
		tui?.requestRender();
		return { consume: true };
	}
	if (isPageDownKey(data)) {
		controller.scrollDetail?.(10);
		tui?.requestRender();
		return { consume: true };
	}
	if (isHomeKey(data)) {
		controller.scrollDetailTop?.();
		tui?.requestRender();
		return { consume: true };
	}
	if (isEndKey(data)) {
		controller.scrollDetailBottom?.();
		tui?.requestRender();
		return { consume: true };
	}

	// ↑ navigation: moves selection up in task list, or exits to input if at top row
	if (isUpKey(data)) {
		if (controller.selectedIndex && controller.selectedIndex() <= 0) {
			debugLog("dock-input: ↑ from top row — exiting dock mode to input box");
			controller.exitDock();
			tui?.requestRender();
			return { consume: true };
		}
		controller.move?.(-1, tui?.terminal?.rows);
		tui?.requestRender();
		return { consume: true };
	}

	// ↓ navigation: moves selection down in task list, or transitions to fleet list if at bottom task
	if (isDownKey(data)) {
		const tasks = controller.getTasks?.() ?? [];
		const currentIndex = controller.selectedIndex?.() ?? -1;
		if (!controller.isDetail?.() && currentIndex >= tasks.length - 1 && tasks.length > 0 && fleetCoordinator?.hasRows?.()) {
			debugLog("dock-input: ↓ past bottom task — transitioning to fleet list");
			controller.exitDock();
			fleetCoordinator.activate?.(true);
			tui?.requestRender();
			return { consume: true };
		}
		controller.move?.(1, tui?.terminal?.rows);
		tui?.requestRender();
		return { consume: true };
	}

	// Enter opens or refreshes detail for selected task
	const isEnter = matchesKey(data, Key.enter) || data === "\r" || /^\u001b\[1?3(;[0-9:]+)?u$/.test(data);
	if (isEnter) {
		const task = controller.selected?.() ?? controller.getDetailTask?.();
		if (task) {
			controller.openDetail?.(task);
			callbacks?.onOpenTask?.(task);
		} else {
			controller.exitDock();
		}
		tui?.requestRender();
		return { consume: true };
	}

	// +/- (or =/_) resizes the master-list pane of the fixed two-panel layout
	// (PRD-007 Approach A); the output pane absorbs the difference.
	if (data === "+" || data === "=") {
		controller.resizeList?.(1, tui?.terminal?.rows);
		tui?.requestRender();
		return { consume: true };
	}
	if (data === "-" || data === "_") {
		controller.resizeList?.(-1, tui?.terminal?.rows);
		tui?.requestRender();
		return { consume: true };
	}

	// 'k' terminates selected task
	if (data === "k") {
		const task = controller.selected?.() ?? controller.getDetailTask?.();
		if (task) {
			if (callbacks?.onKillTask) {
				callbacks.onKillTask(task);
			} else if (registry) {
				void registry.kill(task.id, "dock key kill");
			}
		}
		tui?.requestRender();
		return { consume: true };
	}

	// All other keystrokes swallowed while dock mode owns keyboard
	return { consume: true };
}
