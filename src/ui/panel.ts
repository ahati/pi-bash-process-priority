/**
 * `/tasks` panel (§7.9): list view + Task Details, rendered as a fullscreen
 * `ctx.ui.custom<Component>` component (not an overlay).
 * Enhanced with task details, dynamic tail scrolling, activity metrics,
 * unread badges, and quick actions from pi-background-tasks.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { BgTask, TaskManagerApi } from "../types.ts";
import {
	detailLines,
	dockRow,
	formatOutputStatusLine,
	formatSize,
} from "./format.ts";
import { boundedRead, DETAIL_TAIL_BYTES, toOutputLines } from "../log-reader.ts";
import { enableTerminalMouse, disableTerminalMouse, parseMouseInput } from "./terminal-mouse.ts";

const MAX_LIST_ROWS = 10;
const TICK_MS = 1000;
const DETAIL_VIEWPORT_HEIGHT = 10;

type View = "list" | "detail";

export class TasksPanel implements Component {
	private view: View = "list";
	private listIndex = 0;
	private listOffset = 0;
	private detailTask: BgTask | undefined;
	private output: string[] = [];
	private scroll = 0;
	private follow = true;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private busy = false;
	private closed = false;
	private lastWidth = 0;
	private cache: string[] = [];

	// Enhanced capabilities from pi-background-tasks
	private showHistory = false;
	private readonly seenTaskIds = new Set<string>();
	private confirmStopAllArmed = false;
	private actionMessage: string | undefined;
	private tailBytesRead = 0;
	private tailTotalBytes = 0;
	private tailTruncated = false;
	private tailError: string | undefined;
	private readonly lastBytesByTask = new Map<string, number>();
	private readonly recentActivityByTask = new Map<string, { delta: number; timestamp: number }>();

	constructor(
		private readonly theme: Theme,
		private readonly registry: TaskManagerApi,
		private readonly ui: ExtensionContext["ui"],
		private readonly done: () => void,
		private readonly initialTask?: BgTask,
		private readonly detailOnly = false,
	) {
		if (initialTask) {
			this.view = "detail";
			this.detailTask = initialTask;
			this.seenTaskIds.add(initialTask.id);
			void this.reloadLogs();
			if (initialTask.status === "running") this.startTicker();
		} else {
			const all = registry.list();
			const hasRunning = all.some((t) => t.status === "running");
			const hasFinished = all.some((t) => t.status !== "running");
			if (!hasRunning && hasFinished) this.showHistory = true;
		}
	}

	dispose(): void {
		this.closed = true;
		this.stopTicker();
	}

	handleInput(data: string): void {
		const mouse = parseMouseInput(data);
		if (mouse.sawMouse) {
			if (mouse.wheelDelta !== 0) {
				if (this.view === "list") {
					const tasks = this.currentTasks();
					if (tasks.length > 0) {
						this.listIndex = Math.min(Math.max(0, tasks.length - 1), this.listIndex + mouse.wheelDelta);
						this.clampListOffset(tasks.length);
						this.invalidateCache();
					}
				} else {
					const height = this.pageSize();
					this.follow = false;
					this.scroll = Math.min(this.maxScroll(height), Math.max(0, this.scroll + mouse.wheelDelta));
					this.invalidateCache();
				}
			}
			return;
		}

		if (this.view === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
		if (event.type === "wheel") {
			const delta = (event.wheelDelta ?? 0) !== 0 ? (event.wheelDelta! > 0 ? 1 : -1) : 0;
			if (delta !== 0) {
				if (this.view === "list") {
					const tasks = this.currentTasks();
					if (tasks.length > 0) {
						this.listIndex = Math.min(Math.max(0, tasks.length - 1), this.listIndex + delta);
						this.clampListOffset(tasks.length);
						this.invalidateCache();
						return { handled: true };
					}
				} else {
					const height = this.pageSize();
					this.follow = false;
					this.scroll = Math.min(this.maxScroll(height), Math.max(0, this.scroll + delta));
					this.invalidateCache();
					return { handled: true };
				}
			}
		}
		return undefined;
	}

	private currentTasks(): BgTask[] {
		const all = this.registry.list();
		if (this.showHistory) return all;
		const running = all.filter((t) => t.status === "running");
		if (running.length === 0 && all.some((t) => t.status !== "running")) {
			this.showHistory = true;
			return all;
		}
		return running;
	}

	private activityLabel(task: BgTask): string {
		if (task.status !== "running") return "";
		const now = Date.now();
		const current = task.bytesWritten ?? 0;
		const prev = this.lastBytesByTask.get(task.id);
		this.lastBytesByTask.set(task.id, current);
		if (prev !== undefined && current > prev) {
			const delta = current - prev;
			this.recentActivityByTask.set(task.id, { delta, timestamp: now });
			return `+${formatSize(delta)} ↑`;
		}
		const recent = this.recentActivityByTask.get(task.id);
		if (recent && now - recent.timestamp < 3000) {
			return `+${formatSize(recent.delta)} ↑`;
		}
		return "";
	}

	private handleListInput(data: string): void {
		const isStopAll = data === "a" || data === "A" || data === "K";
		if (!isStopAll) this.confirmStopAllArmed = false;
		this.actionMessage = undefined;

		const tasks = this.currentTasks();
		if (matchesKey(data, Key.escape) || data === "q" || data === "x") {
			this.close();
			return;
		}
		if (data === "h" || data === "H") {
			this.showHistory = !this.showHistory;
			this.listIndex = 0;
			this.listOffset = 0;
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.listIndex = Math.max(0, this.listIndex - 1);
			this.clampListOffset(tasks.length);
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.listIndex = Math.min(Math.max(0, tasks.length - 1), this.listIndex + 1);
			this.clampListOffset(tasks.length);
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.listIndex = Math.max(0, this.listIndex - MAX_LIST_ROWS);
			this.clampListOffset(tasks.length);
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.listIndex = Math.min(Math.max(0, tasks.length - 1), this.listIndex + MAX_LIST_ROWS);
			this.clampListOffset(tasks.length);
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			const task = tasks[this.listIndex];
			if (task) this.openDetail(task);
			return;
		}
		if (data === "k") {
			const task = tasks[this.listIndex];
			if (task) void this.kill(task);
			return;
		}
		if (data === "a" || data === "A" || data === "K") {
			void this.stopAll();
			return;
		}
		if (data === "R") {
			const task = tasks[this.listIndex];
			if (task) void this.rerun(task);
			return;
		}
		if (data === "c" || data === "C") {
			const task = tasks[this.listIndex];
			if (task) {
				this.actionMessage = `Log path: ${task.logPath}`;
				this.invalidateCache();
			}
			return;
		}
		if (data === "s") {
			const task = tasks[this.listIndex];
			if (task) void this.sendInput(task);
		}
	}

	private handleDetailInput(data: string): void {
		const height = this.pageSize();
		this.actionMessage = undefined;

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			if (this.detailOnly) { this.close(); return; }
			this.backToList();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.follow = false;
			this.scroll = Math.max(0, this.scroll - 1);
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scroll = Math.min(this.maxScroll(height), this.scroll + 1);
			if (this.scroll >= this.maxScroll(height)) this.follow = true;
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.follow = false;
			this.scroll = Math.max(0, this.scroll - height);
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scroll = Math.min(this.maxScroll(height), this.scroll + height);
			if (this.scroll >= this.maxScroll(height)) this.follow = true;
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.follow = false;
			this.scroll = 0;
			this.invalidateCache();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.follow = true;
			this.scroll = this.maxScroll(height);
			this.invalidateCache();
			return;
		}
		if (data === "r") {
			this.follow = true;
			void this.reloadLogs();
			return;
		}
		if (data === "R" && this.detailTask) {
			void this.rerun(this.detailTask);
			return;
		}
		if (data === "k" && this.detailTask) {
			void this.kill(this.detailTask);
			return;
		}
		if ((data === "c" || data === "C") && this.detailTask) {
			this.actionMessage = `Log path: ${this.detailTask.logPath}`;
			this.invalidateCache();
			return;
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopTicker();
		this.done();
	}

	private backToList(): void {
		this.view = "list";
		this.detailTask = undefined;
		this.output = [];
		this.scroll = 0;
		this.follow = true;
		this.stopTicker();
		this.invalidateCache();
	}

	private openDetail(task: BgTask): void {
		this.view = "detail";
		this.detailTask = task;
		this.seenTaskIds.add(task.id);
		this.scroll = 0;
		this.follow = true;
		this.output = [];
		void this.reloadLogs();
		if (task.status === "running") this.startTicker();
		this.invalidateCache();
	}

	private async kill(task: BgTask): Promise<void> {
		const ok = await this.ui.confirm("Kill background task", `Kill ${task.id}: ${task.command}?`);
		if (!ok) return;
		try {
			await this.registry.kill(task.id, "user kill");
			this.actionMessage = `Killed ${task.id}.`;
		} catch (error) {
			this.actionMessage = `Kill failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.invalidateCache();
	}

	private async stopAll(): Promise<void> {
		const running = this.registry.list().filter((t) => t.status === "running");
		if (running.length === 0) {
			this.actionMessage = "No running tasks to stop.";
			this.invalidateCache();
			return;
		}
		if (!this.confirmStopAllArmed) {
			this.confirmStopAllArmed = true;
			this.actionMessage = `Press a/K again to stop all ${running.length} running task(s).`;
			this.invalidateCache();
			return;
		}
		this.confirmStopAllArmed = false;
		this.actionMessage = `Stopping all ${running.length} task(s)...`;
		this.invalidateCache();
		if (this.registry.stopAllRunning) {
			const res = await this.registry.stopAllRunning();
			this.actionMessage = res.failures.length > 0
				? `Stopped ${res.stopped}; failures: ${res.failures.join("; ")}`
				: `Stopped ${res.stopped} task(s).`;
		} else {
			await this.registry.disposeAll("stop all");
			this.actionMessage = `Stopped ${running.length} task(s).`;
		}
		this.invalidateCache();
	}

	private async rerun(task: BgTask): Promise<void> {
		this.actionMessage = `Rerunning ${task.id}...`;
		this.invalidateCache();
		try {
			let newT: BgTask;
			if (this.registry.rerun) {
				newT = await this.registry.rerun(task.id);
			} else {
				newT = await this.registry.run(task.command, task.cwd || process.cwd(), {
					name: task.name,
					callerType: task.callerType,
					subagentName: task.subagentName,
				});
			}
			this.actionMessage = `Reran as ${newT.id}.`;
		} catch (err) {
			this.actionMessage = `Rerun failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		this.invalidateCache();
	}

	private async sendInput(task: BgTask): Promise<void> {
		const input = await this.ui.input(`Send input to ${task.id}`);
		if (input === undefined || input === "") return;
		try {
			this.registry.sendInput(task.id, input);
			this.actionMessage = `Input sent to ${task.id}.`;
		} catch (error) {
			this.actionMessage = `Send input failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.invalidateCache();
	}

	private startTicker(): void {
		this.stopTicker();
		this.ticker = setInterval(() => {
			if (this.closed) return;
			void this.reloadLogs();
			const task = this.detailTask;
			if (task && this.registry.get(task.id)?.status !== "running") {
				this.detailTask = this.registry.get(task.id);
				this.stopTicker();
			}
			this.invalidateCache();
		}, TICK_MS);
		(this.ticker as { unref?: () => void }).unref?.();
	}

	private stopTicker(): void {
		if (this.ticker !== undefined) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private async reloadLogs(): Promise<void> {
		const task = this.detailTask;
		if (!task || this.busy) return;
		this.busy = true;
		try {
			const read = await boundedRead(task.logPath, DETAIL_TAIL_BYTES, true);
			this.output = toOutputLines(read.content);
			this.tailBytesRead = read.bytesRead;
			this.tailTotalBytes = read.totalBytes;
			this.tailTruncated = read.truncated;
			this.tailError = undefined;
		} catch (error) {
			this.output = [];
			this.tailError = `Log read failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.busy = false;
		}
		if (this.follow) this.scroll = Math.max(0, this.output.length - this.pageSize());
		this.invalidateCache();
	}

	private pageSize(): number {
		return DETAIL_VIEWPORT_HEIGHT;
	}

	private maxScroll(height: number): number {
		return Math.max(0, this.output.length - height);
	}

	private clampListOffset(count: number): void {
		if (this.listIndex < this.listOffset) this.listOffset = this.listIndex;
		if (this.listIndex >= this.listOffset + MAX_LIST_ROWS) this.listOffset = this.listIndex - MAX_LIST_ROWS + 1;
		const maxOffset = Math.max(0, count - MAX_LIST_ROWS);
		this.listOffset = Math.min(Math.max(0, this.listOffset), maxOffset);
	}

	invalidate(): void {
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = [];
		this.lastWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.lastWidth && this.cache.length > 0) return this.cache;
		this.lastWidth = width;
		const lines = this.view === "list" ? this.renderList(width) : this.renderDetail(width);
		this.cache = lines.map((line) => truncateToWidth(line, width));
		return this.cache;
	}

	private renderList(width: number): string[] {
		const tasks = this.currentTasks();
		const allTasks = this.registry.list();
		const runningCount = allTasks.filter((t) => t.status === "running").length;
		const historyCount = allTasks.length - runningCount;
		const unseenDone = allTasks.filter(
			(t) => t.status !== "running" && !this.seenTaskIds.has(t.id),
		).length;
		const failedCount = allTasks.filter((t) => t.status === "failed").length;

		const subtitleParts: string[] = [];
		if (this.showHistory) {
			subtitleParts.push(`${runningCount} active`, `${historyCount} history`);
		} else {
			subtitleParts.push(runningCount > 0 ? `${runningCount} active` : "No active tasks");
		}
		if (failedCount > 0) subtitleParts.push(`${failedCount} failed`);
		if (unseenDone > 0) subtitleParts.push(`${unseenDone} unread`);
		const subtitle = subtitleParts.join(" · ");

		const dim = (text: string): string => this.theme.fg("dim", text);
		const lines: string[] = [];
		lines.push(`${this.theme.fg("accent", this.theme.bold("Tasks"))} ${dim(`(${subtitle})`)}`);
		lines.push("");

		if (tasks.length === 0) {
			const emptyMsg = allTasks.length === 0
				? "  No background tasks in this session."
				: "  No running background tasks. Press h to show recent history.";
			lines.push(dim(emptyMsg));
		} else {
			this.clampListOffset(tasks.length);
			const visible = tasks.slice(this.listOffset, this.listOffset + MAX_LIST_ROWS);
			const selected = this.listIndex - this.listOffset;
			for (let i = 0; i < visible.length; i++) {
				const task = visible[i];
				const isSelected = i === selected;
				const isUnseen = task.status !== "running" && !this.seenTaskIds.has(task.id);
				const unreadBadge = isUnseen ? this.theme.fg("warning", "● ") : "  ";
				const activity = this.activityLabel(task);
				const actText = activity ? ` ${this.theme.fg("warning", activity)}` : "";
				const row = dockRow(task, isSelected, width - 4);
				lines.push(`${unreadBadge}${row}${actText}`);
			}
			if (tasks.length > MAX_LIST_ROWS) {
				lines.push(dim(`  Showing ${this.listOffset + 1}–${Math.min(tasks.length, this.listOffset + MAX_LIST_ROWS)} of ${tasks.length}`));
			}
		}

		if (this.actionMessage) {
			lines.push("");
			lines.push(this.theme.fg("warning", `  ${this.actionMessage}`));
		}

		lines.push("");
		const listHint = `↑/↓ select · enter details · k kill · a stop all · h ${this.showHistory ? "hide" : "show"} history · R rerun · c path · s input · esc close`;
		lines.push(dim(listHint));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const task = this.detailTask ?? this.registry.list()[0];
		if (!task) {
			return [this.theme.fg("dim", "No background tasks."), "", this.theme.fg("dim", "esc back")];
		}
		const lines: string[] = detailLines(task, width, Date.now(), { showMetadata: true, theme: this.theme });
		lines.push("");

		const height = DETAIL_VIEWPORT_HEIGHT;
		const maxScroll = Math.max(0, this.output.length - height);
		if (this.follow) this.scroll = maxScroll;
		this.scroll = Math.max(0, Math.min(maxScroll, this.scroll));
		const visible = this.output.slice(this.scroll, this.scroll + height);

		if (this.tailError) {
			lines.push(this.theme.fg("error", this.tailError));
		} else if (visible.length === 0) {
			lines.push(this.theme.fg("dim", "(no output)"));
		} else {
			for (const l of visible) {
				lines.push(this.theme.fg("toolOutput", truncateToWidth(l, width)));
			}
		}

		lines.push("");
		const statusLine = formatOutputStatusLine({
			follow: this.follow,
			totalLines: this.output.length,
			scrollTop: this.scroll,
			visibleLines: height,
			bytesRead: this.tailBytesRead,
			totalBytes: this.tailTotalBytes,
			truncated: this.tailTruncated,
		});
		lines.push(this.theme.fg("dim", statusLine));

		if (this.actionMessage) {
			lines.push("");
			lines.push(this.theme.fg("warning", `  ${this.actionMessage}`));
		}

		lines.push("");
		const detailHint = "↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · r refresh · R rerun · k kill · c path · esc back";
		lines.push(this.theme.fg("dim", detailHint));
		return lines;
	}

	/** Output body used for scroll math; recomputed each render. */
	setOutputLines(lines: string[]): void {
		this.output = lines;
	}
}

export async function openTasksPanel(
	ctx: ExtensionContext,
	registry: TaskManagerApi,
	_keybindings: KeybindingsManager,
	initialTask?: BgTask,
	detailOnly = false,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		enableTerminalMouse(tui);
		const onDone = () => {
			disableTerminalMouse(tui);
			done();
		};
		return new TasksPanel(theme, registry, ctx.ui, onDone, initialTask, detailOnly);
	});
}
