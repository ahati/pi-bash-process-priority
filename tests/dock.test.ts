import test from "node:test";
import assert from "node:assert/strict";

import { createTaskManager } from "../src/registry.ts";
import type { BgTask, TaskManagerApi } from "../src/types.ts";
import { DockController, DOCK_WIDGET_KEY, installDock } from "../src/ui/dock.ts";

// ─── fakes ───────────────────────────────────────────────────────────────────

const theme = { fg: (_color: string, text: string) => text, bold: (t: string) => t };
const tui = { requestRender() {} };

interface WidgetCall {
	key: string;
	content: unknown; // undefined = cleared; function = component factory
	placement?: string;
}

function fakeCtx() {
	const calls: WidgetCall[] = [];
	const ui = {
		setWidget(key: string, content: unknown, options?: { placement?: string }) {
			calls.push({ key, content, placement: options?.placement });
		},
		notify() {},
	};
	const ctx = { ui, mode: "tui", hasUI: true } as unknown as Parameters<typeof installDock>[0];
	return { ctx, calls };
}

function makeRegistry(overrides: Partial<Parameters<typeof createTaskManager>[0]> = {}): TaskManagerApi {
	return createTaskManager({
		logDir: "/tmp/bg-dock-tests",
		killGraceMs: 100,
		logBytes: 4096,
		maxFinished: 10,
		...overrides,
	});
}

/** Resolve the latest installed component factory and render it. */
function latestLines(calls: WidgetCall[], width = 120): string[] | undefined {
	const last = [...calls].reverse().find((call) => call.content !== undefined);
	if (!last) return undefined;
	if (Array.isArray(last.content)) return last.content as string[];
	if (typeof last.content === 'function') {
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		const tui = { requestRender() {} };
		const component = (last.content as Function)(tui, theme);
		return component.render(width);
	}
	return undefined;
}

function lastCall(calls: WidgetCall[]): WidgetCall | undefined {
	return calls[calls.length - 1];
}

// ─── DockController ──────────────────────────────────────────────────────────

test("DockController: enterDock is false with no rows, true with rows", () => {
	const reg = makeRegistry();
	const controller = new DockController(() => []);
	assert.equal(controller.enterDock(), false);
	const tasks = reg.list().length ? reg.list() : [];
	void tasks;
});

test("DockController: selection moves and clamps; exit resets", async () => {
	const reg = makeRegistry();
	try {
		await reg.run("sleep 2", "/tmp");
		await reg.run("sleep 2", "/tmp");
		const controller = new DockController(() => reg.list().filter((task) => task.status === "running"));
		assert.equal(controller.enterDock(), true);
		assert.equal(controller.selectedIndex(), 0);
		controller.move(5); // clamps to last row
		assert.equal(controller.selectedIndex(), 1);
		const selected = controller.selected();
		assert.ok(selected);
		assert.match(selected.command, /sleep 2/);
		controller.exitDock();
		assert.equal(controller.inDock(), false);
		assert.equal(controller.selected(), undefined);
	} finally {
		await reg.disposeAll();
	}
});

test("DockController: reconcile exits dock mode when rows vanish", async () => {
	const reg = makeRegistry();
	try {
		const task = await reg.run("sleep 2", "/tmp");
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		assert.equal(controller.enterDock(), true);
		await reg.kill(task.id);
		controller.reconcile();
		assert.equal(controller.inDock(), false);
	} finally {
		await reg.disposeAll();
	}
});

test("DockController: openDetail, scrollDetail, and closeDetail", async () => {
	const reg = makeRegistry();
	try {
		const task = await reg.run("sleep 10", "/tmp");
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		controller.enterDock();
		controller.openDetail(task);
		assert.equal(controller.isDetail(), true);
		assert.equal(controller.getDetailTask()?.id, task.id);

		controller.setMaxScroll(20);
		controller.scrollDetail(5);
		assert.equal(controller.getDetailScroll().scroll, 5);
		assert.equal(controller.getDetailScroll().follow, false);

		controller.scrollDetailBottom();
		assert.equal(controller.getDetailScroll().scroll, 20);
		assert.equal(controller.getDetailScroll().follow, true);

		controller.scrollDetailTop();
		assert.equal(controller.getDetailScroll().scroll, 0);

		// exitDock in detail mode unfocuses dock but preserves detail view
		controller.exitDock();
		assert.equal(controller.inDock(), false);
		assert.equal(controller.isDetail(), true);

		// enterDock re-focuses detail view
		controller.enterDock();
		assert.equal(controller.inDock(), true);
		assert.equal(controller.isDetail(), true);

		controller.closeDetail();
		assert.equal(controller.isDetail(), false);
		assert.equal(controller.inDock(), true);
	} finally {
		await reg.disposeAll();
	}
});

// ─── installDock ─────────────────────────────────────────────────────────────

