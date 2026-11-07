/**
 * Expanded-dock tests: single-scroll page + resizable panel height.
 *
 * Covers:
 * 1. computeLayout — 50% opening, maximum-height drag ceiling, env cap,
 *    floor, re-clamp on terminal resize, tiny terminals.
 * 2. buildDockDocument — list → details → output in one document.
 * 3. Height invariance — the expanded panel renders exactly `totalRows`
 *    lines across selection/task-count/async-tail changes.
 * 4. Scroll model — one scroll offset over the whole document, follow at end.
 * 5. Keyboard + mouse — height resize (grip, +/- and [/]), page/top/bottom
 *    scroll, wheel, click mapping through the scroll window.
 * 6. pi-tui coalesced mouse chunks are split before its parser sees them.
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
	DOCK_CHROME_ROWS,
	DOCK_DEFAULT_MAX_HEIGHT_SHARE,
	DOCK_MIN_ROWS,
	DOCK_SCREEN_RESERVE_ROWS,
	resolveDockMaxHeightShare,
	resolveTermHeight,
} from "../src/ui/dock-layout.ts";
import { formatDockStatusLine, formatHeaderLine, GRIP_CHAR } from "../src/ui/format.ts";
import { buildDockDocument } from "../src/ui/dock-document.ts";
import { parseMouseInput, splitCoalescedMouseInput } from "../src/ui/terminal-mouse.ts";
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
	assert.ok(resolveTermHeight(undefined) > 0);
});

test("clampToRange: rounds and clamps", () => {
	assert.equal(clampToRange(5, 1, 10), 5);
	assert.equal(clampToRange(-3, 1, 10), 1);
	assert.equal(clampToRange(99, 1, 10), 10);
	assert.equal(clampToRange(2.6, 1, 10), 3);
	assert.equal(clampToRange(Number.NaN, 1, 10), 1);
});

test("resolveDockMaxHeightShare: parses numbers/percentages, clamps, defaults to 1", () => {
	assert.equal(resolveDockMaxHeightShare(undefined), DOCK_DEFAULT_MAX_HEIGHT_SHARE);
	assert.equal(DOCK_DEFAULT_MAX_HEIGHT_SHARE, 1);
	assert.equal(resolveDockMaxHeightShare("0.5"), 0.5);
	assert.equal(resolveDockMaxHeightShare("50%"), 0.5);
	assert.equal(resolveDockMaxHeightShare("100%"), 1);
	assert.equal(resolveDockMaxHeightShare("nope"), 1);
	assert.equal(resolveDockMaxHeightShare(""), 1);
	assert.equal(resolveDockMaxHeightShare(5), 1);
	assert.equal(resolveDockMaxHeightShare(0.05), 0.2);
});

test("computeLayout: opens at half the terminal", () => {
	for (const rows of [24, 30, 40, 60, 80]) {
		const m = computeLayout(rows);
		assert.equal(m.totalRows, Math.floor(rows * 0.5), `${rows} rows`);
		assert.equal(m.totalRows, m.defaultTotalRows);
		assert.equal(m.viewportRows, m.totalRows - DOCK_CHROME_ROWS);
		assert.equal(m.viewportStart, 1);
		assert.equal(m.statusIndex, m.totalRows - 1);
	}
	const m40 = computeLayout(40);
	assert.equal(m40.totalRows, 20);
	assert.equal(m40.viewportRows, 18);
});

test("computeLayout: the drag ceiling is the maximum usable height", () => {
	for (const rows of [24, 40, 60, 80, 120]) {
		const m = computeLayout(rows);
		assert.equal(m.maxTotalRows, rows - DOCK_SCREEN_RESERVE_ROWS, `${rows} rows`);
		assert.ok(m.maxTotalRows >= m.totalRows);
	}
	const m40 = computeLayout(40);
	assert.equal(m40.minTotalRows, DOCK_MIN_ROWS);
	assert.equal(m40.maxTotalRows, 35);
});

test("computeLayout: requested height clamps to the floor and the ceiling", () => {
	const base = computeLayout(40);
	assert.equal(computeLayout(40, { totalRows: 1 }).totalRows, DOCK_MIN_ROWS);
	assert.equal(computeLayout(40, { totalRows: 999 }).totalRows, base.maxTotalRows);
	assert.equal(computeLayout(40, { totalRows: 30 }).totalRows, 30);
});

test("computeLayout: maxHeightShare caps the drag ceiling", () => {
	const capped = computeLayout(40, { maxHeightShare: 0.5 });
	assert.equal(capped.maxTotalRows, 20);
	assert.equal(capped.totalRows, 20);
	assert.equal(computeLayout(40, { totalRows: 99, maxHeightShare: 0.5 }).totalRows, 20);

	const tight = computeLayout(60, { maxHeightShare: 0.3 });
	assert.equal(tight.maxTotalRows, 18);
	assert.equal(tight.totalRows, 18);
});

test("computeLayout: a dragged height re-clamps when the terminal shrinks", () => {
	// 80 rows → ceiling 75; a 50-row drag is valid there.
	assert.equal(computeLayout(80, { totalRows: 50 }).totalRows, 50);
	// Same stored value on a 40-row terminal clamps to the 35-row ceiling.
	const shrunk = computeLayout(40, { totalRows: 50 });
	assert.equal(shrunk.totalRows, 35);
	assert.ok(shrunk.totalRows <= shrunk.maxTotalRows);
	// Growing the terminal back restores the user's height.
	assert.equal(computeLayout(80, { totalRows: 50 }).totalRows, 50);
});

test("computeLayout: tiny terminals keep the 3-row floor and mark degraded", () => {
	const m = computeLayout(7);
	assert.equal(m.degraded, true);
	assert.equal(m.totalRows, DOCK_MIN_ROWS);
	assert.equal(m.viewportRows, 1);
});

// ─── Document builder ───────────────────────────────────────────────────────

test("buildDockDocument: list → details → output in one document", () => {
	const tasks = [
		makeTask({ id: "task-1", name: "alpha", command: "run alpha", cwd: "/a", logPath: "/a.log" }),
		makeTask({ id: "task-2", name: "beta", command: "run beta", cwd: "/b", logPath: "/b.log" }),
	];
	const doc = buildDockDocument({
		tasks,
		selectedIndex: 1,
		width: 80,
		nowMs: 1700000012000,
		theme,
		outputLines: ["out line 1", "out line 2"],
	});

	assert.equal(doc.listCount, 2);
	assert.ok(doc.lines[0].includes("alpha") && doc.lines[0].startsWith("  "));
	assert.ok(doc.lines[1].includes("beta") && doc.lines[1].startsWith("> "));
	assert.equal(doc.detailsStart, 3);
	assert.equal(doc.lines[doc.detailsStart], "Task Details");
	assert.ok(doc.lines.some((l) => l.includes("Command:") && l.includes("run beta")));
	assert.ok(doc.lines.some((l) => l.includes("Cwd:") && l.includes("/b")));
	assert.ok(doc.lines.some((l) => l.includes("Log:") && l.includes("/b.log")));
	assert.equal(doc.lines[doc.outputStart - 1], "Output");
	assert.equal(doc.lines[doc.outputStart], "out line 1");
	assert.equal(doc.lines[doc.outputStart + 1], "out line 2");
	assert.ok(doc.outputStart > doc.detailsStart);
});

test("buildDockDocument: every line fits the requested width", () => {
	const tasks = [makeTask({ id: "task-1", name: "x".repeat(200), command: "y".repeat(200) })];
	const doc = buildDockDocument({
		tasks,
		selectedIndex: 0,
		width: 40,
		nowMs: 1700000012000,
		theme,
		outputLines: ["z".repeat(200)],
	});
	for (const line of doc.lines) {
		assert.ok(visibleWidth(line) <= 40, `over-wide: ${line}`);
	}
});

// ─── Height invariance (the flicker fix) ────────────────────────────────────

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

test("expanded panel height is invariant across selection changes and async tail reads", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dock-merged-"));
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

	const metrics = controller.getLayoutMetrics(40);
	const linesA = await renderUntil(widget, 120, (l) => l.some((x) => x.includes("alpha log line")));
	assert.equal(linesA.length, metrics.totalRows, "render must match metrics.totalRows");
	assert.ok(linesA.some((l) => l.includes("alpha log line")), "tail of task-1 renders");

	controller.move(1);
	const linesBImmediate = widget.render(120);
	assert.equal(linesBImmediate.length, metrics.totalRows, "height stable during the async gap");
	const linesB = await renderUntil(widget, 120, (l) => l.some((x) => x.includes("beta log line")));
	assert.equal(linesB.length, metrics.totalRows);
	assert.ok(linesB.some((l) => l.includes("run beta")), "details rebind to task-2");

	controller.move(-1);
	const linesA2 = await renderUntil(widget, 120, (l) => l.some((x) => x.includes("alpha log line")));
	assert.equal(linesA2.length, metrics.totalRows);

	dock.dispose();
});

test("expanded panel height is invariant across task-count changes", () => {
	const tasks = [makeTask({ id: "task-1", name: "a" })];
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks();
	const { ctx, registry, calls } = fakeInstall();
	const dock = installDock(ctx as never, registry as never, controller);
	const widget = latestWidget(calls);
	assert.ok(widget);

	const height = widget.render(120).length;
	assert.equal(height, controller.getLayoutMetrics(40).totalRows);

	tasks.push(makeTask({ id: "task-2", name: "b" }), makeTask({ id: "task-3", name: "c" }));
	assert.equal(widget.render(120).length, height);

	dock.dispose();
});

test("expanded panel re-adjusts when the terminal is resized", () => {
	const tasks = Array.from({ length: 12 }, (_, i) => makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }));
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	const { ctx, registry, calls } = fakeInstall();
	const dock = installDock(ctx as never, registry as never, controller);
	const tui = { terminal: { rows: 40 }, requestRender() {} };
	const widget = latestWidget(calls, tui);
	assert.ok(widget);

	assert.equal(widget.render(120).length, 20);
	tui.terminal.rows = 24;
	assert.equal(widget.render(120).length, 12);
	tui.terminal.rows = 40;
	assert.equal(widget.render(120).length, 20);

	dock.dispose();
});

// ─── Scroll model ───────────────────────────────────────────────────────────

test("DockController: one scroll offset over the document, follow at the end", () => {
	const tasks = [makeTask({ id: "task-1" })];
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks();
	assert.deepEqual(controller.getScroll(), { top: 0, follow: false, max: 0 });

	controller.setScrollMax(50);
	controller.scrollDocument(5);
	assert.deepEqual(controller.getScroll(), { top: 5, follow: false, max: 50 });

	controller.scrollDocument(100);
	assert.deepEqual(controller.getScroll(), { top: 50, follow: true, max: 50 });
	controller.scrollDocument(-10);
	assert.deepEqual(controller.getScroll(), { top: 40, follow: false, max: 50 });

	controller.scrollDocumentTop();
	assert.deepEqual(controller.getScroll(), { top: 0, follow: false, max: 50 });
	controller.scrollDocumentBottom();
	assert.deepEqual(controller.getScroll(), { top: 50, follow: true, max: 50 });

	// Following keeps the tail pinned when the document grows.
	controller.setScrollMax(80);
	assert.equal(controller.getScroll().top, 80);
});

test("DockController: page scroll uses the viewport height", () => {
	const tasks = [makeTask({ id: "task-1" })];
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks();
	controller.setScrollMax(200);
	controller.scrollDocumentPage(1, 40);
	assert.equal(controller.getScroll().top, 17); // viewport 18 → page 17
	controller.scrollDocumentPage(-1, 40);
	assert.equal(controller.getScroll().top, 0);
});

test("DockController: selection reveal/anchor over the list vs. the tail", () => {
	const tasks = Array.from({ length: 30 }, (_, i) => makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }));
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	controller.setDocumentBounds(30, 34);
	controller.setScrollMax(100);

	// Window over the list → minimal scroll to reveal the new selection.
	controller.setScrollMax(100);
	controller.scrollDocument(0);
	controller.move(20, 40);
	assert.ok(controller.getScroll().top <= 20);
	assert.ok(controller.getScroll().top + controller.getLayoutMetrics(40).viewportRows > 20);

	// Window over details/output → anchor to the new task's detail section.
	controller.scrollDocument(50);
	controller.move(1, 40);
	assert.equal(controller.getScroll().top, 34);
});

// ─── Height resize: keyboard ─────────────────────────────────────────────────

function makeHandleInputHarness(rows = 60) {
	const tasks = Array.from({ length: 10 }, (_, i) => makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }));
	const controller = new DockController(() => tasks, () => tasks);
	controller.expandTasks("task-1");
	const getTui = () => ({ terminal: { rows }, requestRender() {} }) as never;
	return { controller, getTui };
}

test("handleDockInput: + - [ ] resize the panel between floor and maximum", () => {
	const { controller, getTui } = makeHandleInputHarness(60);
	const start = controller.getLayoutMetrics(60);
	assert.equal(start.totalRows, 30);
	assert.equal(start.maxTotalRows, 55);

	assert.equal(handleDockInput("+", {}, controller, undefined, getTui)?.consume, true);
	assert.equal(controller.getLayoutMetrics(60).totalRows, 31);
	assert.equal(handleDockInput("[", {}, controller, undefined, getTui)?.consume, true);
	assert.equal(controller.getLayoutMetrics(60).totalRows, 30);

	for (let i = 0; i < 80; i++) handleDockInput("]", {}, controller, undefined, getTui);
	assert.equal(controller.getLayoutMetrics(60).totalRows, start.maxTotalRows, "up to the maximum");

	for (let i = 0; i < 80; i++) handleDockInput("-", {}, controller, undefined, getTui);
	assert.equal(controller.getLayoutMetrics(60).totalRows, DOCK_MIN_ROWS, "down to the floor");
});

test("handleDockInput: PgUp/PgDn/Home/End scroll the whole document", () => {
	const { controller, getTui } = makeHandleInputHarness(60);
	controller.setScrollMax(100);
	assert.equal(handleDockInput("\x1b[6~", {}, controller, undefined, getTui)?.consume, true); // PgDn
	assert.equal(controller.getScroll().top, 27); // viewport 28 → page 27
	handleDockInput("\x1b[5~", {}, controller, undefined, getTui); // PgUp
	assert.equal(controller.getScroll().top, 0);
	handleDockInput("\x1b[F", {}, controller, undefined, getTui); // End
	assert.deepEqual(controller.getScroll(), { top: 100, follow: true, max: 100 });
	handleDockInput("\x1b[H", {}, controller, undefined, getTui); // Home
	assert.deepEqual(controller.getScroll(), { top: 0, follow: false, max: 100 });
});

test("DockController: resizeTotal is a no-op outside the expanded view", () => {
	const tasks = [makeTask({ id: "task-1" })];
	const controller = new DockController(() => tasks, () => tasks);
	assert.equal(controller.resizeTotal(1, 40), false);
	controller.expandTasks();
	assert.equal(controller.resizeTotal(1, 40), true);
	assert.equal(controller.getLayoutMetrics(40).totalRows, 21);
});

// ─── Height resize + scrolling: mouse ───────────────────────────────────────

function makeMouseHarness(rows = 40, taskCount = 3) {
	const tasks = Array.from({ length: taskCount }, (_, i) => makeTask({ id: `task-${i + 1}`, name: `t${i + 1}` }));
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

test("handleMouse: dragging the top grip resizes up to the maximum", () => {
	const { controller, dock, widget } = makeMouseHarness();
	try {
		const start = controller.getLayoutMetrics(40);
		assert.equal(start.totalRows, 20);
		assert.equal(start.maxTotalRows, 35);

		const press = (widget as any).handleMouse({ ...mouseBase, type: "press", y: 0, screenY: 100, height: 40 });
		assert.deepEqual(press, { handled: true, capture: true });
		assert.equal(controller.isHandleDragActive(), true);

		// Drag down 1 → the panel shrinks by one row.
		(widget as any).handleMouse({ ...mouseBase, type: "drag", y: 1, screenY: 101, height: 40 });
		assert.equal(controller.getLayoutMetrics(40).totalRows, 19);
		assert.equal(widget.render(120).length, 19);

		// Drag up well past 50% → grows to the maximum usable height.
		(widget as any).handleMouse({ ...mouseBase, type: "drag", y: 0, screenY: 40, height: 40 });
		assert.equal(controller.getLayoutMetrics(40).totalRows, 35);
		assert.equal(widget.render(120).length, 35);

		// Drag far down → clamps at the 3-row floor.
		(widget as any).handleMouse({ ...mouseBase, type: "drag", y: 30, screenY: 300, height: 40 });
		assert.equal(controller.getLayoutMetrics(40).totalRows, DOCK_MIN_ROWS);

		(widget as any).handleMouse({ ...mouseBase, type: "release", y: 30, screenY: 300, height: 40 });
		assert.equal(controller.isHandleDragActive(), false);
	} finally {
		dock.dispose();
	}
});

test("handleMouse: wheel scrolls the document; click maps through the window", () => {
	const { controller, dock, widget } = makeMouseHarness(40, 44);
	try {
		widget.render(120); // sets scrollMax
		const before = controller.getScroll().top;
		const wheel = (widget as any).handleMouse({ ...mouseBase, type: "wheel", y: 5, height: 40, wheelDelta: 1 });
		assert.deepEqual(wheel, { handled: true });
		assert.equal(controller.getScroll().top, before + 3);

		// Back to the top so document row == local row - 1.
		controller.scrollDocumentTop();
		const metrics = controller.getLayoutMetrics(40);
		(widget as any).handleMouse({ ...mouseBase, type: "click", y: metrics.viewportStart + 2, height: 40 });
		assert.equal(controller.selectedIndex(), 2, "third list row selects task-3");
		widget.render(120); // click re-expanded via expandTasks → refresh scroll bounds

		// Scrolled to the tail: the visible rows are details/output, inert.
		controller.scrollDocumentBottom();
		(widget as any).handleMouse({
			...mouseBase,
			type: "click",
			y: metrics.viewportEnd - 1,
			height: 40,
		});
		assert.equal(controller.selectedIndex(), 2, "details/output rows are inert");

		// Scrolled window: local row 1 maps to document row 1 + scrollTop.
		controller.scrollDocumentTop();
		controller.scrollDocument(1);
		(widget as any).handleMouse({ ...mouseBase, type: "click", y: metrics.viewportStart, height: 40 });
		assert.equal(controller.selectedIndex(), 1, "task-2 at document row 1");
	} finally {
		dock.dispose();
	}
});

// ─── Header grip + status line ──────────────────────────────────────────────

test("formatHeaderLine: grip renders a U+25AC block bar that adapts to width", () => {
	const wide = formatHeaderLine("Background Tasks", 80, theme, "3 tasks", undefined, { grip: true });
	assert.ok(wide.includes(GRIP_CHAR.repeat(10)));
	assert.equal(visibleWidth(wide), 80);

	const medium = formatHeaderLine("Background Tasks", 30, theme, undefined, undefined, { grip: true });
	assert.ok(medium.includes(GRIP_CHAR.repeat(8)));
	assert.equal(visibleWidth(medium), 30);

	const plain = formatHeaderLine("Background Tasks", 80, theme, "3 tasks");
	assert.ok(!plain.includes(GRIP_CHAR));
});

test("formatDockStatusLine: sheds optional hints on narrow terminals, keeps esc", () => {
	const hints = ["↑/↓ select", "Home/End jump", "[/] height", "k kill", "esc close"];
	const wide = formatDockStatusLine("lines 1–18 of 40", hints, 140);
	assert.ok(wide.includes("[/] height") && wide.includes("esc close"));
	assert.ok(visibleWidth(wide) <= 140);

	const narrow = formatDockStatusLine("lines 1–18 of 40", hints, 60);
	assert.ok(narrow.includes("esc close"));
	assert.ok(visibleWidth(narrow) <= 60);
});

// ─── pi-tui coalesced mouse chunks ──────────────────────────────────────────

test("splitCoalescedMouseInput: splits coalesced drag reports, passes the rest through", () => {
	const one = "\x1b[<32;10;5M";
	assert.deepEqual(splitCoalescedMouseInput(one), [one]);

	const three = "\x1b[<32;10;5M\x1b[<32;10;6M\x1b[<32;10;7M";
	assert.deepEqual(splitCoalescedMouseInput(three), [
		"\x1b[<32;10;5M",
		"\x1b[<32;10;6M",
		"\x1b[<32;10;7M",
	]);

	const mixed = "a\x1b[<32;1;2Mb";
	assert.deepEqual(splitCoalescedMouseInput(mixed), ["a", "\x1b[<32;1;2M", "b"]);

	assert.deepEqual(splitCoalescedMouseInput("hello"), ["hello"]);
	assert.deepEqual(splitCoalescedMouseInput(""), [""]);
});

test("parseMouseInput still surfaces press/motion/release", () => {
	assert.deepEqual(parseMouseInput("\x1b[<0;10;5M").press, { x: 9, y: 4, button: 0 });
	assert.deepEqual(parseMouseInput("\x1b[<32;12;8M").motion, { x: 11, y: 7, button: 32 });
	assert.deepEqual(parseMouseInput("\x1b[<0;12;8m").release, { x: 11, y: 7, button: 0 });
	assert.equal(parseMouseInput("\x1b[<64;1;1M").wheelDelta, -1);
	assert.equal(parseMouseInput("hello").sawMouse, false);
});
