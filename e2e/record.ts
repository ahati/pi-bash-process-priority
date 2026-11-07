/**
 * One-time capture run: drives a REAL model (opencode/glm-5.3-flash by
 * default, override with PI_DOCK_E2E_RECORD_PROVIDER/_MODEL) through the
 * dock-spawn scenario and records its normalized stream output — deltas,
 * tool calls, and inter-chunk timing — into e2e/fixtures/dock-spawn.json.
 *
 * `npm run e2e` then replays this fixture deterministically (see
 * e2e/replay-provider.ts). Requires working provider credentials once.
 *
 * Run: npm run e2e:record
 */
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { TuiTest } from "@microsoft/tui-test";
import { fixturePath, recordModel, recordProvider, SPAWN_PROMPT } from "./scenario.ts";
import { reportHits, scanFixture } from "./privacy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "index.ts");
const recorder = join(here, "replay-provider.ts");
const artifacts = join(here, "artifacts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const terminal = TuiTest.ephemeral("dock-record", { backend: "xtermjs" });

async function main(): Promise<void> {

try {
	await terminal.run(
		"pi",
		[
			"-e", ext,
			"-e", recorder,
			"--no-extensions",
			"--no-session",
			// Minimal context: no AGENTS.md/context files, no skills. Whatever the
			// model outputs is frozen into a committed fixture, so the recording
			// environment must not inject personal content in the first place.
			"--no-context-files",
			"--no-skills",
			"--provider", recordProvider,
			"--model", recordModel,
			"--tui-mode", "fullscreen",
		],
		{ cols: 110, rows: 40, cwd: "/tmp" },
	);
	await terminal.getByText("escape interrupt").expect({ timeout: 20000 });
	await sleep(600);

	console.log(`recording ${recordProvider}/${recordModel} …`);
	await terminal.submit(SPAWN_PROMPT);

	// The task appears as soon as the model's tool call executes.
	await terminal.getByText("task-1").expect({ timeout: 90000 });
	await sleep(8000); // let the confirmation turn stream and finalize

	// Poll the fixture until both turns are captured.
	let turns: Array<{ toolCalls: Array<{ name: string }> }> = [];
	for (let i = 0; i < 10; i++) {
		if (existsSync(fixturePath)) {
			turns = JSON.parse(readFileSync(fixturePath, "utf8"));
			if (turns.length >= 2 && turns[0].toolCalls.some((c) => c.name === "background_task")) break;
		}
		await sleep(2000);
	}

	if (turns.length < 2 || !turns[0].toolCalls.some((c) => c.name === "background_task")) {
		console.error("RECORD FAILED: expected 2 turns with a background_task tool call in turn 1.");
		console.error(`fixture at ${fixturePath}:`);
		console.error(existsSync(fixturePath) ? readFileSync(fixturePath, "utf8") : "(missing)");
		process.exitCode = 1;
		return;
	}

	// Privacy gate: provider/model names are fine; the operator's identity and
	// credential-shaped material are not. On any hit, quarantine the fixture
	// OUTSIDE the repo and fail — nothing suspect stays in the tree.
	const rawFixture = readFileSync(fixturePath, "utf8");
	const hits = scanFixture(rawFixture);
	if (hits.length > 0) {
		const quarantine = join(tmpdir(), "dock-e2e-quarantined-fixture.json");
		try {
			unlinkSync(quarantine);
		} catch {}
		renameSync(fixturePath, quarantine);
		console.error("RECORD BLOCKED — the captured output failed the privacy scan:");
		console.error(reportHits(hits));
		console.error(`fixture quarantined to ${quarantine} (review manually; it is NOT in the repo)`);
		process.exitCode = 1;
		return;
	}


	console.log("recorded fixture:");
	for (const [i, turn] of turns.entries()) {
		console.log(
			`  turn ${i}: ${turn.toolCalls.map((c) => c.name).join(",") || "text"} · ${JSON.stringify(turn.text).slice(0, 90)} · ${turn.events.length} events`,
		);
	}
	console.log(`\nwrote ${fixturePath}`);
	console.log("now run `npm run e2e` — it replays this fixture with no network.");
} catch (error) {
	console.error("RECORD HARNESS ERROR:", error);
	process.exitCode = 1;
} finally {
	await terminal.closeQuiet();
}
}

await main();
