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

	// Arrow keys arrive in two encodings depending on the terminal's cursor-key
	// mode: CSI (`[B`) and SS3 (`OB`). matchesKey covers the configured
	// bindings; these raw forms are belt-and-braces for every terminal.
	private static readonly DOWN_SEQUENCES = ["[B", "OB"];
	private static readonly UP_SEQUENCES = ["[A", "OA"];

	private isDown(data: string): boolean {
		return matchesKey(data, Key.down) || DockEditor.DOWN_SEQUENCES.includes(data);
	}
	private isUp(data: string): boolean {
		return matchesKey(data, Key.up) || DockEditor.UP_SEQUENCES.includes(data);
	}

	handleInput(data: string): void {
		if (!this.dock.inDock()) {
			// ↓ on an empty editor falls through to the dock when it has rows.
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
				debugLog("dock-editor: ↓ but enterDock returned false (no running rows)");
				super.handleInput(data);
				return;
			}
			super.handleInput(data);
			return;
		}
		debugLog("dock-editor: dock-mode key", JSON.stringify(data));

		// Dock mode owns the keyboard.
		if (data === "\x03") {
			// ctrl+c is the app safety valve — always reaches pi.
			super.handleInput(data);
			return;
		}
		if (this.isUp(data)) {
			this.dock.move(-1);
			this.tui.requestRender();
			return;
		}
		if (this.isDown(data)) {
			this.dock.move(1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const task = this.dock.selected();
			if (task) this.onOpenTask?.(task);
			else this.dock.exitDock();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
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
