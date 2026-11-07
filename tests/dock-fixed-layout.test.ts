/**
 * PRD-007 Approach A tests: fixed two-panel layout + the height cap (idea 1)
 * and the two-axis resize (idea 2).
 *
 * Covers:
 * 1. computeLayout math — the 50% height cap, metadata flex, pane floors,
 *    default split, degraded tiny terminals, and boundary consistency.
 * 2. height invariance — the flicker fix: the expanded widget renders exactly
 *    `totalRows` lines across selection changes, task-count changes, and the
 *    async tail-read window (G1 + G2).
 * 3. resize — keyboard (+/-, [ / ]), the split handle drag, and the top-rule
 *    height grip drag (press → capture, drag, release).
 * 4. the block grip (U+25AC) on the header rule adapts to terminal width.
 * 5. parseMouseInput press/motion/release (regular-mode groundwork).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	clampToRange,
	computeLayout,
	DOCK_CHROME_NO_META_ROWS,
	DOCK_DEFAULT_MAX_HEIGHT_SHARE,
	DOCK_FIXED_ROWS,
	DOCK_MIN_PANE_ROWS,
	resolveDockMaxHeightShare,
	resolveTermHeight,
} from "../src/ui/dock-layout.ts";
import { formatDockStatusLine, formatHeaderLine, formatResizeHandle, GRIP_CHAR } from "../src/ui/format.ts";
import { parseMouseInput } from "../src/ui/terminal-mouse.ts";
import { DockController, handleDockInput, installDock } from "../src/ui/dock.ts";
import type { BgTask } from "../src/types.ts";

function makeTask(overrides: Partial<BgTask> = {}): BgTask {
	return {
		id: "task-1",
		command: "sleep 10",
		status: "running",
		pid: 123,
		pgid: 123,
		startedAt: 1700000000000,
		endedAt: null,
		exitCode: null,
		signal: null,
		logPath: "/tmp/test.log",
		origin: "bg_task",
		...overrides,
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// ─── computeLayout ───────────────────────────────────────────────────────────

test("resolveTermHeight: positive args pass through, fallbacks apply", () => {
	assert.equal(resolveTermHeight(30), 30);
	const fallback = resolveTermHeight(undefined);
	assert.ok(fallback > 0);
});

test("clampToRange: rounds and clamps", () => {
	assert.equal(clampToRange(5, 1, 10), 5);
	assert.equal(clampToRange(-3, 1, 10), 1);
	assert.equal(clampToRange(99, 1, 10), 10);
	assert.equal(clampToRange(2.6, 1, 10), 3);
	assert.equal(clampToRange(Number.NaN, 1, 10), 1);
});

test("resolveDockMaxHeightShare: parses numbers, percentages, and clamps", () => {
	assert.equal(resolveDockMaxHeightShare(undefined), DOCK_DEFAULT_MAX_HEIGHT_SHARE);
	assert.equal(resolveDockMaxHeightShare("0.5"), 0.5);
	assert.equal(resolveDockMaxHeightShare("50%"), 0.5);
	assert.equal(resolveDockMaxHeightShare("0.72"), 0.72);
	assert.equal(resolveDockMaxHeightShare("not-a-number"), DOCK_DEFAULT_MAX_HEIGHT_SHARE);
	assert.equal(resolveDockMaxHeightShare(""), DOCK_DEFAULT_MAX_HEIGHT_SHARE);
	assert.equal(resolveDockMaxHeightShare(5), 0.9);
	assert.equal(resolveDockMaxHeightShare(0.05), 0.2);
});

test("computeLayout: default split honors the height cap", () => {
	// 40 rows: cap = floor(40 * 0.5) = 20 rows. Metadata keeps its full six
	// rows (20 - 8 chrome - 1 title - 4 pane reserve = 7 > 6), so chrome = 15,
	// the pane budget is 5, and the default split is 2 list + 3 output.
	const m = computeLayout(40);
	assert.equal(m.degraded, false);
	assert.equal(m.totalRows, 20);
	assert.equal(m.totalRows, Math.floor(40 * DOCK_DEFAULT_MAX_HEIGHT_SHARE));
	assert.equal(m.chromeRows, DOCK_FIXED_ROWS);
	assert.equal(m.metaRows, 6);
	assert.equal(m.detailTitleRows, 1);
	assert.equal(m.listRows, 2);
	assert.equal(m.outputRows, 3);
	assert.equal(m.minTotalRows, DOCK_FIXED_ROWS + 2);
	assert.equal(m.maxTotalRows, 20);
	assert.equal(m.capTotalRows, 20);
});

test("computeLayout: requested list rows override the default and clamp", () => {
	const m = computeLayout(40, 3);
	assert.equal(m.listRows, 3);
	assert.equal(m.outputRows, 2);
	assert.equal(m.totalRows, 20);

	const maxed = computeLayout(40, 999);
	assert.equal(maxed.listRows, maxed.maxListRows);
	assert.equal(maxed.outputRows, DOCK_MIN_PANE_ROWS);
	assert.equal(maxed.totalRows, 20);

	const floored = computeLayout(40, 0);
	assert.equal(floored.listRows, DOCK_MIN_PANE_ROWS);
	assert.equal(floored.outputRows, 4);
});

test("computeLayout: requested total rows clamp to the cap and the pane floor", () => {
	const base = computeLayout(60);
	assert.equal(base.totalRows, 30);
	assert.equal(base.minTotalRows, 17);

	assert.equal(computeLayout(60, undefined, { totalRows: 20 }).totalRows, 20);
	assert.equal(computeLayout(60, undefined, { totalRows: 1 }).totalRows, base.minTotalRows);
	assert.equal(computeLayout(60, undefined, { totalRows: 999 }).totalRows, base.maxTotalRows);
});

test("computeLayout: maxHeightShare overrides the cap and is clamped", () => {
	const tight = computeLayout(60, undefined, { maxHeightShare: 0.3 });
	assert.equal(tight.totalRows, 18);

	const loose = computeLayout(60, undefined, { maxHeightShare: 0.9 });
	assert.equal(loose.totalRows, 54);
	assert.equal(computeLayout(60, undefined, { maxHeightShare: 5 }).totalRows, 54);
});

test("computeLayout: the height cap holds at every terminal size that can fit the floor", () => {
	for (let rows = 20; rows <= 120; rows++) {
		const m = computeLayout(rows);
		assert.ok(
			m.totalRows <= Math.floor(rows * DOCK_DEFAULT_MAX_HEIGHT_SHARE),
			`${rows} rows → ${m.totalRows} rows exceeds the 50% cap`,
		);
		assert.ok(m.totalRows >= m.minTotalRows, `${rows} rows → below the pane floor`);
		assert.ok(m.totalRows <= m.maxTotalRows, `${rows} rows → above the drag ceiling`);
	}

	// Below the absolute floor the widget is marked degraded and takes the
	// floor (the cap cannot be honored without hiding the widget entirely).
	for (const rows of [10, 12, 16, 18]) {
		const m = computeLayout(rows);
		assert.equal(m.degraded, true);
		assert.equal(m.totalRows, m.minTotalRows);
	}
});

test("computeLayout: metadata flexes before the cap is exceeded", () => {
	assert.equal(computeLayout(44).metaRows, 6);
	assert.equal(computeLayout(40).metaRows, 6);
	assert.equal(computeLayout(34).metaRows, 4);
	assert.equal(computeLayout(30).metaRows, 2);
	assert.equal(computeLayout(24).metaRows, 0);
	assert.equal(computeLayout(24).detailTitleRows, 0);
	assert.equal(computeLayout(24).totalRows, 12);
	assert.equal(computeLayout(24).degraded, false);
});

test("computeLayout: a dragged height re-clamps when the terminal shrinks", () => {
	const dragged = computeLayout(80, undefined, { totalRows: 30 });
	assert.equal(dragged.totalRows, 30);

	// Same stored drag value, smaller terminal → clamped to the new 50% cap.
	const shrunk = computeLayout(40, undefined, { totalRows: 30 });
	assert.equal(shrunk.totalRows, 20);
	assert.ok(shrunk.totalRows <= Math.floor(40 * DOCK_DEFAULT_MAX_HEIGHT_SHARE));

	// Growing the terminal back restores the user's height.
	assert.equal(computeLayout(80, undefined, { totalRows: 30 }).totalRows, 30);
});

test("computeLayout: row boundaries are mutually consistent", () => {
	for (const rows of [24, 30, 40, 80, 120]) {
		const m = computeLayout(rows, undefined);
		assert.equal(m.headerRows, 3);
		assert.equal(m.listStart, m.headerRows);
		assert.equal(m.listEnd, m.listStart + m.listRows);
		assert.equal(m.handleIndex, m.listEnd);
		assert.equal(m.detailTitleIndex, m.handleIndex + 1);
		assert.equal(m.metaStart, m.detailTitleIndex + m.detailTitleRows);
		assert.equal(m.ruleIndex, m.metaStart + m.metaRows);
		assert.equal(m.outputTitleIndex, m.ruleIndex + 1);
		assert.equal(m.outputStart, m.outputTitleIndex + 2);
		assert.equal(m.statusIndex, m.outputStart + m.outputRows);
		assert.equal(m.totalRows, m.statusIndex + 1);
		assert.equal(m.chromeRows, DOCK_CHROME_NO_META_ROWS + m.detailTitleRows + m.metaRows);
		assert.equal(m.totalRows, m.chromeRows + m.listRows + m.outputRows);
	}
});

test("computeLayout: degraded tiny terminals keep one row per pane", () => {
	const m = computeLayout(16);
	assert.equal(m.degraded, true);
	assert.equal(m.listRows, 1);
	assert.equal(m.outputRows, 1);
	assert.equal(m.totalRows, m.minTotalRows);
	assert.equal(m.totalRows, m.chromeRows + 2);
});

test("formatHeaderLine: grip renders a U+25AC block bar that adapts to width", () => {
	const wide = formatHeaderLine("Background Tasks", 80, theme, "3 tasks", undefined, { grip: true });
	assert.ok(wide.includes(GRIP_CHAR.repeat(10)), "full ten-block grip on a wide terminal");
	assert.equal(visibleWidth(wide), 80);

	const medium = formatHeaderLine("Background Tasks", 30, theme, undefined, undefined, { grip: true });
	assert.ok(medium.includes(GRIP_CHAR.repeat(8)), "grip shrinks with the terminal width");
	assert.equal(visibleWidth(medium), 30);

	const plain = formatHeaderLine("Background Tasks", 80, theme, "3 tasks");
	assert.ok(!plain.includes(GRIP_CHAR), "no grip unless requested");
});

test("formatDockStatusLine: sheds optional hints on narrow terminals, keeps esc", () => {
	const hints = ["↑/↓ select", "+/- resize", "[/] height", "Home/End log", "k kill", "esc close"];
	const wide = formatDockStatusLine("following tail 1.2KB", hints, 140);
	assert.ok(wide.includes("[/] height") && wide.includes("+/- resize") && wide.includes("esc close"));
	assert.ok(visibleWidth(wide) <= 140);

	const narrow = formatDockStatusLine("following tail 1.2KB", hints, 60);
	assert.ok(narrow.includes("esc close"), "escape hint survives the squeeze");
	assert.ok(!narrow.includes("↑/↓ select"), "arrow hint is dropped first");
	assert.ok(visibleWidth(narrow) <= 60);

	const tiny = formatDockStatusLine("following tail 1.2KB", hints, 24);
	assert.ok(visibleWidth(tiny) <= 24);
});

test("formatResizeHandle: one full-width dim row with the resize glyph", () => {
	const handle = formatResizeHandle(60, theme);
	assert.ok(handle.includes("⇕"));
	assert.ok(handle.includes("drag or +/- to resize"));
});

// ─── Height invariance (the flicker fix) ─────────────────────────────────────

interface WidgetCall {
	content: unknown;
}

function fakeInstall() {
	const calls: WidgetCall[] = [];
	const ctx = {
		ui: {
			setWidget(_key: string, content: unknown, _options?: unknown) {
				calls.push({ content });
			},
		},
	};
	const registry = {
		list: () => [],
		onChange: () => () => {},
	};
	return { ctx, registry, calls };
}

function latestWidget(
	calls: WidgetCall[],
	tuiOrRows: number | { terminal: { rows: number }; requestRender(): void } = 40,
): { render(width: number): string[] } | undefined {
	const last = [...calls].reverse().find((c) => typeof c.content === "function");
	if (!last) return undefined;
	const tui = typeof tuiOrRows === "number" ? { terminal: { rows: tuiOrRows }, requestRender() {} } : tuiOrRows;
	return (last.content as Function)(tui, theme);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll renders until the predicate holds (the tail read is async). */
