/**
 * Shared constants for the PRD-007 e2e record/replay harness.
 *
 * The e2e drives the REAL agent path: a user prompt → streamed model response
 * → `background_task` tool call → dock reacts. The model is a fixture:
 * `e2e/fixtures/dock-spawn.json` is captured once from a live provider
 * (`npm run e2e:record`) and replayed deterministically afterwards
 * (`npm run e2e`), including the recorded inter-chunk timing.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const e2eDir = dirname(fileURLToPath(import.meta.url));

/** The prompt both the recording run and the replay e2e submit. */
export const SPAWN_PROMPT =
	"Use the background_task tool to start `sleep 300` in the background with taskName e2e-alpha. " +
	"After it starts, confirm in one short sentence.";

export const fixturePath = join(e2eDir, "fixtures", "dock-spawn.json");

/** Replay speed divisor: recorded inter-chunk delays are divided by this. */
export const replaySpeed = Number(process.env.PI_DOCK_E2E_REPLAY_SPEED ?? 4);

/** Provider/model used by the one-time recording run (real network, real key). */
export const recordProvider = process.env.PI_DOCK_E2E_RECORD_PROVIDER ?? "opencode";
export const recordModel = process.env.PI_DOCK_E2E_RECORD_MODEL ?? "glm-5.3-flash";
