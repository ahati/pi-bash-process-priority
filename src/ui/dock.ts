/**
 * Dock widget below the editor (PRD-003 §4.1, §7.7–§7.8).
 *
 * Uses a component factory — pi calls `render(width)` with the CURRENT
 * available width on every render pass, so the bottom rule and elapsed time
 * resize dynamically with the terminal. The 1-second ticker triggers
 * `requestRender()` so the elapsed time ticks live.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { BgTask, TaskManagerApi } from "../types.ts";
import { formatClock, formatDuration } from "./format.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const DOCK_WIDGET_KEY = "bg-tasks";

const RULE_CHAR = "\u2500";

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

	exitDock(): void { this.active = false; this.index = 0; }
	inDock(): boolean { return this.active; }
	selectedIndex(): number { return this.active ? this.index : -1; }
	reconcile(): void {
		if (this.getTasks().length === 0) this.exitDock();
		else if (this.index >= this.getTasks().length) this.index = this.getTasks().length - 1;
	}
}

interface DockWidget {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
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

	const tasks = (): BgTask[] => registry.list().filter((t: BgTask) => t.status === "running");
	const unsubscribe = registry.onChange(() => {
		render();
		capturedTui?.requestRender();
	});

	function render(): void {
		if (disposed) return;
		const all = tasks();
		if (all.length === 0) {
			stopTicker();
			ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}
		startTicker();
		ctx.ui.setWidget(DOCK_WIDGET_KEY, factory, { placement: "belowEditor" });
		capturedTui?.requestRender();
	}

	const factory = (tui: TUI, theme: Theme): DockWidget => {
		capturedTui = tui;
		const component: DockWidget = {
			invalidate() {},
			dispose() { stopTicker(); },
			render(width: number): string[] {
				if (disposed) return [];
				const all = tasks();
				if (all.length === 0) return [];
				const now = Date.now();
				const selectedIndex = controller.inDock() ? controller.selectedIndex() : -1;
				const lines: string[] = [];
				for (let i = 0; i < Math.min(all.length, 7); i++) {
					const task = all[i];
					const lead = i === selectedIndex ? "> " : "  ";
					const bulletColor =
						task.status === "running" ? "accent" :
						task.status === "failed" ? "error" : "dim";
					const bullet = theme.fg(bulletColor as Parameters<Theme["fg"]>[0], "\u25cf");
					const clock = formatClock(task.startedAt);
					const cmd = truncateToWidth(task.command, Math.max(10, width - 32));
					const status = task.status === "running" ? "running"
						: task.status === "failed" ? `failed (${task.exitCode})`
						: `killed${task.reason ? ` (${task.reason})` : ""}`;
					const elapsed = task.status === "running"
						? theme.fg("dim", ` \u00b7 ${formatDuration(now - task.startedAt)}`) : "";
					lines.push(`${lead}${bullet} [${clock}] ${cmd} ${status}${elapsed}`);
				}
				const rule = (options.borderColor ?? ((t: string) => theme.fg("dim", t)))(RULE_CHAR.repeat(Math.max(1, width)));
				lines.push(rule);
				return lines;
			},
		};
		return component;
	};

	function startTicker(): void {
		if (ticker !== undefined) return;
		ticker = setInterval(() => {
			if (tasks().length === 0) { stopTicker(); render(); return; }
			capturedTui?.requestRender();
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

	return {
		dispose,
		refresh: render,
		setBorderColor(fn: (text: string) => string) { borderColorFn = fn; render(); },
	};
}
