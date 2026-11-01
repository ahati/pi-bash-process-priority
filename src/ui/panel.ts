/**
 * TasksPanel component and standalone tasks viewer.
 * Clean, lightweight component providing task listing, history toggle,
 * inspection, and stop-all confirmation.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { BgTask, TaskManagerApi } from "../types.ts";
import { formatCleanTaskRow, formatHeaderLine, formatTimestamp, RULE_CHAR, taskStatusIcon } from "./format.ts";
import { disableTerminalMouse, enableTerminalMouse } from "./terminal-mouse.ts";

export class TasksPanel implements Component {
	private selectedIndex = 0;
	private showHistory = false;
	private actionMessage: string | undefined;
	private confirmStopAllArmed = false;
	private outputLines: string[] = [];

	constructor(
		private readonly theme: Theme,
		private readonly registry: TaskManagerApi,
		private readonly ui: ExtensionContext["ui"],
		private readonly done: () => void,
		private readonly initialTask?: BgTask,
		private readonly detailOnly = false,
	) {
		const all = this.getVisibleTasks();
		if (initialTask) {
			const idx = all.findIndex((t) => t.id === initialTask.id);
			if (idx >= 0) this.selectedIndex = idx;
		}
	}

	private getVisibleTasks(): BgTask[] {
		const all = this.registry.list();
		if (this.showHistory) return all;
		const running = all.filter((t) => t.status === "running");
		return running.length > 0 ? running : all;
	}

	render(width: number): string[] {
		const all = this.registry.list();
		const running = all.filter((t) => t.status === "running");
		const visible = this.getVisibleTasks();

		if (this.selectedIndex >= visible.length) {
			this.selectedIndex = Math.max(0, visible.length - 1);
		}

		const lines: string[] = [];
		lines.push(formatHeaderLine("Background Tasks", width, this.theme));

		const activeCount = running.length;
		const histCount = all.length - activeCount;
		const subtitle = this.showHistory
			? `${activeCount} active · ${histCount} history`
			: `${activeCount} active`;
		lines.push(this.theme.fg("dim", subtitle));
		lines.push("");

		const now = Date.now();
		for (let i = 0; i < visible.length; i++) {
			const task = visible[i];
			const isSelected = i === this.selectedIndex;
			lines.push(formatCleanTaskRow(task, isSelected, width, now, this.theme));
		}

		lines.push("");

		if (this.confirmStopAllArmed) {
			lines.push(
				this.theme.fg("error", `Press a/K again to stop all ${activeCount} running task(s).`),
			);
		} else if (this.actionMessage) {
			lines.push(this.theme.fg("dim", this.actionMessage));
		}

		const rule = (t: string) => this.theme.fg("dim", t);
		lines.push(rule(RULE_CHAR.repeat(Math.max(1, width))));

		const selectedTask = visible[this.selectedIndex];
		if (selectedTask) {
			lines.push(
				this.theme.fg(
					"dim",
					`Selected: ${selectedTask.id} · Cwd: ${selectedTask.cwd ?? ""} · Log: ${selectedTask.logPath}`,
				),
			);
		}

		lines.push(
			this.theme.fg("dim", "↑/↓ select · h toggle history · c show path · a stop all · q/esc close"),
		);

		return lines.map((l) => truncateToWidth(l, width));
	}

	handleInput(data: string): void {
		const visible = this.getVisibleTasks();

		if (data === "q" || data === "\u001b") {
			this.done();
			return;
		}

		if (data === "h") {
			this.showHistory = !this.showHistory;
			this.actionMessage = undefined;
			this.confirmStopAllArmed = false;
			return;
		}

		if (data === "c") {
			const selected = visible[this.selectedIndex];
			if (selected) {
				this.actionMessage = `Log path: ${selected.logPath}`;
			}
			return;
		}

		if (data === "a" || data === "K") {
			if (!this.confirmStopAllArmed) {
				this.confirmStopAllArmed = true;
			} else {
				this.confirmStopAllArmed = false;
				void this.registry.stopAllRunning?.();
			}
			return;
		}

		if (data === "\x1b[A" || data === "\x1bOA") {
			// Up
			if (this.selectedIndex > 0) this.selectedIndex--;
			this.actionMessage = undefined;
			this.confirmStopAllArmed = false;
			return;
		}

		if (data === "\x1b[B" || data === "\x1bOB") {
			// Down
			if (this.selectedIndex < visible.length - 1) this.selectedIndex++;
			this.actionMessage = undefined;
			this.confirmStopAllArmed = false;
			return;
		}
	}

	invalidate(): void {}

	handleMouse?(event: TuiMouseEvent): { handled: boolean } | undefined {
		if (event.type === "wheel") {
			const delta = (event.wheelDelta ?? 0) !== 0 ? (event.wheelDelta! > 0 ? 1 : -1) : 0;
			const visible = this.getVisibleTasks();
			this.selectedIndex = Math.max(0, Math.min(visible.length - 1, this.selectedIndex + delta));
			return { handled: true };
		}
		return undefined;
	}

	setOutputLines(lines: string[]): void {
		this.outputLines = lines;
	}

	dispose(): void {
		// Clean up
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
