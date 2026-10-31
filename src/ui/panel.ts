/**
 * `/tasks` panel (§7.9): list view + Task Details, rendered as a fullscreen
 * `ctx.ui.custom<Component>` component (not an overlay).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { BgTask, TaskManagerApi } from "../types.ts";
import { detailLines, dockRow } from "./format.ts";

const MAX_LIST_ROWS = 10;
const LOG_LIMIT = 50 * 1024;
const TICK_MS = 1000;

const LIST_HINT = "↑/↓ select · enter details · k kill · s input · esc close";
const DETAIL_HINT = "↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · esc back";

type View = "list" | "detail";

class TasksPanel implements Component {
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

	constructor(
		private readonly theme: Theme,
		private readonly registry: TaskManagerApi,
		private readonly ui: ExtensionContext["ui"],
		private readonly done: () => void,
	) {}

	dispose(): void {
		this.closed = true;
		this.stopTicker();
	}

	handleInput(data: string): void {
		if (this.view === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
	}

	private handleListInput(data: string): void {
		const tasks = this.registry.list();
		if (matchesKey(data, Key.escape)) {
			this.close();
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
		if (matchesKey(data, Key.enter)) {
			const task = tasks[this.listIndex];
			if (task) this.openDetail(task);
			return;
		}
		if (data === "k") {
			const task = tasks[this.listIndex];
			if (task) void this.kill(task);
			return;
		}
		if (data === "s") {
			const task = tasks[this.listIndex];
			if (task) void this.sendInput(task);
		}
	}

	private handleDetailInput(data: string): void {
		const height = this.pageSize();
		if (matchesKey(data, Key.escape)) {
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
		} catch {
			/* registry reports failures through task state */
		}
		this.invalidateCache();
	}

	private async sendInput(task: BgTask): Promise<void> {
		const input = await this.ui.input(`Send input to ${task.id}`);
		if (input === undefined || input === "") return;
		try {
			this.registry.sendInput(task.id, input);
		} catch {
			/* task may have finished */
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
			const text = await this.registry.logs(task.id, LOG_LIMIT);
			this.output = text.replace(/\n$/, "").split("\n");
		} catch {
			this.output = [];
		} finally {
			this.busy = false;
		}
		if (this.follow) this.scroll = Math.max(0, this.output.length - 1);
		this.invalidateCache();
	}

	private pageSize(): number {
		return Math.max(1, this.output.length - 2);
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
		const tasks = this.registry.list();
		const dim = (text: string): string => this.theme.fg("dim", text);
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", "Tasks"));
		lines.push("");
		if (tasks.length === 0) {
			lines.push("  No background tasks.");
		} else {
			this.clampListOffset(tasks.length);
			const visible = tasks.slice(this.listOffset, this.listOffset + MAX_LIST_ROWS);
			const selected = this.listIndex - this.listOffset;
			for (let i = 0; i < visible.length; i++) {
				lines.push(dockRow(visible[i], i === selected, width));
			}
			if (tasks.length > MAX_LIST_ROWS) {
				lines.push(dim(`  ${this.listOffset + visible.length}/${tasks.length}`));
			}
		}
		lines.push("");
		lines.push(dim(LIST_HINT));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const task = this.detailTask ?? this.registry.list()[0];
		if (!task) return [this.theme.fg("dim", "No background tasks."), "", this.theme.fg("dim", LIST_HINT)];
		const lines: string[] = detailLines(task, width);
		lines.push(""); // blank line between "Output" and the content (§4.2)
		const height = Math.max(1, 10);
		const maxScroll = Math.max(0, this.output.length - height);
		if (this.follow) this.scroll = maxScroll;
		this.scroll = Math.max(0, Math.min(maxScroll, this.scroll));
		const visible = this.output.slice(this.scroll, this.scroll + height);
		lines.push(...visible);
		if (visible.length === 0) lines.push(this.theme.fg("dim", "(no output)"));
		lines.push("");
		lines.push(this.theme.fg("dim", DETAIL_HINT));
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
): Promise<void> {
	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		return new TasksPanel(theme, registry, ctx.ui, done);
	});
}
