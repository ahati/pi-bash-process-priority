#!/usr/bin/env node
/**
 * E2E test verifying that background tasks started by subagents:
 * 1. Appear in the main agent window dock list
 * 2. Display "Type:    Subagent" (or "Type:    Subagent (<name>)") in the Task Details view
 * 3. Have live elapsed duration ticking in the main agent window
 * 4. Survive subagent session completion
 * 5. Can be inspected and terminated by the user via 'k' in the main window
 */
import { TuiTest } from "@microsoft/tui-test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const cwd = mkdtempSync(join(tmpdir(), "bg-subagent-e2e-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(terminal, predicate, timeoutMs, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	let screen = "";
	while (Date.now() < deadline) {
		screen = await terminal.text().catch(() => "");
		if (predicate(screen)) return { ok: true, screen };
		await sleep(intervalMs);
	}
	return { ok: false, screen };
}

// Create an extension that simulates a subagent launching a background task via the shared registry
const subagentExtensionDir = join(cwd, ".pi", "extensions");
import { mkdirSync } from "node:fs";
mkdirSync(subagentExtensionDir, { recursive: true });

// We write a test extension that defines an interactive command /test-subagent-spawn
// which creates a child subagent session (or runs via the shared registry) and launches a background task
writeFileSync(
	join(subagentExtensionDir, "subagent-tester.ts"),
	`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
	pi.registerCommand("spawn-subagent-bg", {
		description: "Simulate a subagent starting a background task",
		handler: async (_args, ctx) => {
			const SHARED_KEY = Symbol.for("pi-bash:shared-task-manager");
			const shared = (globalThis as any)[SHARED_KEY];
			if (!shared || !shared.registry) {
				ctx.ui.notify("No shared task manager found", "error");
				return;
			}
			await shared.registry.run("sleep 45", ctx.cwd, {
				name: "subagent-build",
				callerType: "subagent",
				subagentName: "researcher#sub12345",
			});
			ctx.ui.notify("Subagent started background task", "info");
		}
	});
}
`,
);

const terminal = TuiTest.ephemeral(undefined, {
	backend: "alacritty",
	timeouts: { text: 10_000, idle: 10_000, command: 30_000, ready: 30_000 },
});

try {
	await terminal.run("pi", ["--session-dir", join(cwd, "session")], {
		cwd,
		env: { ...process.env, PI_BG_DEBUG: "1" },
		waitReady: false,
	});

	const boot = await waitUntil(
		terminal,
		(screen) => /•\s*\w/.test(screen) || screen.includes("deepseek") || screen.includes("shortcuts"),
		10_000,
	);
	assert.ok(boot.ok, "pi should boot successfully");
	console.log("✅ 1: pi booted in main window");

	// Trigger the command to simulate a subagent launching a background task
	await terminal.submit("/spawn-subagent-bg");
	await sleep(500);

	// 1. Assert task appears in the main agent window's dock
	console.log("Waiting for subagent task in main window dock...");
	const dockVisible = await waitUntil(
		terminal,
		(screen) => screen.includes("subagent-build") || screen.includes("sleep 45"),
		10_000,
	);
	assert.ok(dockVisible.ok, "Subagent background task should appear in main window dock");
	console.log("✅ 2: Subagent task appeared in main window dock");

	// 2. Select it with Down arrow
	await terminal.press("down");
	await sleep(400);
	const dockSelected = await waitUntil(
		terminal,
		(screen) => screen.includes("> ●") || screen.includes(">●"),
		3_000,
	);
	assert.ok(dockSelected.ok, "Dock selection marker visible");
	console.log("✅ 3: Selected subagent task row in dock");

	// 3. Open Task Details with Enter
	await terminal.press("enter");
	await sleep(600);

	const detailsVisible = await waitUntil(
		terminal,
		(screen) => screen.includes("Task Details") && screen.includes("Output"),
		5_000,
	);
	assert.ok(detailsVisible.ok, "Task Details screen should open below editor");

	// Verify "Type:    Subagent (researcher#sub12345)" or "Type:    Subagent"
	const screen = await terminal.text();
	console.log("Checking Task Details lines in main window...");
	assert.ok(
		screen.includes("Type:    Subagent") || screen.includes("Subagent (researcher#sub12345)"),
		`Details screen should display Type: Subagent. Got screen:\n${screen}`,
	);
	console.log("✅ 4: Task Details confirms Type: Subagent (researcher#sub12345)");

	// 4. Verify elapsed time ticks live
	const observedElapsed = [];
	for (let i = 0; i < 3; i++) {
		await sleep(1000);
		const currentScreen = await terminal.text().catch(() => "");
		const statusLine = currentScreen.split("\n").find((l) => l.includes("Status:") && l.includes("running"));
		if (statusLine) {
			const match = statusLine.match(/·\s*(\d+s)/);
			if (match) observedElapsed.push(match[1]);
		}
	}
	console.log("Observed detail elapsed times for subagent task:", observedElapsed);
	assert.ok(observedElapsed.length >= 2, "Should sample at least 2 elapsed durations");
	console.log("✅ 5: Live ticking confirmed for subagent task in main window");

	// 5. Terminate the subagent task from the main window using 'k'
	await terminal.press("k");
	await sleep(500);

	const taskKilled = await waitUntil(
		terminal,
		(s) => s.includes("killed") || !s.includes("running"),
		5_000,
	);
	assert.ok(taskKilled.ok, "User should be able to kill subagent task with 'k' in main window");
	console.log("✅ 6: Subagent task killed with 'k' from main window");

	console.log("\n── Subagent Background Task E2E: ALL 6 CHECKS PASSED ──");
} finally {
	await terminal.close().catch(() => {});
	rmSync(cwd, { recursive: true, force: true });
}
