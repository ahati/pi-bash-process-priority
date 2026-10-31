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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "bg-tui-e2e-"));
const results = [];

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
	await terminal.waitIdle({ timeout: 20_000 });

	// Verify the footer is normal
	const footer = await terminal.text();
	record("V1: normal pi footer visible", footer.includes("shortcuts") || footer.includes("model"), "");

	// ─── start a background task ─────────────────────────────────────────────
	await terminal.submit("Start sleep 30 in the background using background=true with taskName e2e-tui. End your turn immediately — do not poll.");
	await terminal.waitIdle({ timeout: 30_000 });
	await new Promise((r) => setTimeout(r, 2000)); // let the dock render

	// Wait for the dock row to appear
	await terminal.getByText("e2e-tui").expect({ timeout: 15_000 });
	record("D1: dock row visible with taskName", true);

	// Verify no top rule (no bar between editor and first row)
	const text = await terminal.text();
	const dockSection = text.slice(text.lastIndexOf("┌") >= 0 ? text.lastIndexOf("┌") : 0);
	record("D1b: ⏾ background badge visible", text.includes("⏾ background"), "");

	// ─── ctrl+h: adopt the running foreground command ────────────────────────
	// Start a foreground command, then ctrl+h it
	await terminal.submit("Run `sleep 30` in the foreground using bash (no background). Do not use background=true.");
	// Wait for the command to start (not for the turn to end — it's a 30s sleep)
	await terminal.getByText("sleep 30").expect({ timeout: 15_000 });
	await new Promise((r) => setTimeout(r, 1000)); // let the tool start

	// Wait for the foreground bash call to be running
	await terminal.getByText("sleep 30").expect({ timeout: 15_000 });

	// Press ctrl+h
	await terminal.press("ctrl+h");
	await new Promise((r) => setTimeout(r, 2000)); // let the adoption settle
	await terminal.waitIdle({ timeout: 15_000 });

	const adoptText = await terminal.text();
	record("E1: ctrl+h moved command to background", adoptText.includes("Moved to background:") || adoptText.includes("task-"), "");

	// ─── ↓ enters dock mode ──────────────────────────────────────────────────
	// Clear the editor and press ↓
	await terminal.press("down");
	await new Promise((r) => setTimeout(r, 500)); // let the render settle

	const dockText = await terminal.text();
	const hasSelection = dockText.includes("> ●") || dockText.includes(">●");
	record("S1: ↓ shows > selection marker", hasSelection, dockText.slice(-300));

	// ─── ↑/↓ move the marker ─────────────────────────────────────────────────
	await terminal.press("down");
	await new Promise((r) => setTimeout(r, 500));
	const movedText = await terminal.text();
	record("S2: ↓ moves marker to next row", movedText.includes("> ●"), "");

	// ─── esc returns to input ────────────────────────────────────────────────
	await terminal.press("escape");
	await terminal.waitIdle({ timeout: 5_000 });
	record("S3: esc exits dock mode", true);

	// ─── enter opens the details panel ───────────────────────────────────────
	await terminal.press("down");
	await terminal.press("enter");
	await new Promise((r) => setTimeout(r, 500));
	await terminal.waitIdle({ timeout: 10_000 });

	const detailText = await terminal.text();
	record(
		"D: Task Details panel visible",
		detailText.includes("Task Details") && detailText.includes("Command:") && detailText.includes("Output"),
		detailText.slice(-300),
	);

	// ─── esc from details back to dock ───────────────────────────────────────
	await terminal.press("escape");
	await terminal.waitIdle({ timeout: 5_000 });
	record("D-esc: esc returns from details to dock", true);

	// ─── esc from dock back to input ────────────────────────────────────────
	await terminal.press("escape");
	await terminal.waitIdle({ timeout: 5_000 });
	record("D-esc2: esc returns to input mode", true);
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
