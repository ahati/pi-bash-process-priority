/**
 * Probe: launch pi with the extension, spawn a task, dump the screens so we
 * can pin the real layout before writing final assertions.
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

const terminal = TuiTest.ephemeral("dock-probe", { backend: "xtermjs" });

try {
	await terminal.run(
		"pi",
		["-e", ext, "-e", driver, "--no-extensions", "--no-session", "--no-context-files", "--no-skills", "--offline", "--tui-mode", "fullscreen"],
		{ cols: COLS, rows: ROWS, cwd: "/tmp" },
	);
	await sleep(4000);
	await terminal.screenshot(join(artifacts, "00-startup.svg"));
	console.log("=== STARTUP SCREEN ===");
	console.log(await terminal.text());

	// Spawn a task through the shared registry.
	await terminal.submit("/spawn seq 1 60; sleep 180");
	await sleep(2500);
	await terminal.screenshot(join(artifacts, "01-compact-dock.svg"));
	console.log("=== AFTER /spawn (compact dock expected) ===");
	console.log(await terminal.text());

	// Open the expanded master-detail view.
	await terminal.submit("/tasks");
	await sleep(1500);
	await terminal.screenshot(join(artifacts, "02-expanded.svg"));
	console.log("=== AFTER /tasks (expanded expected) ===");
	console.log(await terminal.text());
} finally {
	await terminal.closeQuiet();
}