async function renderUntil(
	widget: { render(width: number): string[] },
	width: number,
	predicate: (lines: string[]) => boolean,
	timeoutMs = 3000,
): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const lines = widget.render(width);
		if (predicate(lines) || Date.now() >= deadline) return lines;
		await delay(10);
	}
}

test("expanded widget height is invariant across selection changes and async tail reads", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prd007-"));
	const logA = join(dir, "task-1.log");
	const logB = join(dir, "task-2.log");
	const lines = (tag: string) =>
		Array.from({ length: 40 }, (_, i) => `${tag} log line ${i + 1}`).join("\n") + "\n";
	writeFileSync(logA, lines("alpha"));
	writeFileSync(logB, lines("beta"));

	const tasks = [
		makeTask({ id: "task-1", name: "alpha", command: "run alpha", logPath: logA, cwd: "/a" }),
		makeTask({ id: "task-2", name: "beta", command: "run beta", logPath: logB, cwd: "/b" }),
	];
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");

	const { ctx, registry, calls } = fakeInstall();
	const dock = installDock(ctx as never, registry as never, controller);
	const widget = latestWidget(calls);
	assert.ok(widget, "widget factory should be installed after expand");

	// First render triggers the async tail read; once it lands the height
	// must stay put.
	widget.render(120);
	const linesA = await renderUntil(widget, 120, (l) => l.some((x) => x.includes("alpha log line")));
	const height = linesA.length;
	const metrics = controller.getLayoutMetrics(40);
	assert.equal(height, metrics.totalRows, "render must match metrics.totalRows");
	assert.ok(linesA.some((l) => l.includes("alpha log line")), "tail of task-1 renders");

	// Selection change → second task. The immediate render (before the async
	// read lands) and the post-read render must have identical geometry.
	controller.move(1);
	const linesBImmediate = widget.render(120);
	assert.equal(linesBImmediate.length, height, "height stable during the async gap (RC-1)");
	const linesB = await renderUntil(widget, 120, (l) => l.some((x) => x.includes("beta log line")));
	assert.equal(linesB.length, height, "height stable after the tail read lands");
	assert.ok(linesB.some((l) => l.includes("beta log line")), "tail of task-2 renders");
	assert.ok(linesB.some((l) => l.includes("run beta")), "metadata re-binds to task-2");

	// Back to task-1 — served from the tail cache.
	controller.move(-1);
	const linesA2Immediate = widget.render(120);
	assert.equal(linesA2Immediate.length, height);
	const linesA2 = await renderUntil(widget, 120, (l) => l.some((x) => x.includes("alpha log line")));
	assert.equal(linesA2.length, height);
	assert.ok(linesA2.some((l) => l.includes("alpha log line")), "cache serves task-1 again");

	dock.dispose();
});

