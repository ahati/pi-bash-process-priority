/**
 * E2E-only model provider: record-and-replay of real LLM output (PRD-007 §12).
 *
 * Two modes, selected by `PI_DOCK_E2E_RECORD`:
 *
 * **Record** (set to the provider/model to capture, e.g. `1` + explicit flags):
 *   Does not register anything. Captures the *normalized* stream events of
 *   every assistant turn (`message_update` events carry the exact
 *   `assistantMessageEvent` pi fed the UI, stamped with `Date.now()` deltas)
 *   plus the finalized message, and appends one turn per assistant message to
 *   `e2e/fixtures/dock-spawn.json`. This is the "capture the LLM output with
 *   relevant timing info" step.
 *
 * **Replay** (default; the provider is named `replay`, model `scripted`):
 *   `pi.registerProvider("replay", …)` with a custom `api` and a
 *   `streamSimple` that re-emits turn N of the fixture — same deltas, same
 *   order, same inter-chunk pauses (divided by `PI_DOCK_E2E_REPLAY_SPEED`,
 *   default 4). No network, no API key. Turn N is chosen by counting the
 *   assistant messages already in `context.messages`, so a fixed scenario
 *   script replays turn-for-turn. If the agent produces more turns than were
 *   recorded, the last recorded turn is replayed again (deterministic
 *   fallback; logged via `console.error`).
 *
 * Not part of the shipped extension — loaded explicitly via `pi -e` in the
 * e2e harness only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
	ToolCall,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { fixturePath, replaySpeed } from "./scenario.ts";
import { reportHits, scanFixture } from "./privacy.ts";

// ─── Fixture shape ───────────────────────────────────────────────────────────

interface RecordedEvent {
	/** ms since the turn's first stream event. */
	t: number;
	type: string;
	contentIndex?: number;
	delta?: string;
	/** toolcall_end carries the completed call — id/name/arguments ONLY:
	 *  opaque provider fields (thoughtSignature etc.) are deliberately
	 *  stripped so they never reach the committed fixture. */
	toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
	content?: string;
}

interface RecordedTurn {
	text: string;
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	/** Normalized stream events with timing — replayed verbatim. */
	events: RecordedEvent[];
	stopReason: string;
}

function loadFixture(): RecordedTurn[] {
	if (!existsSync(fixturePath)) return [];
	const raw = readFileSync(fixturePath, "utf8");
	// Belt & suspenders: refuse to replay a fixture that would smuggle
	// credentials or personal identifiers through the harness.
	const hits = scanFixture(raw);
	if (hits.length > 0) {
		throw new Error(`Replay fixture failed the privacy scan — remove ${fixturePath}:\n${reportHits(hits)}`);
	}
	return JSON.parse(raw) as RecordedTurn[];
}

function saveFixture(turns: RecordedTurn[]): void {
	mkdirSync(fixturePath.substring(0, fixturePath.lastIndexOf("/")), { recursive: true });
	writeFileSync(fixturePath, JSON.stringify(turns, null, 2) + "\n");
}

// ─── Record mode ─────────────────────────────────────────────────────────────

function attachRecorder(pi: ExtensionAPI): void {
	let turns: RecordedTurn[] = [];
	let buffer: RecordedTurn | undefined;
	let turnStartedAt = 0;

	pi.on("turn_start", () => {
		buffer = undefined;
		turnStartedAt = 0;
	});

	pi.on("message_update", (event) => {
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant") return;
		const ev = event.assistantMessageEvent as AssistantMessageEvent;
		if (ev.type === "start" || ev.type === "done" || ev.type === "error") return;

		if (turnStartedAt === 0) turnStartedAt = Date.now();
		buffer ??= { text: "", toolCalls: [], events: [], stopReason: "stop" };
		const recorded: RecordedEvent = { t: Date.now() - turnStartedAt, type: ev.type };
		if ("contentIndex" in ev) recorded.contentIndex = ev.contentIndex;
		if ("delta" in ev) {
			recorded.delta = ev.delta;
			if (ev.type === "text_delta") buffer.text += ev.delta;
		}
		if ("content" in ev && ev.type === "text_end") {
			recorded.content = ev.content;
			buffer.text = ev.content;
		}
		if (ev.type === "toolcall_end" && ev.toolCall) {
			recorded.toolCall = {
				id: ev.toolCall.id,
				name: ev.toolCall.name,
				arguments: ev.toolCall.arguments as Record<string, unknown>,
			};
			buffer.toolCalls.push(recorded.toolCall);
		}
		buffer.events.push(recorded);
	});

	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant" || !buffer) return;
		buffer.stopReason = String(message.stopReason);
		// Prefer the finalized message content over the delta accumulation.
		buffer.text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		buffer.toolCalls = message.content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.map((block) => ({
				id: block.id,
				name: block.name,
				arguments: block.arguments as Record<string, unknown>,
			}));
		turns.push(buffer);
		buffer = undefined;
		turnStartedAt = 0;
		saveFixture(turns);
	});

	pi.on("session_shutdown", () => {
		if (turns.length > 0) saveFixture(turns);
	});
}

