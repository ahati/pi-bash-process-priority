/**
 * PRD-007 Approach A — end-to-end verification of the live pi TUI using
 * @microsoft/tui-test (xtermjs backend, real PTY, fullscreen = product
 * default where component mouse dispatch and the drag handle are active).
 *
 * Keyboard contract respected: dock mode owns ALL keys until Esc, so every
 * /spawn and /tasks is submitted while the dock is inactive.
 *
 * Run: npx tsx e2e/dock.e2e.ts
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiTest } from "@microsoft/tui-test";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "index.ts");
const driver = join(here, "spawn-driver.ts");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const COLS = 110;
const ROWS = 40;
const LIST_ROWS = 7; // computeLayout(40): available 34, budget 19, L=7, O=12
const OUTPUT_ROWS = 12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
	if (cond) {
		passed++;
		console.log(`  ✔ ${name}`);
	} else {
		failed++;
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const terminal = TuiTest.ephemeral("dock-e2e", { backend: "xtermjs" });

const screen = () => terminal.text();
async function rowOf(text: string): Promise<number> {
	const m = await terminal.getByText(text).unique().location();
	return m.start.row;
}
const settle = () => sleep(450);

try {
	await terminal.run(
		"pi",
		["-e", ext, "-e", driver, "--no-extensions", "--no-session", "--offline", "--tui-mode", "fullscreen"],
		{ cols: COLS, rows: ROWS, cwd: "/tmp" },
	);
	await terminal.getByText("escape interrupt").expect({ timeout: 20000 });
	await sleep(600);

	// ── 1. Spawn three real background tasks (dock inactive — submits land) ─
	await terminal.submit("/spawn seq 1 400; sleep 240");
	await sleep(900);
	await terminal.submit("/spawn seq 1 400; sleep 241");
	await sleep(900);
	await terminal.submit("/spawn sleep 260");
	await sleep(900);

	await terminal.screenshot(join(artifacts, "e2e-01-compact-dock.svg"));
	let text = await screen();
	check("compact dock shows 3 running rows", (text.match(/● \[/g) ?? []).length === 3);

	// ── 2. Dock mode via ↓, then Esc releases the keyboard ─────────────────
	await terminal.press("Down");
	await settle();
	text = await screen();
	check("↓ enters dock mode (selection marker)", /[>│] ● \[/.test(text));
	await terminal.keyboard.press("Escape");
	await settle();
	text = await screen();
	check("Esc releases dock mode (marker gone)", !/[>│] ● \[/.test(text));

	// ── 3. /tasks opens the fixed two-panel view ────────────────────────────
	await terminal.submit("/tasks");
	await sleep(800);
	await terminal.screenshot(join(artifacts, "e2e-02-expanded.svg"));
	text = await screen();
	check("header rule present", text.includes("Background Tasks"));
	check("3 tasks counted in header hint", text.includes("3 tasks"));
	check("master list row present", text.includes("seq 1 400"));
	check("handle row present", text.includes("drag or +/- to resize"));
	check("details title present", text.includes("Task Details"));
	check("metadata Command present", text.includes("Command: seq 1 400; sleep 240"));
	check("metadata Cwd/Log present", text.includes("Cwd:") && text.includes("Log:"));
	check("output section present", text.includes("Output"));
	check("tail follows live output", text.includes("following tail"));
	check("status hint advertises +/- resize", text.includes("+/- resize"));

	// PRD-007 geometry contract.
	const handleRow = await rowOf("drag or +/- to resize");
	const detailsRow = await rowOf("Task Details");
	const statusRow = await rowOf("esc close");
	check("details title sits directly below the handle", detailsRow - handleRow === 1, `got ${detailsRow - handleRow}`);
	check(
		`status hint sits ${2 + 6 + 1 + 2 + OUTPUT_ROWS} rows below the handle`,
		statusRow - handleRow === 2 + 6 + 1 + 2 + OUTPUT_ROWS,
		`got ${statusRow - handleRow}`,
	);

	// ── 4. Height invariance across selection changes ───────────────────────
	await terminal.press("Down"); // select task-2
	await settle();
	await terminal.screenshot(join(artifacts, "e2e-03-selection-2.svg"));
	text = await screen();
	check("metadata re-binds to task-2", text.includes("Command: seq 1 400; sleep 241"));
	const handleAfterMove = await rowOf("drag or +/- to resize");
	const statusAfterMove = await rowOf("esc close");
	check("handle row fixed across selection change", handleAfterMove === handleRow, `${handleRow} → ${handleAfterMove}`);
	check("status row fixed across selection change", statusAfterMove === statusRow, `${statusRow} → ${statusAfterMove}`);

	await terminal.press("Down"); // select task-3 (empty log)
	await settle();
	text = await screen();
	check("metadata re-binds to task-3", text.includes("Command: sleep 260"));
	check("output pane re-binds to task-3's log preamble", text.includes("$ sleep 260"));
	check(
		"geometry fixed across empty-output task",
		(await rowOf("drag or +/- to resize")) === handleRow && (await rowOf("esc close")) === statusRow,
	);

	await terminal.press("Up"); // back to task-2
	await settle();

	// ── 5. Keyboard resize (+/-) ────────────────────────────────────────────
	await terminal.press("+");
	await settle();
	await terminal.screenshot(join(artifacts, "e2e-04-resize-plus.svg"));
	const handlePlus = await rowOf("drag or +/- to resize");
	const statusPlus = await rowOf("esc close");
	check("+ grows list pane by 1 (handle moves down)", handlePlus === handleRow + 1, `${handleRow} → ${handlePlus}`);
	check("+ keeps total height constant (status row fixed)", statusPlus === statusRow, `${statusRow} → ${statusPlus}`);
	await terminal.press("-");
	await settle();
	check("- restores the split", (await rowOf("drag or +/- to resize")) === handleRow);

	// ── 6. Mouse drag on the handle row ─────────────────────────────────────
	const dragCol = Math.floor(COLS / 2);
	await terminal.mouse.drag(dragCol, handleRow, dragCol, handleRow + 2);
	await settle();
	await terminal.screenshot(join(artifacts, "e2e-05-drag-plus2.svg"));
	const handleDragged = await rowOf("drag or +/- to resize");
	const statusDragged = await rowOf("esc close");
	check(
		"dragging the handle +2 rows grows the list pane by 2",
		handleDragged === handleRow + 2,
		`${handleRow} → ${handleDragged}`,
	);
	check("drag keeps total height constant", statusDragged === statusRow, `${statusRow} → ${statusDragged}`);

	await terminal.mouse.drag(dragCol, handleDragged, dragCol, handleDragged - 2);
	await settle();
	check("dragging back restores the split", (await rowOf("drag or +/- to resize")) === handleRow);

	// ── 7. Click a list row → selection re-binds ────────────────────────────
	const listStart = handleRow - LIST_ROWS;
	await terminal.mouse.click(dragCol, listStart + 2); // third visible row → task-3
	await settle();
	text = await screen();
	check("clicking a list row selects that task", text.includes("Command: sleep 260"));

	// ── 8. Log scrolling via keyboard (wheel routing is covered in regular
	//    mode — the xtermjs backend wheels at (0,0), see e2e README) ─────────
	// Scroll assertions need a log deeper than the output pane: select
	// task-1 (402 log lines). task-3's 3-line log correctly snaps follow
	// back on (nothing to scroll).
	await terminal.mouse.click(dragCol, listStart); // first row → task-1
	await settle();
	check("click selects task-1", (await screen()).includes("Command: seq 1 400; sleep 240"));
	await terminal.keyboard.press("PageUp");
	await settle();
	await terminal.screenshot(join(artifacts, "e2e-06-pgup-output.svg"));
	text = await screen();
	// e2e finding: fullscreen pi binds PageUp/PageDown to the transcript
	// scroller (consumed before extension input listeners), so the log keeps
	// following here; Home/End are the log keys in this mode (asserted next).
	// Regular mode binds PgUp/PgDn to the log via the raw path (regular pass).
	check("fullscreen PgUp is transcript-owned (log keeps following)", text.includes("following tail"));
	check(
		"status line still fits (esc close not truncated — e2e-found defect)",
		text.includes("esc close") && text.includes("+/- resize"),
	);

	await terminal.keyboard.press("Home");
	await settle();
	text = await screen();
	check("Home jumps the log to the top window", text.includes("lines 1–"));
	await terminal.keyboard.press("End");
	await settle();
	text = await screen();
	check("End resumes tail follow", text.includes("following tail"));

	// ── 9. Kill the selected task (k) ───────────────────────────────────────
	// task-1 is selected (from the click in step 8). The expanded list marks
	// killed tasks with the ✗ glyph; the compact dock (running-only) drops
	// the row entirely — asserted deterministically after Esc below.
	await terminal.keyboard.press("k");
	await sleep(1000);
	await terminal.screenshot(join(artifacts, "e2e-07-killed.svg"));
	text = await screen();
	check("killed task flips to the ✗ marker", text.includes("✗") && !text.includes("> ✓"));

	// ── 10. Esc collapses to the compact dock ───────────────────────────────
	await terminal.keyboard.press("Escape");
	await settle();
	await terminal.screenshot(join(artifacts, "e2e-08-collapsed.svg"));
	text = await screen();
	check("Esc closes the expanded view", !text.includes("Task Details"));
	text = await screen();
	check("killed task left the running-only compact dock (2 survive)", (text.match(/● \[/g) ?? []).length === 2);
	check("compact dock keeps the surviving task", text.includes("sleep 241") && text.includes("running"));
} catch (err) {
	failed++;
	failures.push(`harness error: ${err}`);
	console.error("HARNESS ERROR:", err);
	try {
		await terminal.screenshot(join(artifacts, "e2e-error.svg"));
	} catch {}
} finally {
	await terminal.closeQuiet();
}

console.log(`\ne2e: ${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log("Failures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exitCode = 1;
}
