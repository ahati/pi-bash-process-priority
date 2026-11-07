/**
 * PRD-007 Approach A tests: fixed two-panel layout.
 *
 * Covers:
 * 1. computeLayout math — budgets, clamps, defaults, degraded small terminals,
 *    and row-boundary consistency (the G3 hit-test source of truth).
 * 2. Height invariance — the core flicker fix: the expanded widget renders
 *    exactly `totalRows` lines across selection changes, task-count changes,
 *    and the async tail-read window (G1 + G2).
 * 3. Resize handle — keyboard (+/-), mouse drag state machine (press →
 *    capture, drag, release), and the metrics-driven click/wheel routing.
 * 4. parseMouseInput press/motion/release (regular-mode groundwork).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	clampToRange,
	computeLayout,
	DOCK_FIXED_ROWS,
	DOCK_MIN_LIST_ROWS,
	DOCK_MIN_OUTPUT_ROWS,
	resolveTermHeight,
} from "../src/ui/dock-layout.ts";
import { formatResizeHandle } from "../src/ui/format.ts";
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

test("computeLayout: default split honors the terminal budget", () => {
	// 40 rows: available = 40 - 6 = 34; budget = 34 - 15 = 19;
	// default L = ceil(19 * 0.35) = 7; O = 12.
	const m = computeLayout(40);
	assert.equal(m.degraded, false);
	assert.equal(m.listRows, 7);
	assert.equal(m.outputRows, 12);
	assert.equal(m.totalRows, DOCK_FIXED_ROWS + m.listRows + m.outputRows);
	assert.equal(m.totalRows, 40 - 6);
	assert.equal(m.maxListRows, 15);
	assert.equal(m.defaultListRows, 7);
});

test("computeLayout: requested list rows override the default and clamp", () => {
	const m = computeLayout(40, 3);
	assert.equal(m.listRows, DOCK_MIN_LIST_ROWS);
	assert.equal(m.outputRows, 40 - 6 - DOCK_FIXED_ROWS - 3);
	assert.ok(m.outputRows >= DOCK_MIN_OUTPUT_ROWS);

	const maxed = computeLayout(40, 999);
	assert.equal(maxed.listRows, maxed.maxListRows);
	assert.equal(maxed.outputRows, DOCK_MIN_OUTPUT_ROWS);
});

test("computeLayout: row boundaries are mutually consistent", () => {
	for (const rows of [24, 30, 40, 80, 120]) {
		const m = computeLayout(rows, undefined);
		assert.equal(m.headerRows, 3);
		assert.equal(m.listStart, m.headerRows);
		assert.equal(m.listEnd, m.listStart + m.listRows);
		assert.equal(m.handleIndex, m.listEnd);
		assert.equal(m.detailTitleIndex, m.handleIndex + 1);
		assert.equal(m.metaStart, m.detailTitleIndex + 1);
		assert.equal(m.ruleIndex, m.metaStart + 6);
		assert.equal(m.outputTitleIndex, m.ruleIndex + 1);
		assert.equal(m.outputStart, m.outputTitleIndex + 2);
		assert.equal(m.statusIndex, m.outputStart + m.outputRows);
		assert.equal(m.totalRows, m.statusIndex + 1);
	}
});

test("computeLayout: degraded small terminals honor the minimum panes", () => {
	const m = computeLayout(24);
	assert.equal(m.degraded, true);
	assert.equal(m.listRows, DOCK_MIN_LIST_ROWS);
	assert.equal(m.outputRows, DOCK_MIN_OUTPUT_ROWS);
	assert.equal(m.totalRows, DOCK_FIXED_ROWS + DOCK_MIN_LIST_ROWS + DOCK_MIN_OUTPUT_ROWS);
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

function latestWidget(calls: WidgetCall[]): { render(width: number): string[] } | undefined {
	const last = [...calls].reverse().find((c) => typeof c.content === "function");
	if (!last) return undefined;
	return (last.content as Function)({ terminal: { rows: 40 }, requestRender() {} }, theme);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
	await delay(30);
	const linesA = widget.render(120);
	const height = linesA.length;
	const metrics = controller.getLayoutMetrics(40);
	assert.equal(height, metrics.totalRows, "render must match metrics.totalRows");
	assert.ok(linesA.some((l) => l.includes("alpha log line")), "tail of task-1 renders");

	// Selection change → second task. The immediate render (before the async
	// read lands) and the post-read render must have identical geometry.
	controller.move(1);
	const linesBImmediate = widget.render(120);
	assert.equal(linesBImmediate.length, height, "height stable during the async gap (RC-1)");
	await delay(30);
	const linesB = widget.render(120);
	assert.equal(linesB.length, height, "height stable after the tail read lands");
	assert.ok(linesB.some((l) => l.includes("beta log line")), "tail of task-2 renders");
	assert.ok(linesB.some((l) => l.includes("run beta")), "metadata re-binds to task-2");

	// Back to task-1 — served from the tail cache.
	controller.move(-1);
	const linesA2Immediate = widget.render(120);
	assert.equal(linesA2Immediate.length, height);
	await delay(30);
	const linesA2 = widget.render(120);
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

// ─── Resize: keyboard ────────────────────────────────────────────────────────

function makeHandleInputHarness() {
	const tasks = Array.from({ length: 10 }, (_, i) =>
		makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }),
	);
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	const getTui = () => ({ terminal: { rows: 40 }, requestRender() {} }) as never;
	return { controller, getTui };
}

test("handleDockInput: +/- resizes the master-list pane within clamps", () => {
	const { controller, getTui } = makeHandleInputHarness();
	const before = controller.getMaxVisible(40);

	assert.equal(handleDockInput("+", {}, controller, undefined, getTui)?.consume, true);
	assert.equal(controller.getMaxVisible(40), before + 1);
	assert.equal(controller.getOutputRows(40), computeLayout(40).outputRows - 1);

	assert.equal(handleDockInput("-", {}, controller, undefined, getTui)?.consume, true);
	assert.equal(controller.getMaxVisible(40), before);

	// Hammering "-" clamps at the minimum without going below it.
	for (let i = 0; i < 10; i++) handleDockInput("-", {}, controller, undefined, getTui);
	assert.equal(controller.getMaxVisible(40), DOCK_MIN_LIST_ROWS);
});

// ─── Resize: mouse drag ─────────────────────────────────────────────────────

function makeMouseHarness() {
	const tasks = Array.from({ length: 3 }, (_, i) =>
		makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }),
	);
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	const { ctx, registry, calls } = fakeInstall();
	const dock = installDock(ctx as never, registry as never, controller);
	const widget = latestWidget(calls);
	assert.ok(widget);
	return { controller, dock, widget };
}

test("handleMouse: press on the handle row captures, drag resizes, release ends", () => {
	const { controller, dock, widget } = makeMouseHarness();
	try {
		const metrics = controller.getLayoutMetrics(40);
		const startScreenY = 100;

		const press = (widget as any).handleMouse({
			type: "press",
			button: "left",
			x: 10,
			y: metrics.handleIndex,
			screenX: 10,
			screenY: startScreenY,
			width: 120,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.deepEqual(press, { handled: true, capture: true });
		assert.equal(controller.isHandleDragActive(), true);

		// Drag down 3 rows → list pane grows by 3.
		(widget as any).handleMouse({
			type: "drag",
			button: "left",
			x: 10,
			y: metrics.handleIndex + 3,
			screenX: 10,
			screenY: startScreenY + 3,
			width: 120,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.equal(controller.getMaxVisible(40), metrics.listRows + 3);
		assert.equal(controller.getOutputRows(40), metrics.outputRows - 3);

		const release = (widget as any).handleMouse({
			type: "release",
			button: "left",
			x: 10,
			y: metrics.handleIndex + 3,
			screenX: 10,
			screenY: startScreenY + 3,
			width: 120,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.equal((release as any).handled, true);
		assert.equal(controller.isHandleDragActive(), false);
	} finally {
		dock.dispose();
	}
});

test("handleMouse: wheel routes by layout region; click only selects real rows", () => {
	const { controller, dock, widget } = makeMouseHarness();
	try {
		const metrics = controller.getLayoutMetrics(40);
		const base = {
			button: "left" as const,
			x: 10,
			screenX: 10,
			width: 120,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
		};

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
		const padRow = metrics.listStart + 10; // 3 tasks, pane is 7 rows
		assert.equal(controller.getTasks().length, 3);
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
