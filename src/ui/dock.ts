/**
 * Dock widget below the editor (PRD-003 §4.1, §7.7–§7.8).
 *
 * Always passes pre-rendered string arrays to `ctx.ui.setWidget` — no
 * component factory, no render caching. The 1-second ticker recomputes all
 * lines with a fresh `Date.now()` so elapsed time ticks live.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { BgTask, TaskManagerApi } from "../types.ts";
import { formatClock, formatDuration } from "./format.ts";

export const DOCK_WIDGET_KEY = "bg-tasks";

export interface DockOptions {
	/** Color function for the dock's bottom rule (matches the editor frame). */
	borderColor?: (text: string) => string;
}

export class DockController {
	private readonly getTasks: () => BgTask[];
	private index = 0;
	private active = false;

	constructor(getTasks: () => BgTask[]) {
		this.getTasks = getTasks;
	}

	enterDock(): boolean {
		if (this.getTasks().length === 0) { this.active = false; this.index = 0; return false; }
		this.active = true;
		this.index = 0;
		return true;
	}

	move(delta: number): void {
		const count = this.getTasks().length;
		if (count === 0) { this.exitDock(); return; }
		if (!this.active) return;
		this.index = Math.max(0, Math.min(count - 1, this.index + delta));
	}

	selected(): BgTask | undefined {
		if (!this.active) return undefined;
		return this.getTasks()[this.index];
	}

	exitDock(): void {
		this.active = false;
		this.index = 0;
	}

	inDock(): boolean { return this.active; }
	selectedIndex(): number { return this.active ? this.index : -1; }
	reconcile(): void {
		if (this.getTasks().length === 0) this.exitDock();
		else if (this.index >= this.getTasks().length) this.index = this.getTasks().length - 1;
	}
}

export function installDock(
	ctx: ExtensionContext,
	registry: TaskManagerApi,
	controller: DockController,
	options: DockOptions = {},
): { dispose(): void; refresh(): void; setBorderColor(fn: (text: string) => string): void } {
	let ticker: ReturnType<typeof setInterval> | undefined;
	let borderColor: ((text: string) => string) | undefined = options.borderColor;
	let lastWidth = 120;
	let disposed = false;

	const tasks = (): BgTask[] => registry.list().filter((t: BgTask) => t.status === "running");
	const unsubscribe = registry.onChange(() => render());

	function render(): void {
		if (disposed) return;
		const all = tasks();

		if (all.length === 0) {
			stopTicker();
			ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}

		startTicker();
		const now = Date.now();
		const selectedIndex = controller.inDock() ? controller.selectedIndex() : -1;
		const w = lastWidth;
		const lines: string[] = [];

		for (let i = 0; i < Math.min(all.length, 7); i++) {
			const task = all[i];
			const lead = i === selectedIndex ? "> " : "  ";
			const clock = formatClock(task.startedAt);
			const cmd = task.command.length > w - 32 ? task.command.slice(0, w - 32) + "…" : task.command;
			const elapsed = task.status === "running"
				? ` · ${formatDuration(now - task.startedAt)}` : "";
			const status = task.status === "running" ? "running"
				: task.status === "completed" ? "completed"
				: task.status === "failed" ? `failed (${task.exitCode})`
				: `killed${task.reason ? ` (${task.reason})` : ""}`;
			const bullet = task.status === "running" ? "\u25cf" : "\u25cf";
			const line = `${lead}${bullet} [${clock}] ${cmd} ${status}${elapsed}`;
			// Dim the non-selected rows' status suffix
			lines.push(line);
		}

		const ruleText = (options.borderColor ?? ((t: string) => t))(RULE_CHAR.repeat(500));
		lines.push(ruleText);

		ctx.ui.setWidget(DOCK_WIDGET_KEY, lines, { placement: "belowEditor" });
	}

	function startTicker(): void {
		if (ticker !== undefined) return;
		ticker = setInterval(() => {
			if (tasks().length === 0) { stopTicker(); render(); return; }
			render();
		}, 1000);
		(ticker as { unref?: () => void }).unref?.();
	}

	function stopTicker(): void {
		if (ticker !== undefined) { clearInterval(ticker); ticker = undefined; }
	}

	function dispose(): void {
		disposed = true;
		stopTicker();
		unsubscribe();
		ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
	}

	render();

	return { dispose, refresh: render, setBorderColor(fn: (text: string) => string) { borderColor = fn; render(); } };
}

const RULE_CHAR = "\u2500";