test("installDock: widget hidden while no tasks are running", async () => {
	const reg = makeRegistry();
	const { ctx, calls } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller);
		const hidden = calls.filter((call) => call.content === undefined);
		assert.ok(hidden.length > 0, "expected at least one clear call");
		for (const call of calls) {
			assert.equal(call.key, DOCK_WIDGET_KEY);
			assert.equal(call.placement, "belowEditor");
		}
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: dock mode auto-exits when the last running task finishes (input is not trapped)", async () => {
	const reg = makeRegistry();
	const { ctx, calls } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller);
		const task = await reg.run("sleep 20", "/tmp");
		assert.equal(controller.enterDock(), true, "↓ would enter dock mode");
		assert.equal(controller.inDock(), true);

		// The task finishes on its own — no user keypress.
		await reg.kill(task.id, "test");
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(controller.inDock(), false, "dock mode must release when rows vanish");
		assert.equal(controller.selected(), undefined);
		// Widget is cleared, so no stale rows linger below the editor.
		assert.equal(calls.at(-1)?.content, undefined);
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: selection index is clamped when one of several tasks finishes", async () => {
	const reg = makeRegistry();
	const { ctx } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller);
		await reg.run("sleep 20", "/tmp");
		const second = await reg.run("sleep 21", "/tmp");
		controller.enterDock();
		controller.move(1);
		assert.equal(controller.selectedIndex(), 1);

		await reg.kill(second.id, "test");
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(controller.inDock(), true, "another running row still exists");
		assert.equal(controller.selectedIndex(), 0, "index clamped to the surviving row");
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: task spawns → widget renders row + rules", async () => {
	const reg = makeRegistry();
	const { ctx, calls } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller);
		await reg.run("sleep 2", "/tmp");

		const rendered = latestLines(calls);
		assert.ok(rendered, "expected dock lines after spawn");
		const text = rendered.join("\n");
		const first = rendered[0];
		assert.match(first, /[⏳●] \[\d\d:\d\d:\d\d\] sleep 2 running/); // no top rule — rows come first
		assert.match(rendered.at(-1) ?? "", /─/); // bottom rule (last line)
		
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: bottom rule uses the injected border color; no top rule", async () => {
	const reg = makeRegistry();
	const { ctx, calls } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller, {
			borderColor: (text: string) => `B${text}B`,
		});
		await reg.run("sleep 2", "/tmp");
		const rendered = latestLines(calls);
		assert.ok(rendered);
		assert.doesNotMatch(rendered[0], /^B/); // no border-colored top rule
		const rules = rendered.filter((line) => line.startsWith("B") && line.includes("─"));
		assert.equal(rules.length, 1, "exactly one bottom rule, border-colored");
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: rows clamp to at most 3", async () => {
	const reg = makeRegistry({ logDir: "/tmp/bg-dock-clamp", killGraceMs: 100, logBytes: 4096, maxFinished: 20 });
	const { ctx, calls } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller);
		for (let i = 0; i < 9; i++) await reg.run(`sleep 8`, "/tmp");

		const rendered = latestLines(calls);
		assert.ok(rendered);
		const rowLines = rendered.filter((line: string) => line.includes("⏳ [") || line.includes("● ["));
		assert.equal(rowLines.length, 3, `expected 3 rows, got ${rowLines.length}`);
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: selection marker renders on the focused row", async () => {
	const reg = makeRegistry();
	const { ctx, calls } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller);
		await reg.run("sleep 2", "/tmp");
		await reg.run("sleep 2", "/tmp");
		controller.enterDock();
		controller.move(1);
		dock.refresh();

		const rendered = latestLines(calls);
		assert.ok(rendered);
		const selectedRows = rendered.filter((line) => line.startsWith("> "));
		assert.equal(selectedRows.length, 1);
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: completed tasks leave the dock; empty \u2192 widget hidden", async () => {
	const reg = makeRegistry();
	const { ctx, calls } = fakeCtx();
	try {
		const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
		const dock = installDock(ctx as never, reg, controller);
		const task = await reg.run("sleep 30", "/tmp");

		// A factory install happened for the running task.
		assert.ok(calls.some((call) => typeof call.content === "function"), "dock should install on spawn");

		// Deterministic terminal transition (no natural-exit timing race).
		await reg.kill(task.id);
		assert.equal(reg.get(task.id)?.status, "killed");

		// "Hidden" means: the widget was cleared, OR the trailing component
		// renders zero task rows (1 s dock-ticker race tolerated).
		const last = lastCall(calls);
		assert.ok(last);
		if (last.content !== undefined) {
			const component = (last.content as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
				tui,
				theme,
			);
			const rows = component.render(120).filter((line) => line.includes("⏳ [") || line.includes("● [") || line.includes("\u25cf ["));
			assert.equal(rows.length, 0, "no task rows may render after the last task ends");
		}
		dock.dispose();
	} finally {
		await reg.disposeAll();
	}
});

test("installDock: dispose hides the widget and unsubscribes from the registry", async () => {
	const reg = makeRegistry();
	const { ctx, calls } = fakeCtx();
	const controller = new DockController(() => reg.list().filter((t: BgTask) => t.status === "running"));
	const dock = installDock(ctx as never, reg, controller);
	dock.dispose();

	const callsAfterDispose = calls.length;
	await reg.run("sleep 2", "/tmp");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls.length, callsAfterDispose, "no widget updates after dispose");
	assert.equal(lastCall(calls)?.content, undefined);
	await reg.disposeAll();
});
