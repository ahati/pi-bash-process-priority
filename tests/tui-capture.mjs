#!/usr/bin/env node
/**
 * TUI capture: spawn pi in a pty, start a bg task, press ↓, capture what's
 * actually on screen at each stage. Reports exact rendered text.
 */
import { TuiTest } from "@microsoft/tui-test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "bg-capture-"));
const terminal = TuiTest.ephemeral(undefined, {
	backend: "alacritty",
	timeouts: { text: 15_000, idle: 15_000, command: 30_000, ready: 30_000 },
});

function section(title) {
	console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

try {
	// ─── 1. Launch pi ────────────────────────────────────────────────────────
	await terminal.run("pi", ["--session-dir", join(cwd, "session")], {
		cwd,
		env: { ...process.env, PI_BG_DEBUG: "1" },
		waitReady: false,
	});
	await terminal.waitIdle({ timeout: 20_000 });

	section("1. PI STARTUP — full screen text");
	console.log(await terminal.text());

	// ─── 2. Start a background task ──────────────────────────────────────────
	await terminal.submit(
		`Start sleep 20 in the background using background=true with taskName capture-test. End your turn immediately, do not poll.`,
	);
	await terminal.waitIdle({ timeout: 30_000 });
	await new Promise((r) => setTimeout(r, 2000)); // let dock render

	section("2. AFTER BACKGROUND TASK START — full screen text");
	console.log(await terminal.text());

	// Screenshot for visual inspection
	const shot1 = await terminal.screenshot(join(cwd, "1-bg-running.png"));
	console.log(`\n[screenshot: ${shot1}]`);

	// ─── 3. Press ↓ (empty editor) ───────────────────────────────────────────
	await terminal.press("down");
	await new Promise((r) => setTimeout(r, 500));
	await terminal.waitIdle({ timeout: 5_000 }).catch(() => {});

	section("3. AFTER PRESSING ↓ — full screen text");
	console.log(await terminal.text());

	const shot2 = await terminal.screenshot(join(cwd, "2-after-down.png"));
	console.log(`\n[screenshot: ${shot2}]`);

	// Check for > marker
	const downText = await terminal.text();
	if (downText.includes("> ")) {
		console.log("\n✅ > selection marker IS visible");
	} else {
		console.log("\n❌ > selection marker NOT visible");
		console.log("   Looking for any '>' character in the screen...");
		const lines = downText.split("\n");
		for (const line of lines) {
			if (line.trim().startsWith(">") || line.includes("> ●")) {
				console.log(`   Found: ${JSON.stringify(line)}`);
			}
		}
	}

	// ─── 4. Press ↓ again (move selection) ───────────────────────────────────
	await terminal.press("down");
	await new Promise((r) => setTimeout(r, 500));

	section("4. AFTER SECOND ↓ — full screen text");
	console.log(await terminal.text());

	// ─── 5. Press Enter (open details) ───────────────────────────────────────
	await terminal.press("enter");
	await new Promise((r) => setTimeout(r, 1000));
	await terminal.waitIdle({ timeout: 10_000 }).catch(() => {});

	section("5. AFTER ENTER (Task Details) — full screen text");
	console.log(await terminal.text());

	const shot3 = await terminal.screenshot(join(cwd, "3-details.png"));
	console.log(`\n[screenshot: ${shot3}]`);

	// ─── 6. Press Esc (back from details) ────────────────────────────────────
	await terminal.press("escape");
	await new Promise((r) => setTimeout(r, 500));

	section("6. AFTER ESC FROM DETAILS — full screen text");
	console.log(await terminal.text());

	// ─── 7. Press Esc again (back to input from dock) ────────────────────────
	await terminal.press("escape");
	await new Promise((r) => setTimeout(r, 500));

	section("7. AFTER ESC FROM DOCK — full screen text");
	console.log(await terminal.text());

	// ─── 8. Debug log ────────────────────────────────────────────────────────
	const debugLogPath = join(cwd, ".pi/bg-tasks/debug.log");
	if (existsSync(debugLogPath)) {
		section("8. DEBUG LOG");
		console.log(readFileSync(debugLogPath, "utf8"));
	} else {
		console.log("\n[no debug.log found at " + debugLogPath + "]");
	}
} catch (error) {
	console.error("CAPTURE ERROR:", error instanceof Error ? error.message : String(error));
	try {
		section("ERROR STATE — full screen text");
		console.log(await terminal.text());
	} catch {}
}

try {
	await terminal.closeQuiet();
} catch {}
rmSync(cwd, { recursive: true, force: true });
console.log("\n[capture complete]");
