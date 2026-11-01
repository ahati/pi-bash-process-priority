#!/usr/bin/env node
/**
 * E2E regression (tui-test / real pty): dock mode must release the keyboard
 * when the background task finishes on its own. Hard-capped under 30s.
 *
 * Reported bug: after pressing ↓ into dock mode, a task that finishes (or times
 * out) disappears from the dock widget by itself — but `DockController.active`
 * stayed true, so `DockEditor.handleInput` kept swallowing every keystroke
 * ("Everything else is swallowed while the dock has focus") and the user had to
 * press Esc to get the input box back.
 *
 * Flow: real model starts a background task → ↓ into dock mode → hands off →
 * task completes → type a token and assert it reaches the input box (no Esc).
 *
 * Run: node tests/e2e-tui-autorelease.mjs
 * Prerequisites: `pi` on PATH, extension installed at user scope, a model configured.
 */
import { TuiTest } from "@microsoft/tui-test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARD_LIMIT_MS = 28_000; // strictly under 30s
const started = Date.now();
const cwd = mkdtempSync(join(tmpdir(), "bg-autorelease-"));
const results = [];
let failures = 0;
let finished = false;
let terminal;

function record(name, ok, detail = "") {
	results.push({ name, ok });
	if (!ok) failures++;
	const trimmed = String(detail).replace(/\s+/g, " ").slice(0, 120);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${trimmed ? ` — ${trimmed}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A dock row: "  ● [HH:MM:SS] <cmd> running · 3s" ("> " prefix when selected). */
const DOCK_ROW = /[> ]\s*[●⏳✔✗]\s*\[\d{2}:\d{2}:\d{2}\]/;
const DOCK_ROW_SELECTED = />\s*[●⏳✔✗]\s*\[\d{2}:\d{2}:\d{2}\]/;

async function waitUntil(predicate, timeoutMs, intervalMs = 300) {
	const deadline = Math.min(Date.now() + timeoutMs, started + HARD_LIMIT_MS);
	let screen = "";
	while (Date.now() < deadline && !finished) {
		screen = await terminal.text().catch(() => "");
		if (predicate(screen)) return { ok: true, screen };
		await sleep(intervalMs);
	}
	return { ok: false, screen };
}

async function finish(reason) {
	if (finished) return;
	finished = true;
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	if (reason) record("WATCHDOG", false, reason);
	console.log(`\n── autorelease E2E: ${results.filter((r) => r.ok).length}/${results.length} passed in ${elapsed}s ──`);
	try {
		await terminal?.closeQuiet();
	} catch {}
	rmSync(cwd, { recursive: true, force: true });
	process.exit(failures > 0 ? 1 : 0);
}

// Strict cap: never run past 28s, whatever state we are in.
setTimeout(() => void finish("hard 28s limit reached"), HARD_LIMIT_MS).unref();

try {
	terminal = TuiTest.ephemeral(undefined, {
		backend: "alacritty",
		timeouts: { text: 3_000, idle: 3_000, command: 10_000, ready: 10_000 },
	});

	await terminal.run("pi", ["--session-dir", join(cwd, "session")], {
		cwd,
		env: { ...process.env, PI_BG_DEBUG: "1" },
		waitReady: false,
	});
	const boot = await waitUntil((screen) => /•\s*\w/.test(screen), 8_000);
	record("0: pi started", boot.ok);

	// ── background task via the real model ──────────────────────────────────
	await terminal.submit("Testing something, run a background task (sleep 12) using the background_task tool");
	const spawned = await waitUntil((screen) => DOCK_ROW.test(screen), 15_000);
	record("A1: dock row visible (task running)", spawned.ok, spawned.screen.slice(-90));
	if (!spawned.ok) await finish();

	// ── ↓ enters dock mode ──────────────────────────────────────────────────
	let dock = { ok: false, screen: "" };
	for (let attempt = 0; attempt < 3 && !dock.ok && !finished; attempt++) {
		await terminal.press("down");
		await sleep(400);
		dock = await waitUntil((screen) => DOCK_ROW_SELECTED.test(screen), 1_500, 200);
		if (!dock.ok) await terminal.press("ctrl+u");
	}
	record("A2: ↓ enters dock mode (selected row marker)", dock.ok, dock.screen.slice(-90));
	if (!dock.ok) await finish();

	// ── hands off: the task ends by itself ──────────────────────────────────
	const gone = await waitUntil((screen) => !DOCK_ROW.test(screen), 18_000);
	record("A3: dock row disappeared by itself", gone.ok, gone.screen.slice(-90));

	// ── the regression: typing must work with NO Esc press ──────────────────
	const token = "autorelax9q";
	await terminal.type(token);
	await sleep(350);
	const typed = await terminal.text().catch(() => "");
	record("A4: typing reaches the input box WITHOUT pressing Esc", typed.includes(token), typed.slice(-90));

	// ── debug trace proof ───────────────────────────────────────────────────
	const logPath = join(cwd, ".pi/bg-tasks/debug.log");
	if (existsSync(logPath)) {
		const log = readFileSync(logPath, "utf8");
		record(
			"A5: controller auto-released dock mode (debug trace)",
			log.includes("auto-exited dock mode") || log.includes("had no selectable row"),
		);
	} else {
		record("A5: debug trace present", false, `missing ${logPath}`);
	}
} catch (error) {
	record("UNHANDLED", false, error instanceof Error ? error.message : String(error));
} finally {
	await finish();
}
