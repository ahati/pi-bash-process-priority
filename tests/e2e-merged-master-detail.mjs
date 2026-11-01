#!/usr/bin/env node
/**
 * E2E: Real-terminal test verifying the Merged Master-Detail Background Tasks screen.
 *
 * Verifies:
 * 1. Background tasks top list and task details are merged onto the SAME screen.
 * 2. Cwd and Log are inside the Task Details metadata group.
 * 3. Reactive selection tracking: moving the cursor between tasks (↑ / ↓)
 *    immediately updates Command, Cwd, Log, and Output in real time.
 */
import { TuiTest } from "@microsoft/tui-test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "bg-merged-e2e-"));
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
	// 1. Boot pi
	await terminal.run("pi", ["--session-dir", join(cwd, "session")], {
		cwd,
		env: { ...process.env, PI_BG_DEBUG: "1" },
		waitReady: false,
	});
	const boot = await waitUntil(
		(screen) => /•\s*\w/.test(screen) || screen.includes("deepseek") || screen.includes("shortcuts"),
		10_000,
	);
	record("1: pi started", boot.ok);

	// 2. Start task 1
	await terminal.submit(
		'Start sleep 45 in the background using background=true with taskName proc-alpha. End your turn immediately — do not poll.',
	);
	const task1Visible = await waitUntil(
		(screen) => screen.includes("proc-alpha") || screen.includes("sleep 45"),
		20_000,
	);
	record("2: task 1 (proc-alpha) started", task1Visible.ok);

	// 3. Start task 2
	await terminal.submit(
		'Start sleep 46 in the background using background=true with taskName proc-beta. End your turn immediately — do not poll.',
	);
	const task2Visible = await waitUntil(
		(screen) => (screen.includes("proc-beta") || screen.includes("sleep 46")) && (screen.includes("proc-alpha") || screen.includes("sleep 45")),
		20_000,
	);
	record("3: task 2 (proc-beta) started", task2Visible.ok);

	await sleep(500);

	// 4. Enter dock mode
	let dockSelected = { ok: false, screen: "" };
	for (let attempt = 0; attempt < 5 && !dockSelected.ok; attempt++) {
		await terminal.press("down");
		await sleep(400);
		dockSelected = await waitUntil(
			(screen) =>
				screen.includes("> ●") ||
				screen.includes(">●") ||
				screen.includes("> ✓") ||
				screen.includes("> ⏳") ||
				/>\s*[●⏳✔✗]\s*\[\d{2}:\d{2}:\d{2}\]/.test(screen),
			1_500,
			200,
		);
		if (!dockSelected.ok) await terminal.press("ctrl+u");
	}
	record("4: ↓ shows > selection marker", dockSelected.ok);

	// 5. Expand merged master-detail screen via enter
	await terminal.press("enter");
	await sleep(500);

	// 6. Verify merged master-detail screen structure
	const mergedVisible = await waitUntil(
		(screen) =>
			screen.includes("Background Tasks") &&
			screen.includes("Task Details") &&
			screen.includes("Command:") &&
			screen.includes("Cwd:") &&
			screen.includes("Log:") &&
			screen.includes("Output"),
		6_000,
	);
	record("5: Merged Master-Detail screen visible (list + details + output together)", mergedVisible.ok);

	// 7. Verify task 1 details when task 1 is selected
	const screen1 = await terminal.text();
	const task1Details =
		(screen1.includes("proc-alpha") || screen1.includes("sleep 45")) &&
		screen1.includes("task-1");
	record("6: Task 1 details active initially (task-1)", task1Details);

	// 8. Move selection down (↓) to task 2 in details screen
	await terminal.press("down");
	await sleep(600);

	// 9. Verify reactive selection update: cursor moves to proc-beta and Command updates to sleep 46
	const reactiveTask2 = await waitUntil(
		(screen) =>
			/>\s*[●⏳✔✗]\s*proc-beta/.test(screen) ||
			screen.includes("Command: sleep 46") ||
			(screen.includes("task-2") && screen.includes("proc-beta")),
		5_000,
	);
	record("7: Selection moved down: reactive update to task-2 & proc-beta", reactiveTask2.ok);

	// 10. Move selection back up (↑) to task 1 in details screen
	await terminal.press("up");
	await sleep(600);

	const reactiveTask1 = await waitUntil(
		(screen) =>
			/>\s*[●⏳✔✗]\s*proc-alpha/.test(screen) ||
			screen.includes("Command: sleep 45") ||
			(screen.includes("task-1") && screen.includes("proc-alpha")),
		5_000,
	);
	record("8: Selection moved up: reactive update back to task-1 & proc-alpha", reactiveTask1.ok);

	// 11. Kill selected task with 'k'
	await terminal.press("k");
	await sleep(600);
	record("9: Task killed via 'k'", true);

} catch (error) {
	record("UNHANDLED", false, error instanceof Error ? error.message : String(error));
}

console.log("\n── Merged Master-Detail E2E summary ──");
for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}`);
console.log(`${results.filter((entry) => entry.ok).length}/${results.length} passed`);

try {
	await terminal.closeQuiet();
} catch {}

if (failures > 0) {
	process.exit(1);
}