test("expanded widget height is invariant across task-count changes", () => {
	const tasks = [makeTask({ id: "task-1", name: "a" })];
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks();
	const { ctx, registry, calls } = fakeInstall();
	const dock = installDock(ctx as never, registry as never, controller);
	const widget = latestWidget(calls);
	assert.ok(widget);

	const height = widget.render(120).length;
	const metrics = controller.getLayoutMetrics(40);
	assert.equal(height, metrics.totalRows);

	// Spawn more tasks — the list pads/clips, nothing below moves.
	tasks.push(makeTask({ id: "task-2", name: "b" }), makeTask({ id: "task-3", name: "c" }));
	const heightAfter = widget.render(120).length;
	assert.equal(heightAfter, height);

	dock.dispose();
});

test("expanded widget re-adjusts when the terminal is resized", () => {
	const tasks = Array.from({ length: 12 }, (_, i) =>
		makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }),
	);
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	const { ctx, registry, calls } = fakeInstall();
	const dock = installDock(ctx as never, registry as never, controller);
	const tui = { terminal: { rows: 40 }, requestRender() {} };
	const widget = latestWidget(calls, tui);
	assert.ok(widget);

	const tall = widget.render(120);
	assert.equal(tall.length, controller.getLayoutMetrics(40).totalRows);
	assert.equal(tall.length, 20);

	// Same widget instance, smaller terminal → the cap shrinks with it and the
	// metadata group flexes out.
	tui.terminal.rows = 24;
	const resized = widget.render(120);
	assert.equal(resized.length, controller.getLayoutMetrics(24).totalRows);
	assert.equal(resized.length, 12);
	assert.equal(resized.length, Math.floor(24 * DOCK_DEFAULT_MAX_HEIGHT_SHARE));
	assert.ok(controller.getLayoutMetrics(24).metaRows < controller.getLayoutMetrics(40).metaRows);

	// Growing the terminal back restores the larger layout.
	tui.terminal.rows = 40;
	assert.equal(widget.render(120).length, 20);

	dock.dispose();
});

