/**
 * DockEditor (§7.7): `CustomEditor` subclass that adds the ↓-from-empty-input
 * fall-through into dock mode and owns the keyboard while the dock has focus.
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

export class DockEditor extends CustomEditor {
	readonly dock: DockController;
	/** Wired by index.ts to open the Task Details panel for a task. */
	onOpenTask?: (task: BgTask) => void;
	/** Optional: `k` inside dock mode. */
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
	}

	getTui(): TUI {
		return this.tui;
	}

	/** Classify an arrow key across legacy CSI, SS3, and Kitty-protocol encodings. */
		private static kittyArrow(data: string): "up" | "down" | "left" | "right" | undefined {
		// ESC [ <mods> <letter>  (CSI / Kitty)  or  ESC O <letter>  (SS3)
		const match = new RegExp("^\\u001b(?:O([ABCD])|\\[[0-9;:]*([ABCD]))$").exec(data);
		if (!match) return undefined;
		const letter = match[1] ?? match[2];
		return letter === "A" ? "up" : letter === "B" ? "down" : letter === "C" ? "right" : "left";
	}

	private static readonly DOWN_SEQUENCES = ["[B", "OB"];
	private static readonly UP_SEQUENCES = ["[A", "OA"];

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
		if (!this.dock.inDock()) {
			// ↓ on an empty editor falls through to the dock when it has rows or detail is open.
			if (this.isDown(data)) {
				if (this.getText().trim() !== "") {
					debugLog("dock-editor: ↓ ignored (editor not empty)");
					super.handleInput(data);
					return;
				}
				if (this.dock.enterDock()) {
					debugLog("dock-editor: ↓ entered dock mode");
					this.tui.requestRender();
					return;
				}
				debugLog("dock-editor: ↓ but enterDock returned false (no running rows or detail)");
				super.handleInput(data);
				return;
			}
			// When detail view is showing below an empty editor, Esc closes detail view back to task list
			if (this.dock.isDetail?.() && this.getText().trim() === "") {
				const isEscape = matchesKey(data, Key.escape) || data === "\u001b" || /^\u001b\[1?27(;[0-9:]+)?u$/.test(data);
				if (isEscape) {
					this.dock.closeDetail?.();
					this.tui.requestRender();
					return;
				}
			}
			super.handleInput(data);
			return;
		}
		debugLog("dock-editor: dock-mode key", JSON.stringify(data));

		// Defensive: if the rows vanished (task finished/timed out on its own)
		// and no reconcile ran, do not trap the keyboard. Exit dock mode and
		// let the keystroke through to the real editor.
		if (!this.dock.isDetail?.() && !this.dock.selected()) {
			debugLog("dock-editor: dock mode had no selectable row — auto-exiting");
			this.dock.exitDock();
			this.tui.requestRender();
			if (data !== "\u001b") super.handleInput(data);
			return;
		}

		// Dock mode owns the keyboard.
		if (data === "\x03") {
			// ctrl+c is the app safety valve — always reaches pi.
			super.handleInput(data);
			return;
		}

		// Detail mode navigation (task details rendered below editor)
		if (this.dock.isDetail?.()) {
			const isEscape = matchesKey(data, Key.escape) || data === "\u001b" || /^\u001b\[1?27(;[0-9:]+)?u$/.test(data);
			if (isEscape) {
				this.dock.closeDetail?.();
				this.dock.exitDock?.();
				this.tui.requestRender();
				return;
			}
			if (this.isUp(data)) {
				const scrollInfo = this.dock.getDetailScroll?.();
				if (!scrollInfo || scrollInfo.scroll <= 0) {
					debugLog("dock-editor: ↑ from top of detail view — exiting dock mode to input box");
					this.dock.exitDock();
					this.tui.requestRender();
					return;
				}
				this.dock.scrollDetail?.(-1);
				this.tui.requestRender();
				return;
			}
			if (this.isDown(data)) {
				this.dock.scrollDetail?.(1);
				this.tui.requestRender();
				return;
			}
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
			if (data === "k") {
				const task = this.dock.getDetailTask?.();
				if (task) this.onKillTask?.(task);
				this.tui.requestRender();
				return;
			}
			return;
		}

		// List mode navigation
		if (this.isUp(data)) {
			// (a) Up arrow exits dock mode back to the input box when at top item
			if (this.dock.selectedIndex && this.dock.selectedIndex() <= 0) {
				debugLog("dock-editor: ↑ from top row — exiting dock mode to input box");
				this.dock.exitDock();
				this.tui.requestRender();
				return;
			}
			this.dock.move(-1);
			this.tui.requestRender();
			return;
		}
		if (this.isDown(data)) {
			this.dock.move(1);
			this.tui.requestRender();
			return;
		}
		const isEnter = matchesKey(data, Key.enter) || data === "\r" || /^\u001b\[1?3(;[0-9:]+)?u$/.test(data);
		if (isEnter) {
			const task = this.dock.selected();
			if (task) {
				if (this.dock.openDetail) {
					this.dock.openDetail(task);
				}
				this.onOpenTask?.(task);
			} else {
				this.dock.exitDock();
			}
			this.tui.requestRender();
			return;
		}
		const isEscape = matchesKey(data, Key.escape) || data === "\u001b" || /^\u001b\[1?27(;[0-9:]+)?u$/.test(data);
		if (isEscape) {
			this.dock.exitDock();
			this.tui.requestRender();
			return;
		}
		if (data === "k") {
			const task = this.dock.selected();
			if (task) this.onKillTask?.(task);
			this.tui.requestRender();
			return;
		}
		// Everything else is swallowed while the dock has focus.
	}
}
