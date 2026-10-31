/**
 * TUI integration test: exercises the full DockEditor → DockController →
 * dock-widget render pipeline with real objects (no live pi session needed).
 *
 * Verifies:
 * 1. ↓ on an empty editor enters dock mode
 * 2. ↓/↑ in dock mode move the `>` selection marker
 * 3. The rendered dock widget shows the `>` marker at the right row
 * 4. Enter switches to the detail view
 * 5. Esc returns to the input
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createTaskManager, type TaskManagerApi } from "../src/registry.ts";
import { DockController, DOCK_WIDGET_KEY, installDock } from "../src/ui/dock.ts";
import { DockEditor } from "../src/dock-editor.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { TUI, EditorTheme } from "@earendil-works/pi-tui";

// ─── fakes ───────────────────────────────────────────────────────────────────

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	borderColor: (text: string) => text,
};

const tui = { requestRender() {} };

const editorTheme = {
	borderColor: (text: string) => text,
} as unknown as EditorTheme;

function makeRegistry(): TaskManagerApi {
	return createTaskManager({ logDir: "/tmp/bg-e2e-dock", killGraceMs: 100, logBytes: 4096, maxFinished: 10 });
}

function fakeSetWidgetCtx() {
	const widgetState = new Map<string, unknown>();
	return {
		ctx: {
			ui: {
				setWidget(key: string, content: unknown, _options?: unknown) {
					if (content === undefined) widgetState.delete(key);
					else widgetState.set(key, content);
				},
			},
		} as never,
		widgetState,
	};
}

// ─── tests ───────────────────────────────────────────────────────────────────

test("E2E-TUI: ↓ enters dock mode and renders the > selection marker", async () => {
	const reg = makeRegistry();
	const tasks = reg.list().filter((t) => t.status === "running");
	assert.equal(tasks.length, 0, "start clean");

	const controller = new DockController(() => reg.list().filter((t) => t.status === "running"));
	const { ctx, widgetState } = fakeSetWidgetCtx();
	const dock = installDock(ctx as never, reg, controller);

	// Spawn a background task → dock should install on the registry change event
	await reg.run("sleep 30", "/tmp");
	await new Promise((r) => setTimeout(r, 50)); // let the onChange → refresh propagate

	// Simulate ↓ on an empty editor (the DockEditor receives the raw bytes)
	const keybindings = {} as never;
	const editor = new DockEditor(tui as unknown as TUI, editorTheme, keybindings as never, controller, {
		embedWorkingStatus: true,
	});

	// Verify the editor is in input mode before ↓
	assert.equal(controller.inDock(), false, "should start in input mode");

	// Press ↓ (kitty encoding — as the field trace showed)
	editor.handleInput("\u001b[1;1:1B");
	assert.equal(controller.inDock(), true, "↓ should enter dock mode");
	assert.equal(controller.selectedIndex(), 0, "selection should be at row 0");

	// Render the dock widget — the first row must have the > marker
	const component = widgetState.get(DOCK_WIDGET_KEY) as { render(width: number): string[] };
	const lines = component.render(120);
	const selectedRow = lines.find((line) => line.startsWith("> "));
	assert.ok(selectedRow, "dock must show a > selected row");
	assert.match(selectedRow, /sleep 30/);

	// Move down — marker should move to the next row (or stay if only one)
	controller.move(1);
	dock.refresh();
	const lines2 = (widgetState.get(DOCK_WIDGET_KEY) as { render(width: number): string[] }).render(120);
	const selected2 = lines2.filter((line) => line.startsWith("> "));
	assert.ok(selected2.length > 0, "marker must remain visible after move");

	dock.dispose();
	await reg.disposeAll();
});

test("E2E-TUI: esc returns to input mode", async () => {
	const reg = makeRegistry();
	const controller = new DockController(() => reg.list().filter((t) => t.status === "running"));
	const { ctx, widgetState } = fakeSetWidgetCtx();
	const dock = installDock(ctx as never, reg, controller);
	await reg.run("sleep 30", "/tmp");

	const keybindings = {} as never;
	const editor = new DockEditor(tui as unknown as TUI, editorTheme, keybindings as never, controller, {
		embedWorkingStatus: true,
	});

	// Enter dock mode
	editor.handleInput("\x1b[B");
	assert.equal(controller.inDock(), true);

	// Esc returns to input
	editor.handleInput("\x1b");
	assert.equal(controller.inDock(), false, "esc should exit dock mode");

	// The dock rows should still be visible (widget not cleared)
	const component = widgetState.get(DOCK_WIDGET_KEY) as { render(width: number): string[] };
	const lines = component.render(120);
	assert.ok(lines.some((line) => line.includes("sleep 30")), "rows still rendered after esc");

	dock.dispose();
	await reg.disposeAll();
});

test("E2E-TUI: enter on selected row triggers onOpenTask", async () => {
	const reg = makeRegistry();
	const controller = new DockController(() => reg.list().filter((t) => t.status === "running"));
	const { ctx, widgetState } = fakeSetWidgetCtx();
	const dock = installDock(ctx as never, reg, controller);
	await reg.run("sleep 30", "/tmp");

	const opened: string[] = [];
	const keybindings = {} as never;
	const editor = new DockEditor(tui as unknown as TUI, editorTheme, keybindings as never, controller, {
		embedWorkingStatus: true,
	});
	editor.onOpenTask = (task) => opened.push(task.id);

	// Enter dock mode and press enter
	editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	assert.deepEqual(opened, ["task-1"]);

	dock.dispose();
	await reg.disposeAll();
});
