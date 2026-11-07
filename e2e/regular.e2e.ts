/**
 * PRD-007 Approach A — regular (main-screen) TUI mode smoke test.
 *
 * Regular mode has no component mouse dispatch (pi parses no mouse sequences
 * there), so this pass exercises the raw input paths:
 *   - geometry contract + height invariance (keyboard-driven, same as
 *     fullscreen);
 *   - +/- pane resize via handleDockInput;
 *   - PgUp/PgDn reach the dock's raw input path → log scroll (in fullscreen
 *     the alt-screen transcript handler owns these keys — e2e finding §11);
 *   - raw wheel events (position-independent) scroll the windowed list.
 *
 * Run: npx tsx e2e/regular.e2e.ts
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

const terminal = TuiTest.ephemeral("dock-regular", { backend: "xtermjs" });
const screen = () => terminal.text();
async function rowOf(text: string): Promise<number> {
	const m = await terminal.getByText(text).unique().location();
	return m.start.row;
}
const settle = () => sleep(450);

try {
	await terminal.run(
		"pi",
		["-e", ext, "-e", driver, "--no-extensions", "--no-session", "--no-context-files", "--no-skills", "--offline", "--tui-mode", "regular"],
		{ cols: COLS, rows: ROWS, cwd: "/tmp" },
	);
	await terminal.getByText("escape interrupt").expect({ timeout: 20000 });
	await sleep(600);

	// Nine deep-log tasks → windowed list (L=7 of 9) and a scrollable log.
	for (let i = 0; i < 9; i++) {
		await terminal.submit(`/spawn seq 1 400; sleep $((60 + ${i}))`);
		await sleep(300);
	}
	await sleep(600);

	await terminal.screenshot(join(artifacts, "reg-01-compact.svg"));
	let text = await screen();
	check("regular compact dock caps at 3 rows", (text.match(/● \[/g) ?? []).length === 3);

	// ── Expanded view + geometry contract ───────────────────────────────────
	await terminal.submit("/tasks");
	await sleep(800);
	await terminal.screenshot(join(artifacts, "reg-02-expanded.svg"));
	text = await screen();
	check("expanded view opens", text.includes("Task Details"));
	check("windowed hint 1–7 of 9", text.includes("1–7 of 9"));
	check("handle row present", text.includes("drag or +/- to resize"));

	const handleRow = await rowOf("drag or +/- to resize");
	const detailsRow = await rowOf("Task Details");
	const statusRow = await rowOf("esc close");
	check("details title directly below handle", detailsRow - handleRow === 1);
	check("status hint sits 23 rows below the handle", statusRow - handleRow === 23, `got ${statusRow - handleRow}`);

	// ── Height invariance across selection moves ────────────────────────────
	await terminal.press("Down");
	await settle();
	text = await screen();
	check("selection re-binds metadata (task-2 window)", text.includes("1–7 of 9"));
	check(
		"geometry fixed across selection change",
		(await rowOf("drag or +/- to resize")) === handleRow && (await rowOf("esc close")) === statusRow,
	);

	// ── +/- resize via the raw keyboard path ────────────────────────────────
	await terminal.press("+");
	await settle();
	await terminal.screenshot(join(artifacts, "reg-03-resize.svg"));
	const handlePlus = await rowOf("drag or +/- to resize");
	check("+ grows the list pane", handlePlus === handleRow + 1, `${handleRow} → ${handlePlus}`);
	check("+ keeps the status row fixed", (await rowOf("esc close")) === statusRow);
	await terminal.press("-");
	await settle();
	check("- restores the split", (await rowOf("drag or +/- to resize")) === handleRow);

	// ── Raw wheel events scroll the windowed list (position-independent) ────
	await terminal.mouse.scroll("down", { amount: 2 });
	await settle();
	await terminal.screenshot(join(artifacts, "reg-04-wheel-list.svg"));
	text = await screen();
	check("raw wheel scrolls the list window (3–9 of 9)", text.includes("3–9 of 9"));
	await terminal.mouse.scroll("up", { amount: 4 });
	await settle();
	check("raw wheel scrolls back (1–7 of 9)", (await screen()).includes("1–7 of 9"));

	// ── PgUp/PgDn reach the dock log via the raw path ───────────────────────
	// Select task-1 (deepest log): ↓ from the top... the list window starts at
	// offset 0 and the selection is at index 0 → ↓ moves to index 1; instead
	// use Home/End? Home/End are log keys. Click is inert in regular mode —
	// navigate with ↑ to wrap to the last task, or simply PgUp on task-1:
	// the selection is already at index 0 after the wheel scroll clamps it.
	await terminal.keyboard.press("PageUp");
	await settle();
	await terminal.screenshot(join(artifacts, "reg-05-pgup.svg"));
	text = await screen();
	check("regular PgUp reaches the dock log (lines mode)", text.includes("lines ") && !text.includes("following tail"));
	check(
		"scrolled status line fits without truncation",
		text.includes("esc close") && text.includes("+/- resize"),
	);
	await terminal.keyboard.press("End");
	await settle();
	text = await screen();
	check("End resumes tail follow", text.includes("following tail"));

	// ── Esc collapses ────────────────────────────────────────────────────────
	await terminal.keyboard.press("Escape");
	await settle();
	await terminal.screenshot(join(artifacts, "reg-06-collapsed.svg"));
	text = await screen();
	check("Esc closes the expanded view", !text.includes("Task Details"));
	check("compact dock still lists running rows", (text.match(/● \[/g) ?? []).length === 3);
} catch (err) {
	failed++;
	failures.push(`harness error: ${err}`);
	console.error("HARNESS ERROR:", err);
} finally {
	await terminal.closeQuiet();
}

console.log(`\nregular-mode e2e: ${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log("Failures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exitCode = 1;
}