// ─── Resize: keyboard ────────────────────────────────────────────────────────

function makeHandleInputHarness(rows = 40) {
	const tasks = Array.from({ length: 10 }, (_, i) =>
		makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }),
	);
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	const getTui = () => ({ terminal: { rows }, requestRender() {} }) as never;
	return { controller, getTui };
}

test("handleDockInput: +/- resizes the master-list pane within clamps", () => {
	const { controller, getTui } = makeHandleInputHarness();
	const before = controller.getMaxVisible(40);
	assert.equal(before, 2);

	assert.equal(handleDockInput("+", {}, controller, undefined, getTui)?.consume, true);
	assert.equal(controller.getMaxVisible(40), before + 1);
	assert.equal(controller.getOutputRows(40), computeLayout(40).outputRows - 1);

	assert.equal(handleDockInput("-", {}, controller, undefined, getTui)?.consume, true);
	assert.equal(controller.getMaxVisible(40), before);

	// Hammering "-" clamps at the absolute pane floor without going below it.
	for (let i = 0; i < 10; i++) handleDockInput("-", {}, controller, undefined, getTui);
	assert.equal(controller.getMaxVisible(40), DOCK_MIN_PANE_ROWS);
	assert.equal(controller.getOutputRows(40), computeLayout(40).outputRows + 1);
});

