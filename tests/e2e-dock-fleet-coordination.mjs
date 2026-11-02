#!/usr/bin/env node
/**
 * E2E test verifying seamless coordination between pi-bash-process-priority (Background Tasks)
 * and pi-subagents (Subagents Fleet List) using @microsoft/tui-test.
 */
import { TuiTest } from "@microsoft/tui-test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "bg-fleet-coord-e2e-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(terminal, predicate, timeoutMs, intervalMs = 200) {
	const deadline = Date.now() + timeoutMs;
	let screen = "";
	while (Date.now() < deadline) {
		screen = await terminal.text().catch(() => "");
		if (predicate(screen)) return { ok: true, screen };
		await sleep(intervalMs);
	}
	return { ok: false, screen };
}

let failures = 0;
function record(name, ok, detail = "") {
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

// Write the scenario setup extension into .pi/extensions/
const extDir = join(cwd, ".pi", "extensions");
mkdirSync(extDir, { recursive: true });

writeFileSync(
	join(extDir, "coord-scenario.ts"),
	`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
	pi.registerCommand("setup-test-scenario", {
		description: "Spawn background tasks and mock subagent for coordination E2E test",
		handler: async (_args, ctx) => {
			const BG_KEY = Symbol.for("pi-bash:shared-task-manager");
			const bgShared = (globalThis as any)[BG_KEY];
			if (!bgShared || !bgShared.registry) {
				ctx.ui.notify("No shared background task manager found", "error");
				return;
			}
			await bgShared.registry.run("sleep 61", ctx.cwd, {
				name: "proc-alpha",
			});
			await bgShared.registry.run("sleep 62", ctx.cwd, {
				name: "proc-beta",
			});

			const MGR_KEY = Symbol.for("pi-subagents:manager");
			const mgrShared = (globalThis as any)[MGR_KEY];
			if (mgrShared && mgrShared.manager && mgrShared.manager.registry) {
				const mockRecord = {
					id: "worker-1",
					type: "general-purpose",
					description: "code-reviewer",
					status: "running",
					startedAt: Date.now(),
					session: { subscribe: () => () => {}, messages: [] },
					lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
					compactionCount: 0,
				};
				mgrShared.manager.registry.agents.set("worker-1", mockRecord);
			}

			const FLEET_KEY = Symbol.for("pi-subagents:fleet-coordinator");
			const fleetCoordinator = (globalThis as any)[FLEET_KEY];
			fleetCoordinator?.update?.();

			ctx.ui.notify("Scenario setup complete", "info");
		}
	});

	pi.registerCommand("clean-test-scenario", {
		description: "Clean up scenario tasks and mock subagents",
		handler: async (_args, ctx) => {
			const BG_KEY = Symbol.for("pi-bash:shared-task-manager");
			const bgShared = (globalThis as any)[BG_KEY];
			if (bgShared?.registry?.stopAllRunning) {
				await bgShared.registry.stopAllRunning();
			}

			const MGR_KEY = Symbol.for("pi-subagents:manager");
			const mgrShared = (globalThis as any)[MGR_KEY];
			if (mgrShared?.manager?.registry?.agents) {
				mgrShared.manager.registry.agents.clear();
			}

			const FLEET_KEY = Symbol.for("pi-subagents:fleet-coordinator");
			const fleetCoordinator = (globalThis as any)[FLEET_KEY];
			fleetCoordinator?.update?.();
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
	// ─── 1. Spawn Pi in pseudo-terminal ─────────────────────────────────────────
	await terminal.run("pi", ["--session-dir", join(cwd, "session")], {
		cwd,
		env: { ...process.env, PI_BG_DEBUG: "1" },
		waitReady: false,
	});

	const boot = await waitUntil(
		terminal,
		(screen) => /•\s*\w/.test(screen) || screen.includes("shortcuts") || screen.includes("deepseek"),
		10_000,
	);
	record("1: Pi booted successfully in terminal", boot.ok);

	// ─── 2. Setup Background Tasks and Subagents Fleet ──────────────────────────
	await terminal.submit("/setup-test-scenario");
	const setupDone = await waitUntil(
		terminal,
		(screen) => screen.includes("sleep 61") && screen.includes("sleep 62") && screen.includes("Subagents Fleet"),
		10_000,
	);
	record("2: Background tasks and Subagents Fleet rendered together", setupDone.ok);

	// Check Visual Appearance:
	// a) Both tasks visible
	// b) Section separator "── Subagents Fleet ──" visible
	// c) Fleet rows "main" and "code-reviewer" visible
	// d) Markers are dimmed when inactive (no bright selection marker)
	const initialScreen = await terminal.text();
	const hasTasksAndFleet =
		initialScreen.includes("sleep 61") &&
		initialScreen.includes("sleep 62") &&
		initialScreen.includes("Subagents Fleet") &&
		initialScreen.includes("main") &&
		initialScreen.includes("code-reviewer");
	record("2a: Clean visual stacking (Background Tasks above Subagents Fleet)", hasTasksAndFleet);

	const dimmedMarkers = initialScreen.includes("○ main") && !initialScreen.includes(">") && !initialScreen.includes("● main");
	record("2b: Inactive sections display dimmed markers (no '>' in dock, '○' in fleet)", dimmedMarkers);

	// ─── 3. Down arrow at empty prompt enters Background Tasks Dock ─────────────
	await terminal.press("down");
	const dockSelected = await waitUntil(
		terminal,
		(screen) => screen.includes(">") && screen.includes("sleep 61"),
		3_000,
	);
	record("3: Down arrow at empty prompt enters dock (sleep 61 selected with '>')", dockSelected.ok);

	const dockScreen1 = await terminal.text();
	record("3a: Subagents Fleet remains dimmed ('○ main') while dock is active", dockScreen1.includes("○ main") && !dockScreen1.includes("● main"));

	// ─── 4. Down arrow navigates within Background Tasks Dock ───────────────────
	await terminal.press("down");
	const dockSelected2 = await waitUntil(
		terminal,
		(screen) => {
			const lines = screen.split("\n");
			const line2 = lines.find((l) => l.includes("sleep 62"));
			return line2 && line2.includes(">");
		},
		3_000,
	);
	record("4: Down arrow moves selection down in dock (sleep 62 selected with '>')", dockSelected2.ok);

	// ─── 5. Down arrow past bottom task transitions into Subagents Fleet ─────────
	await terminal.press("down");
	const fleetActive = await waitUntil(
		terminal,
		(screen) => screen.includes("● main") && !screen.includes(">"),
		3_000,
	);
	record("5: Down arrow past bottom task transitions into Subagents Fleet ('● main' selected)", fleetActive.ok);

	// ─── 6. Navigate within Subagents Fleet ─────────────────────────────────────
	await terminal.press("down");
	const fleetSubagentSelected = await waitUntil(
		terminal,
		(screen) => screen.includes("code-reviewer") && !screen.includes("● main") && (screen.includes("● Agent") || screen.includes("●")),
		3_000,
	);
	record("6: Down arrow moves selection in fleet to subagent row ('● code-reviewer')", fleetSubagentSelected.ok);

	await terminal.press("up");
	const fleetMainSelected = await waitUntil(
		terminal,
		(screen) => screen.includes("● main"),
		3_000,
	);
	record("6a: Up arrow moves selection back to '● main'", fleetMainSelected.ok);

	// ─── 7. Up arrow above 'main' transitions back to Background Tasks Dock ─────
	await terminal.press("up");
	const returnedToDock = await waitUntil(
		terminal,
		(screen) => {
			const lines = screen.split("\n");
			const line2 = lines.find((l) => l.includes("sleep 62"));
			return line2 && line2.includes(">") && screen.includes("○ main");
		},
		3_000,
	);
	record("7: Up arrow above 'main' transitions back into dock (sleep 62 selected with '>')", returnedToDock.ok);

	// ─── 8. Navigate up to top task and exit to Prompt editor ───────────────────
	await terminal.press("up"); // moves to sleep 61
	const dockTopSelected = await waitUntil(
		terminal,
		(screen) => {
			const lines = screen.split("\n");
			const line1 = lines.find((l) => l.includes("sleep 61"));
			return line1 && line1.includes(">");
		},
		3_000,
	);
	record("8: Up arrow moves to top task sleep 61 with '>'", dockTopSelected.ok);

	await terminal.press("up"); // exits dock to prompt
	const exitedToPrompt = await waitUntil(
		terminal,
		(screen) => !screen.includes(">") && screen.includes("○ main"),
		3_000,
	);
	record("8a: Up arrow at top task exits dock to Prompt editor", exitedToPrompt.ok);

	// ─── 9. Tab key switches between Dock and Fleet ──────────────────────────────
	await terminal.press("down"); // re-enter dock
	await waitUntil(terminal, (s) => s.includes(">"), 3_000);

	await terminal.press("tab"); // Tab switches dock -> fleet
	const tabToFleet = await waitUntil(
		terminal,
		(screen) => screen.includes("● main") && !screen.includes(">"),
		3_000,
	);
	record("9: Tab key switches focus from dock to fleet ('● main')", tabToFleet.ok);

	await terminal.press("tab"); // Tab switches fleet -> dock
	const tabToDock = await waitUntil(
		terminal,
		(screen) => screen.includes(">") && screen.includes("○ main"),
		3_000,
	);
	record("9a: Tab key switches focus from fleet back to dock ('>')", tabToDock.ok);

	await terminal.press("escape"); // Esc exits to prompt
	const escToPrompt = await waitUntil(
		terminal,
		(screen) => !screen.includes(">") && screen.includes("○ main"),
		3_000,
	);
	record("9b: Escape key exits to Prompt editor", escToPrompt.ok);

	// ─── 10. Task Details view: Fleet steps aside for maximum log height ─────────
	await terminal.press("down"); // enter dock
	await waitUntil(terminal, (s) => s.includes(">"), 3_000);
	await terminal.press("enter"); // open task details

	const detailsOpen = await waitUntil(
		terminal,
		(screen) => screen.includes("Task Details") || screen.includes("Output"),
		3_000,
	);
	record("10: Enter opens Task Details view in dock", detailsOpen.ok);

	const detailsScreen = await terminal.text();
	const fleetSteppedAside = !detailsScreen.includes("Subagents Fleet") && !detailsScreen.includes("code-reviewer");
	record("10a: Fleet list temporarily steps aside so Task Details has maximum height", fleetSteppedAside);

	await terminal.press("escape"); // Esc closes Task Details
	const fleetRestored = await waitUntil(
		terminal,
		(screen) => screen.includes("Subagents Fleet") && screen.includes("sleep 61"),
		3_000,
	);
	record("10b: Esc closes Task Details and restores Subagents Fleet immediately", fleetRestored.ok);
	record("10b: Esc closes Task Details and restores Subagents Fleet immediately", fleetRestored.ok);

	// ─── Clean up ───────────────────────────────────────────────────────────────
	await terminal.submit("/clean-test-scenario");
	await sleep(500);

} catch (err) {
	console.error("Test execution failed with error:", err);
	failures++;
} finally {
	try {
		await terminal.submit("/exit");
	} catch {}
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n────────────────────────────────────────────────────────────────");
if (failures === 0) {
	console.log("🎉 ALL E2E DOCK-FLEET COORDINATION CHECKS PASSED!");
	process.exit(0);
} else {
	console.error(`💥 ${failures} check(s) failed.`);
	process.exit(1);
}
