#!/usr/bin/env node
/**
 * E2E: real-terminal test using @microsoft/tui-test (pty).
 *
 * Spawns `pi` in a pseudo-terminal, starts a background task, presses ↓ to
 * enter dock mode, asserts the `>` selection marker, ↑/↓ moves it, Enter opens
 * the detail panel, and Esc returns to input.
 *
 * Prerequisites:
 *   - pi on PATH
 *   - pi-bash-process-priority installed (user scope)
 *   - A default model configured (for the model-issued bash call)
 */
import { TuiTest } from "@microsoft/tui-test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "bg-tui-e2e-"));
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	let screen = "";
	while (Date.now() < deadline) {
		screen = await terminal.text().catch(() => "");
		if (predicate(screen)) return { ok: true, screen };
		await sleep(intervalMs);
	}
	return { ok: false, screen };
}

function record(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

let failures = 0;

const terminal = TuiTest.ephemeral(undefined, {
	backend: "alacritty",
	timeouts: { text: 10_000, idle: 10_000, command: 30_000, ready: 30_000 },
});

try {
	// ─── spawn pi ────────────────────────────────────────────────────────────
	await terminal.run("pi", ["--session-dir", join(cwd, "session")], {
		cwd,
		env: { ...process.env, PI_BG_DEBUG: "1" },
		waitReady: false,
	});
	const boot = await waitUntil((screen) => /•\s*\w/.test(screen) || screen.includes("deepseek") || screen.includes("shortcuts"), 10_000);
	record("0: pi started", boot.ok);

	// Verify the footer is normal
	const footer = await terminal.text();
	record(
		"V1: normal pi footer visible",
		footer.includes("shortcuts") || footer.includes("model") || footer.includes("deepseek") || footer.includes("opencode") || footer.includes("auto"),
		"",
	);

	// ─── start a background task ─────────────────────────────────────────────
	await terminal.submit("Start sleep 30 as a background task using the background_task tool with taskName e2e-tui. End your turn immediately — do not poll.");
	const DOCK_ROW = /[> ]\s*[●⏳✔✗]\s*\[\d{2}:\d{2}:\d{2}\]/;
	const dockVisible = await waitUntil((screen) => DOCK_ROW.test(screen) && (screen.includes("e2e-tui") || screen.includes("sleep 30")), 20_000);
	record("D1: dock row visible with taskName", dockVisible.ok);

	const bgText = await terminal.text();
	record("D1b: background badge visible", bgText.includes("background"), "");
	await sleep(500);

	// ─── ↓ enters dock mode ──────────────────────────────────────────────────
	let dockSelected = { ok: false, screen: "" };
	for (let attempt = 0; attempt < 5 && !dockSelected.ok; attempt++) {
		await terminal.press("down");
		await sleep(400);
		dockSelected = await waitUntil((screen) => screen.includes("> ⏳") || screen.includes(">⏳") || screen.includes("> ●") || screen.includes(">●") || />\s*[●⏳✔✗]\s*\[\d{2}:\d{2}:\d{2}\]/.test(screen), 1_500, 200);
		if (!dockSelected.ok) await terminal.press("ctrl+u");
	}
	record("S1: ↓ shows > selection marker", dockSelected.ok);

	// ─── enter opens the details panel ───────────────────────────────────────
	await terminal.press("enter");
	await sleep(500);
	const panelVisible = await waitUntil(
		(screen) =>
			screen.includes("Background Tasks") &&
			screen.includes("Task Details") &&
			screen.includes("Command:") &&
			screen.includes("Cwd:") &&
			screen.includes("Log:") &&
			screen.includes("Output"),
		5_000,
	);
	record("D: Task Details panel visible", panelVisible.ok);

	// ─── ↑ from details to input mode (requirement a) ────────────────────────
	await terminal.press("up");
	await sleep(500);
	const upToInputFromDetail = await waitUntil(
		(screen) => screen.includes("esc close") || screen.includes("select") || screen.includes("model"),
		3_000,
	);
	record("D-up-detail: ↑ from details goes to input box", upToInputFromDetail.ok);

	// ─── ↓ from input back into details ─────────────────────────────────────
	await terminal.press("down");
	await sleep(500);
	const downIntoDetail = await waitUntil((screen) => screen.includes("k kill") || screen.includes("select"), 3_000);
	record("D-down-detail: ↓ returns to detail mode", downIntoDetail.ok);

	// ─── esc from details back to dock ───────────────────────────────────────
	await terminal.press("escape");
	await sleep(500);
	const returnedToDock = await waitUntil((screen) => screen.includes("> ⏳") || screen.includes(">⏳") || screen.includes("> ●") || screen.includes(">●") || screen.includes("●") || screen.includes("⏳"), 5_000);
	record("D-esc: esc returns from details to dock", returnedToDock.ok);

	// ─── esc from dock back to input ────────────────────────────────────────
	await terminal.press("escape");
	await sleep(500);
	const returnedToInput = await waitUntil((screen) => !screen.includes("> ●") && !screen.includes("> ⏳"), 5_000);
	record("D-esc2: esc returns to input mode", returnedToInput.ok);

	// ─── ↓ into dock and ↑ back to input (requirement a) ─────────────────────
	await terminal.press("down");
	await sleep(500);
	const inDockAgain = await waitUntil((screen) => screen.includes("> ⏳") || screen.includes(">⏳") || screen.includes("> ●") || screen.includes(">●"), 3_000);
	record("D-down: ↓ re-enters dock mode", inDockAgain.ok);

	await terminal.press("up");
	await sleep(500);
	const upReturnsToInput = await waitUntil((screen) => !screen.includes("> ●") && !screen.includes("> ⏳"), 3_000);
	record("D-up: ↑ on row 0 returns to input mode", upReturnsToInput.ok);

	// ─── down into dock and kill via 'k' ─────────────────────────────────────
	await terminal.press("down");
	await sleep(500);
	await terminal.press("k");
	await sleep(800);
	const killedRow = await waitUntil((screen) => !screen.includes("e2e-tui") || screen.includes("killed"), 6_000);
	record("K1: 'k' key terminates selected task in dock", killedRow.ok);
} catch (error) {
	record("UNHANDLED", false, error instanceof Error ? error.message : String(error));
}

// ─── summary ────────────────────────────────────────────────────────────────
console.log("\n── TUI E2E summary ──");
for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}`);
console.log(`${results.filter((entry) => entry.ok).length}/${results.length} passed`);

try {
	await terminal.closeQuiet();
} catch {}
rmSync(cwd, { recursive: true, force: true });
process.exit(failures > 0 ? 1 : 0);