test("handleDockInput: [ / ] resize the whole widget inside the height cap", () => {
	const { controller, getTui } = makeHandleInputHarness(60);
	const start = controller.getLayoutMetrics(60);
	assert.equal(start.totalRows, 30);

	assert.equal(handleDockInput("[", {}, controller, undefined, getTui)?.consume, true);
	assert.equal(controller.getLayoutMetrics(60).totalRows, start.totalRows - 1);
	// The first height resize pins the split: the output pane absorbs it.
	assert.equal(controller.getMaxVisible(60), start.listRows);
	assert.equal(controller.getOutputRows(60), start.outputRows - 1);

	for (let i = 0; i < 40; i++) handleDockInput("[", {}, controller, undefined, getTui);
	assert.equal(controller.getLayoutMetrics(60).totalRows, start.minTotalRows);

	for (let i = 0; i < 40; i++) handleDockInput("]", {}, controller, undefined, getTui);
	assert.equal(controller.getLayoutMetrics(60).totalRows, start.totalRows);
});

test("DockController: resizeTotal is a no-op outside the expanded view", () => {
	const tasks = [makeTask({ id: "task-1" })];
	const controller = new DockController(() => tasks, () => tasks);
	assert.equal(controller.resizeTotal(1, 40), false);
	controller.expandTasks();
	assert.equal(controller.resizeTotal(1, 40), false, "already at the cap");
	assert.equal(controller.resizeTotal(-1, 40), true);
	assert.equal(controller.getLayoutMetrics(40).totalRows, 19);
});

