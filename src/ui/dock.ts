/**
 * Dock widget below the editor (PRD-003 §4.1, §7.7–§7.8).
 *
 * Uses a component factory — pi calls `render(width)` with the CURRENT
 * available width on every render pass, so the bottom rule and elapsed time
 * resize dynamically with the terminal. The 1-second ticker triggers
 * `requestRender()` so the elapsed time ticks live.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { BgTask, TaskManagerApi } from "../types.ts";
import { detailLines, formatClock, formatDuration } from "./format.ts";
import { debugLog } from "../debug.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const DOCK_WIDGET_KEY = "bg-tasks";

const RULE_CHAR = "\u2500";

export interface DockOptions {
	/** Color function for the dock's bottom rule (matches the editor frame). */
	borderColor?: (text: string) => string;
	/** Fallback accessor for the TUI instance if capturedTui is not yet set. */
	getTui?: () => TUI | undefined;
}

export class DockController {
	private readonly getTasks: () => BgTask[];
	private index = 0;
	private active = false;
	private view: "list" | "detail" = "list";
	private detailTask: BgTask | undefined;
	private detailScroll = 0;
	private detailFollow = true;
	private detailMaxScroll = 0;

	constructor(getTasks: () => BgTask[]) {
		this.getTasks = getTasks;
	}

	enterDock(): boolean {
		if (this.getTasks().length === 0 && !this.detailTask) {
			this.active = false;
			this.index = 0;
			return false;
		}
		this.active = true;
		if (this.view !== "detail") {
			this.view = "list";
			this.detailTask = undefined;
			this.index = 0;
		}
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

	openDetail(task?: BgTask): void {
		const t = task ?? this.selected();
		if (!t) return;
		this.active = true;
		this.view = "detail";
		this.detailTask = t;
		this.detailScroll = 0;
		this.detailFollow = false;
	}

	closeDetail(): void {
		this.view = "list";
		this.detailTask = undefined;
		this.detailScroll = 0;
		this.detailFollow = false;
	}

	isDetail(): boolean {
		return this.view === "detail";
	}

	getDetailTask(): BgTask | undefined {
		return this.detailTask;
	}

	scrollDetail(delta: number): void {
		if (!this.isDetail()) return;
		this.detailFollow = false;
		this.detailScroll = Math.max(0, Math.min(this.detailMaxScroll, this.detailScroll + delta));
	}

	scrollDetailTop(): void {
		if (!this.isDetail()) return;
		this.detailFollow = false;
		this.detailScroll = 0;
	}

	scrollDetailBottom(): void {
		if (!this.isDetail()) return;
		this.detailFollow = true;
		this.detailScroll = this.detailMaxScroll;
	}

	setMaxScroll(max: number): void {
		this.detailMaxScroll = max;
	}

	getDetailScroll(): { scroll: number; follow: boolean } {
		return { scroll: this.detailScroll, follow: this.detailFollow };
	}

	exitDock(): void {
		this.active = false;
	}

	inDock(): boolean { return this.active; }
	selectedIndex(): number { return this.active ? this.index : -1; }
	getView(): "list" | "detail" { return this.view; }

	reconcile(): void {
		if (this.view === "detail") {
			if (this.detailTask) {
				const updated = this.getTasks().find((t) => t.id === this.detailTask?.id);
				if (updated) this.detailTask = updated;
			}
			return;
		}
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
		// A task can finish or time out while the dock owns the keyboard. Rows
		// disappear from the widget on their own, so the controller must be told
		// too — otherwise `inDock()` stays true and DockEditor keeps swallowing
		// keystrokes until the user presses Esc (PRD-003 §7.7).
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
		const all = tasks();
		if (all.length === 0 && !controller.isDetail()) {
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

				if (controller.isDetail()) {
					const task = controller.getDetailTask();
					if (!task) return [];
					const lines: string[] = detailLines(task, width, Date.now());
					lines.push(""); // blank line between "Output" and the content

					let outputLines: string[] = [];
					if (task.logPath && existsSync(task.logPath)) {
						try {
							const raw = readFileSync(task.logPath, "utf8");
							outputLines = raw.trimEnd().split("\n");
						} catch {
							outputLines = [];
						}
					}

					const height = 10;
					const maxScroll = Math.max(0, outputLines.length - height);
					controller.setMaxScroll(maxScroll);
					const { scroll: curScroll, follow } = controller.getDetailScroll();
					const scroll = follow ? maxScroll : Math.max(0, Math.min(maxScroll, curScroll));
					const visible = outputLines.slice(scroll, scroll + height);

					if (visible.length === 0 || (visible.length === 1 && visible[0].trim() === "")) {
						lines.push(theme.fg("dim", "(no output)"));
					} else {
						for (const l of visible) {
							lines.push(theme.fg("toolOutput", truncateToWidth(l, width)));
						}
					}

					lines.push("");
					const rule = (options.borderColor ?? ((t: string) => theme.fg("dim", t)))(RULE_CHAR.repeat(Math.max(1, width)));
					lines.push(rule);
					if (controller.inDock()) {
						lines.push(theme.fg("dim", "↑ input · ↑/↓ scroll · pgup/pgdown · esc back · k kill"));
					} else {
						lines.push(theme.fg("dim", "↓ enter detail · esc back to tasks"));
					}
					return lines;
				}

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
			if (tasks().length === 0 && !controller.isDetail()) { stopTicker(); render(); return; }
			(capturedTui ?? options.getTui?.())?.requestRender();
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