// ─── Replay mode ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function buildBaseMessage(model: Model<"dock-e2e-replay">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamReplay(
	model: Model<"dock-e2e-replay">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const turns = loadFixture();
			if (turns.length === 0) throw new Error("No replay fixture. Run `npm run e2e:record` first.");

			const assistantSoFar = context.messages.filter((m) => m.role === "assistant").length;
			const turn = turns[Math.min(assistantSoFar, turns.length - 1)];
			if (assistantSoFar >= turns.length) {
				console.error(
					`[replay-provider] scenario has more turns (${assistantSoFar + 1}) than recorded (${turns.length}); replaying the last turn again`,
				);
			}

			const message = buildBaseMessage(model);
			stream.push({ type: "start", partial: message });

			let previous = 0;
			const signal = options?.signal;
			for (const event of turn.events) {
				if (signal?.aborted) {
					message.stopReason = "aborted";
					message.errorMessage = "aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
					stream.end();
					return;
				}
				await sleep((event.t - previous) / replaySpeed);
				previous = event.t;

				const index = event.contentIndex ?? 0;
				switch (event.type) {
					case "text_start":
					case "thinking_start": {
						const kind = event.type === "text_start" ? "text" : "thinking";
						message.content[index] =
							kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
						stream.push({ type: event.type, contentIndex: index, partial: message } as AssistantMessageEvent);
						break;
					}
					case "text_delta": {
						const block = message.content[index];
						if (block?.type === "text") block.text += event.delta ?? "";
						stream.push({
							type: "text_delta",
							contentIndex: index,
							delta: event.delta ?? "",
							partial: message,
						} as AssistantMessageEvent);
						break;
					}
					case "thinking_delta": {
						const block = message.content[index];
						if (block?.type === "thinking") block.thinking += event.delta ?? "";
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: event.delta ?? "",
							partial: message,
						} as AssistantMessageEvent);
						break;
					}
					case "text_end":
					case "thinking_end": {
						stream.push({
							type: event.type,
							contentIndex: index,
							content: event.content ?? "",
							partial: message,
						} as AssistantMessageEvent);
						break;
					}
					case "toolcall_start": {
						// The completed call arrives with toolcall_end; synthesize the
						// start block from the recorded end so ids/names match.
						const end = [...turn.events]
							.reverse()
							.find((e) => e.type === "toolcall_end" && e.contentIndex === index)?.toolCall;
						message.content[index] = {
							type: "toolCall",
							id: end?.id ?? `replay-${index}`,
							name: end?.name ?? "",
							arguments: {},
						};
						stream.push({ type: "toolcall_start", contentIndex: index, partial: message } as AssistantMessageEvent);
						break;
					}
					case "toolcall_delta": {
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: event.delta ?? "",
							partial: message,
						} as AssistantMessageEvent);
						break;
					}
					case "toolcall_end": {
						if (event.toolCall) {
							// Re-apply the "toolCall" discriminator: the loop filters
							// message.content by block.type to find pending calls.
							message.content[index] = {
								...message.content[index],
								...event.toolCall,
								type: "toolCall",
							};
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: message.content[index] as ToolCall,
								partial: message,
							} as AssistantMessageEvent);
						}
						break;
					}
					default:
						break;
				}
			}

			message.stopReason = turn.toolCalls.length > 0 ? "toolUse" : (turn.stopReason as AssistantMessage["stopReason"]);
			stream.push({
				type: "done",
				reason: turn.toolCalls.length > 0 ? "toolUse" : "stop",
				message,
			});
			stream.end();
		} catch (error) {
			message.stopReason = "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end();
		}
	})();

	return stream;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export default function replayProvider(pi: ExtensionAPI): void {
	if (process.env.PI_DOCK_E2E_RECORD) {
		attachRecorder(pi);
		return;
	}

	pi.registerProvider("replay", {
		name: "Dock E2E Replay",
		baseUrl: "http://dock-e2e.invalid",
		apiKey: "unused", // literal — the replay never dials out
		api: "dock-e2e-replay",
		models: [
			{
				id: "scripted",
				name: "Recorded Script",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		streamSimple: streamReplay,
	});
}
