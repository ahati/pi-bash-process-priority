/**
 * DockEditor: `CustomEditor` subclass that manages keyboard focus between
 * the pi editor input and the background tasks dock / master-detail view.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { CustomEditorOptions } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import type { BgTask } from "./types.ts";
import { debugLog } from "./debug.ts";
import type { DockController } from "./ui/dock.ts";
import { enableTerminalMouse, parseMouseInput } from "./ui/terminal-mouse.ts";

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

	/** Classify an arrow key across legacy CSI, SS3, and Kitty-protocol encodings. */
	private static kittyArrow(data: string): "up" | "down" | "left" | "right" | undefined {
		const match = new RegExp("^\\u001b(?:O([ABCD])|\\[[0-9;:]*([ABCD]))$").exec(data);
		if (!match) return undefined;
		const letter = match[1] ?? match[2];
		return letter === "A" ? "up" : letter === "B" ? "down" : letter === "C" ? "right" : "left";
	}

	private static readonly DOWN_SEQUENCES = ["\x1b[B", "\x1bOB"];
	private static readonly UP_SEQUENCES = ["\x1b[A", "\x1bOA"];

	private isDown(data: string): boolean {
		return matchesKey(data, Key.down) || DockEditor.DOWN_SEQUENCES.includes(data) || DockEditor.kittyArrow(data) === "down";
	}
	private isUp(data: string): boolean {
		return matchesKey(data, Key.up) || DockEditor.UP_SEQUENCES.includes(data) || DockEditor.kittyArrow(data) === "up";
	}
	private isPageUp(data: string): boolean {
		return matchesKey(data, Key.pageUp) || /^\u001b\[5(;[0-9:]+)?~$/.test(data);
	}
	private isPageDown(data: string): boolean {
		return matchesKey(data, Key.pageDown) || /^\u001b\[6(;[0-9:]+)?~$/.test(data);
	}
	private isHome(data: string): boolean {
		return matchesKey(data, Key.home) || /^\u001b\[(H|1~|1;[0-9:]+H)$/.test(data);
	}
	private isEnd(data: string): boolean {
		return matchesKey(data, Key.end) || /^\u001b\[(F|4~|1;[0-9:]+F)$/.test(data);
	}

	handleInput(data: string): void {
		const mouse = parseMouseInput(data);
		if (mouse.sawMouse) {
			if (mouse.wheelDelta !== 0) {
				if (this.dock.isDetail?.()) {
					this.dock.scrollDetail?.(mouse.wheelDelta * 2);
					this.tui.requestRender();
					return;
				}
				this.dock.scrollList?.(mouse.wheelDelta, this.tui.terminal?.rows);
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (!this.dock.inDock()) {
			// ↓ on an empty editor enters dock mode
			if (this.isDown(data)) {
				if (this.getText().trim() !== "") {
					super.handleInput(data);
					return;
				}
				if (this.dock.enterDock()) {
					debugLog("dock-editor: ↓ entered dock mode");
					this.tui.requestRender();
					return;
				}
				super.handleInput(data);
				return;
			}

			// Esc on empty editor closes expanded /tasks view if showing
			if (this.getText().trim() === "") {
				const isEscape = matchesKey(data, Key.escape) || data === "\u001b" || /^\u001b\[1?27(;[0-9:]+)?u$/.test(data);
				if (isEscape) {
					if (this.dock.isDetail?.()) {
						this.dock.closeDetail?.();
						this.tui.requestRender();
						return;
					}
					if (this.dock.isExpanded?.()) {
						this.dock.collapseTasks?.();
						this.tui.requestRender();
						return;
					}
				}
			}

			super.handleInput(data);
			return;
		}

		debugLog("dock-editor: dock-mode key", JSON.stringify(data));

		// If all tasks vanished, exit dock mode cleanly
		if (!this.dock.isDetail?.() && !this.dock.selected()) {
			this.dock.exitDock();
			this.tui.requestRender();
			if (data !== "\u001b") super.handleInput(data);
			return;
		}

		// Ctrl+c safety valve
		if (data === "\x03") {
			super.handleInput(data);
			return;
		}

		// Escape closes expanded / detail view and exits dock mode
		const isEscape = matchesKey(data, Key.escape) || data === "\u001b" || /^\u001b\[1?27(;[0-9:]+)?u$/.test(data);
		if (isEscape) {
			if (this.dock.isExpanded?.()) {
				this.dock.collapseTasks?.();
			}
			if (this.dock.isDetail?.()) {
				this.dock.closeDetail?.();
			}
			this.dock.exitDock();
			this.tui.requestRender();
			return;
		}

		// Output log scrolling via PgUp / PgDn / Home / End
		if (this.isPageUp(data)) {
			this.dock.scrollDetail?.(-10);
			this.tui.requestRender();
			return;
		}
		if (this.isPageDown(data)) {
			this.dock.scrollDetail?.(10);
			this.tui.requestRender();
			return;
		}
		if (this.isHome(data)) {
			this.dock.scrollDetailTop?.();
			this.tui.requestRender();
			return;
		}
		if (this.isEnd(data)) {
			this.dock.scrollDetailBottom?.();
			this.tui.requestRender();
			return;
		}

		// ↑ navigation: moves selection up in task list, or exits to input if at top row
		if (this.isUp(data)) {
			if (this.dock.selectedIndex && this.dock.selectedIndex() <= 0) {
				debugLog("dock-editor: ↑ from top row — exiting dock mode to input box");
				this.dock.exitDock();
				this.tui.requestRender();
				return;
			}
			this.dock.move?.(-1, this.tui.terminal?.rows);
			this.tui.requestRender();
			return;
		}

		// ↓ navigation: moves selection down in task list
		if (this.isDown(data)) {
			this.dock.move?.(1, this.tui.terminal?.rows);
			this.tui.requestRender();
			return;
		}

		// Enter opens or refreshes detail for selected task
		const isEnter = matchesKey(data, Key.enter) || data === "\r" || /^\u001b\[1?3(;[0-9:]+)?u$/.test(data);
		if (isEnter) {
			const task = this.dock.selected?.() ?? this.dock.getDetailTask?.();
			if (task) {
				this.dock.openDetail?.(task);
				this.onOpenTask?.(task);
			} else {
				this.dock.exitDock();
			}
			this.tui.requestRender();
			return;
		}

		// 'k' terminates selected task
		if (data === "k") {
			const task = this.dock.selected?.() ?? this.dock.getDetailTask?.();
			if (task) this.onKillTask?.(task);
			this.tui.requestRender();
			return;
		}

		// All other keystrokes swallowed while dock mode owns keyboard
	}
}
