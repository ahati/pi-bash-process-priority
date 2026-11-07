/**
 * Generates a SYNTHETIC replay fixture for the dock e2e (fake LLM output with
 * realistic timing). Used when no live provider credentials are available;
 * `npm run e2e:record` replaces it with a capture from a real model (the
 * recorder applies the same privacy scan before keeping it).
 *
 * Structure mirrors e2e/replay-provider.ts's RecordedTurn:
 *   turn 0: lead-in text deltas + a background_task tool call (deltas + end)
 *   turn 1: one-sentence confirmation
 *
 * Run: npx tsx e2e/make-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixturePath } from "./scenario.ts";
import { reportHits, scanFixture } from "./privacy.ts";

const COMMAND = "sleep 300";
const TASK_NAME = "e2e-alpha";

/** Chunk text into word-ish deltas and lay them out on a plausible cadence. */
function textEvents(text: string, startIndex: number, startAt: number): Array<{ t: number; type: string; contentIndex: number; delta?: string; content?: string }> {
	const events: Array<{ t: number; type: string; contentIndex: number; delta?: string; content?: string }> = [
		{ t: startAt, type: "text_start", contentIndex: startIndex },
	];
	let t = startAt;
	const words = text.split(" ");
	for (let i = 0; i < words.length; i++) {
		t += 35 + ((i * 17) % 40); // deterministic pseudo-human cadence: 35–75ms
		const delta = i < words.length - 1 ? `${words[i]} ` : words[i];
		events.push({ t, type: "text_delta", contentIndex: startIndex, delta });
	}
	t += 30;
	events.push({ t, type: "text_end", contentIndex: startIndex, content: text });
	return events;
}

const leadIn = "Starting the background task now.";
const confirmation = "The background task e2e-alpha is now running in the background.";

const turn0Events = [
	...textEvents(leadIn, 0, 180),
	// The model pauses to "think" about the call, then streams arguments.
	{ t: 1450, type: "toolcall_start", contentIndex: 1 },
	{ t: 1480, type: "toolcall_delta", contentIndex: 1, delta: '{"comma' },
	{ t: 1515, type: "toolcall_delta", contentIndex: 1, delta: 'nd":"sleep ' },
	{ t: 1550, type: "toolcall_delta", contentIndex: 1, delta: '300","taskNa' },
	{ t: 1585, type: "toolcall_delta", contentIndex: 1, delta: 'me":"e2e-alpha"}' },
	{
		t: 1640,
		type: "toolcall_end",
		contentIndex: 1,
		toolCall: { id: "replay-tool-1", name: "background_task", arguments: { command: COMMAND, taskName: TASK_NAME } },
	},
];

const turn1Events = textEvents(confirmation, 0, 240);

const fixture = [
	{ text: leadIn, toolCalls: [{ id: "replay-tool-1", name: "background_task", arguments: { command: COMMAND, taskName: TASK_NAME } }], events: turn0Events, stopReason: "toolUse" },
	{ text: confirmation, toolCalls: [], events: turn1Events, stopReason: "stop" },
];

const raw = JSON.stringify(fixture, null, 2) + "\n";
const hits = scanFixture(raw);
if (hits.length > 0) {
	console.error("Generated fixture failed the privacy scan — refusing to write:");
	console.error(reportHits(hits));
	process.exitCode = 1;
} else {
	mkdirSync(dirname(fixturePath), { recursive: true });
	writeFileSync(fixturePath, raw);
	console.log(`wrote synthetic fixture: ${fixturePath}`);
	console.log("run `npm run e2e` (replays it) or `npm run e2e:record` (capture a real model).");
}