// ─── Resize: mouse drag ─────────────────────────────────────────────────────

function makeMouseHarness(rows = 40) {
	const tasks = Array.from({ length: 3 }, (_, i) =>
		makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }),
	);
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	const { ctx, registry, calls } = fakeInstall();
	const dock = installDock(ctx as never, registry as never, controller);
	const widget = latestWidget(calls, rows);
	assert.ok(widget);
	return { controller, dock, widget };
}

const mouseBase = {
	button: "left" as const,
	x: 10,
	screenX: 10,
	width: 120,
	shift: false,
	alt: false,
	ctrl: false,
};

test("handleMouse: press on the split handle captures, drag resizes, release ends", () => {
	const { controller, dock, widget } = makeMouseHarness();
	try {
		const metrics = controller.getLayoutMetrics(40);
		const startScreenY = 100;

		const press = (widget as any).handleMouse({
			...mouseBase,
			type: "press",
			y: metrics.handleIndex,
			screenY: startScreenY,
			height: 40,
		});
		assert.deepEqual(press, { handled: true, capture: true });
		assert.equal(controller.isHandleDragActive(), true);
		assert.equal(controller.isHeightDragActive(), false);

		// Drag down 2 rows → list pane grows by 2 (output absorbs it).
		(widget as any).handleMouse({
			...mouseBase,
			type: "drag",
			y: metrics.handleIndex + 2,
			screenY: startScreenY + 2,
			height: 40,
		});
		assert.equal(controller.getMaxVisible(40), metrics.listRows + 2);
		assert.equal(controller.getOutputRows(40), metrics.outputRows - 2);
		assert.equal(controller.getLayoutMetrics(40).totalRows, metrics.totalRows, "split drag keeps the total");

		const release = (widget as any).handleMouse({
			...mouseBase,
			type: "release",
			y: metrics.handleIndex + 2,
			screenY: startScreenY + 2,
			height: 40,
		});
		assert.equal((release as any).handled, true);
		assert.equal(controller.isHandleDragActive(), false);
	} finally {
		dock.dispose();
	}
});

test("handleMouse: dragging the top rule changes total height, capped at 50%", () => {
	const { controller, dock, widget } = makeMouseHarness();
	try {
		const start = controller.getLayoutMetrics(40);
		assert.equal(start.totalRows, 20);

		const press = (widget as any).handleMouse({
			...mouseBase,
			type: "press",
			y: 0,
			screenY: 100,
			height: 40,
		});
		assert.deepEqual(press, { handled: true, capture: true });
		assert.equal(controller.isHeightDragActive(), true);

		// Drag down 1 → the top edge moves down, the dock shrinks by one row.
		(widget as any).handleMouse({
			...mouseBase,
			type: "drag",
			y: 1,
			screenY: 101,
			height: 40,
		});
		assert.equal(controller.getLayoutMetrics(40).totalRows, 19);
		assert.equal(controller.getLayoutMetrics(40).outputRows, start.outputRows - 1);
		assert.equal(widget.render(120).length, 19, "render follows the dragged height");

		// Dragging up past the cap is a no-op: 50% is the hard ceiling.
		(widget as any).handleMouse({
			...mouseBase,
			type: "drag",
			y: 0,
			screenY: 60,
			height: 40,
		});
		assert.equal(controller.getLayoutMetrics(40).totalRows, 20);
		assert.equal(widget.render(120).length, 20);

		// Dragging far down clamps at the pane floor.
		(widget as any).handleMouse({
			...mouseBase,
			type: "drag",
			y: 30,
			screenY: 200,
			height: 40,
		});
		assert.equal(controller.getLayoutMetrics(40).totalRows, start.minTotalRows);

		(widget as any).handleMouse({
			...mouseBase,
			type: "release",
			y: 30,
			screenY: 200,
			height: 40,
		});
		assert.equal(controller.isHandleDragActive(), false);
	} finally {
		dock.dispose();
	}
});

