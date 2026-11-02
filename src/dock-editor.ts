/**
 * DockEditor: `CustomEditor` subclass that manages keyboard focus between
 * the pi editor input and the background tasks dock / master-detail view.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { CustomEditorOptions } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import type { BgTask } from "./types.ts";
import { type DockController, handleDockInput } from "./ui/dock.ts";
import { enableTerminalMouse } from "./ui/terminal-mouse.ts";

export class DockEditor extends CustomEditor {
	readonly dock: DockController;
	/** Wired by index.ts to open or focus a task. */
	onOpenTask?: (task: BgTask) => void;
	/** Wired by index.ts to kill a task (`k` key in dock mode). */
	onKillTask?: (task: BgTask) => void;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		dock: DockController,
		options?: CustomEditorOptions,
	) {
		super(tui, theme, keybindings, options);
		this.dock = dock;
		enableTerminalMouse(this.tui);
	}

	getTui(): TUI {
		return this.tui;
	}

	isInDock(): boolean {
		return this.dock.inDock();
	}
	isDockActive(): boolean {
		return this.dock.inDock();
	}
	isDetail(): boolean {
		return this.dock.isDetail?.() ?? false;
	}
	isExpanded(): boolean {
		return this.dock.isExpanded?.() ?? false;
	}
	hasTasks(): boolean {
		return (this.dock.getTasks?.() ?? []).length > 0;
	}
	taskCount(): number {
		return (this.dock.getTasks?.() ?? []).length;
	}

	handleInput(data: string): void {
		const result = handleDockInput(
			data,
			{ getEditorText: () => this.getText() },
			this.dock,
			undefined,
			() => this.tui,
			{
				onOpenTask: this.onOpenTask,
				onKillTask: this.onKillTask,
			},
		);
		if (result?.consume) return;
		super.handleInput(data);
	}
}