test("handleMouse: wheel routes by layout region; click only selects real rows", () => {
	const { controller, dock, widget } = makeMouseHarness(80);
	try {
		const metrics = controller.getLayoutMetrics(80);
		const base = { ...mouseBase, height: 80 };

		// Wheel over the list region → list scroll (no selection move).
		const before = controller.selectedIndex();
		(widget as any).handleMouse({ ...base, type: "wheel", y: metrics.listStart, wheelDelta: 1 });
		assert.equal(controller.selectedIndex(), before, "wheel does not move the selection");

		// Wheel over the output region → log scroll (leaves follow mode when
		// the tail is deep enough; here the log is a missing file, so follow
		// just stays clamped — assert the event was handled).
		const wheelDetail = (widget as any).handleMouse({
			...base,
			type: "wheel",
			y: metrics.outputStart,
			wheelDelta: 1,
		});
		assert.deepEqual(wheelDetail, { handled: true });

		// Click on a real list row selects it.
		(widget as any).handleMouse({ ...base, type: "click", y: metrics.listStart + 1 });
		assert.equal(controller.selectedIndex(), 1);

		// Click on a blank pad row (below the task count, inside the pane) is inert.
		const padRow = metrics.listStart + 5; // 3 tasks, pane is 9 rows at 80 rows
		assert.equal(controller.getTasks().length, 3);
		assert.ok(padRow < metrics.listEnd);
		(widget as any).handleMouse({ ...base, type: "click", y: padRow });
		assert.equal(controller.selectedIndex(), 1, "pad-row click does not change selection");

		// Click on the detail/output panes is inert.
		const clickDetail = (widget as any).handleMouse({ ...base, type: "click", y: metrics.outputStart });
		assert.equal(clickDetail, undefined);
		assert.equal(controller.selectedIndex(), 1);
	} finally {
		dock.dispose();
	}
});

// ─── parseMouseInput: press / motion / release ──────────────────────────────

test("parseMouseInput: surfaces SGR press, motion, and release", () => {
	const press = parseMouseInput("\x1b[<0;10;5M");
	assert.equal(press.sawMouse, true);
	assert.deepEqual(press.press, { x: 9, y: 4, button: 0 });
	assert.equal(press.clickRow, 5);
	assert.equal(press.motion, undefined);
	assert.equal(press.release, undefined);

	const motion = parseMouseInput("\x1b[<32;12;8M");
	assert.deepEqual(motion.motion, { x: 11, y: 7, button: 32 });
	assert.equal(motion.press, undefined);

	const release = parseMouseInput("\x1b[<0;12;8m");
	assert.deepEqual(release.release, { x: 11, y: 7, button: 0 });
	assert.equal(release.press, undefined);

	// Wheel events unchanged.
	assert.equal(parseMouseInput("\x1b[<64;1;1M").wheelDelta, -1);
	assert.equal(parseMouseInput("\x1b[<65;1;1M").wheelDelta, 1);

	// Plain keyboard text is untouched.
	const text = parseMouseInput("hello");
	assert.equal(text.sawMouse, false);
	assert.equal(text.press, undefined);
});
