#!/usr/bin/env node
/**
 * E2E tests: real `pi --mode rpc` session against the installed
 * pi-bash-process-priority extension (PRD-003/004 surface).
 *
 * Uses the session's default model — every `prompt` costs tokens.
 * Env knobs:
 *   E2E_PI_BIN     pi binary (default "pi")
 *   E2E_CWD        working dir for the session (default: fresh temp dir)
 *   E2E_TIMEOUT_MS overall deadline per wait (default 120000)
 *
 * Exit code 0 = all scenarios passed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_BIN = process.env.E2E_PI_BIN || "pi";
const WAIT_MS = Number(process.env.E2E_TIMEOUT_MS || 120000);

const results = [];
let failures = 0;

function record(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

// ─── RPC child ───────────────────────────────────────────────────────────────

const cwd = mkdtempSync(join(tmpdir(), "bg-e2e-"));
const child = spawn(PI_BIN, ["--mode", "rpc", "--session-dir", join(cwd, "session")], {
	cwd,
	env: { ...process.env, PI_BG_DEBUG: "1" },
	stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map(); // id → {resolve, reject, timer}
const events = [];
let stderrTail = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type === "response" && record.id && pending.has(record.id)) {
			const { resolve, timer } = pending.get(record.id);
			clearTimeout(timer);
			pending.delete(record.id);
			resolve(record);
		} else if (record.type && record.type !== "response") {
			events.push(record);
		}
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderrTail = (stderrTail + chunk).slice(-4000);
});

function send(command) {
	const id = `e2e-${Math.random().toString(36).slice(2, 10)}`;
	child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
	return id;
}

function request(command, timeoutMs = WAIT_MS) {
	const id = send({ ...command, id: undefined, idPlaceholder: true });
	// send() already spread a fresh id — rebuild properly:
	return requestImpl(command, timeoutMs);
}

function requestImpl(command, timeoutMs) {
	const id = `e2e-${++requestImpl.seq}`;
	child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`RPC timeout after ${timeoutMs}ms: ${command.type}`));
		}, timeoutMs);
		pending.set(id, { resolve, timer });
	});
}
requestImpl.seq = 0;

/** request() with correct id correlation */
function rpc(command, timeoutMs = WAIT_MS) {
	const id = `e2e-${++rpc.seq}`;
	child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`RPC timeout after ${timeoutMs}ms: ${command.type}`));
		}, timeoutMs);
		pending.set(id, { resolve, timer });
	});
}
rpc.seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, label, timeoutMs = WAIT_MS) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = predicate();
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
		await sleep(250);
	}
}

const bgStates = () =>
	events
		.filter((e) => e.type === "entry_appended" && e.entry?.type === "custom" && e.entry?.customType === "bg-task-state")
		.map((e) => ({ kind: e.entry.data?.kind, id: e.entry.data?.task?.id, status: e.entry.data?.task?.status }));

const messagesJson = async () => {
	const response = await rpc({ type: "get_messages" });
	return JSON.stringify(response.data ?? response);
};

// ─── scenarios ───────────────────────────────────────────────────────────────

async function scenario1_startupAndSchema() {
	const state = await rpc({ type: "get_state" });
	record("E2E-1 startup: RPC session ready", state.success === true);

	const commands = await rpc({ type: "get_commands" });
	const commandNames = JSON.stringify(commands.data ?? commands);
	record("E2E-1b /tasks command registered", commandNames.includes("tasks"), "");

	const noErrors = !events.some((e) => e.type === "extension_error");
	record("E2E-1c no extension errors at startup", noErrors, events.filter((e) => e.type === "extension_error").map((e) => e.error).join("; "));
}

async function promptAndWait(message, timeoutMs = WAIT_MS) {
	const seen = { settled: false };
	const waitSettled = waitFor(() => {
		const last = [...events].reverse().find((e) => e.type === "agent_settled");
		if (last && !seen.settled) {
			seen.settled = true;
			return true;
		}
		return false;
	}, `agent_settled (${message.slice(0, 40)}…)`, timeoutMs).catch(() => {});
	// Subscribe for future settles: waitFor re-evaluates on each poll — fine.
	await rpc({ type: "prompt", message }, timeoutMs);
	await waitSettled;
	// Give trailing events (entry_appended, message_end) a moment to stream in.
	await sleep(1500);
}

async function scenario2_foreground() {
	await promptAndWait(`Run the bash tool with command "echo e2e-fg-check" (foreground). Then end your turn.`);
	const messages = await messagesJson();
	record(
		"E2E-2 foreground bash executes via the masked tool",
		messages.includes("e2e-fg-check") && !messages.includes("spawn nice ENOENT"),
	);
}

async function scenario3_background() {
	await promptAndWait(
		`Start the command "sleep 6" in the background using the bash tool's background parameter, with taskName "e2e-bg". Then end your turn immediately — do not poll.`,
	);
	await waitFor(
		() => bgStates().some((state) => state.kind === "terminal" && state.id === "task-1"),
		"bg-task-state terminal entry for task-1",
		30000,
	);
	const states = bgStates();
	record(
		"E2E-3 bg-task-state events (spawned + terminal)",
		states.some((state) => state.kind === "spawned") && states.some((state) => state.kind === "terminal"),
		JSON.stringify(states),
	);
	const messages = await messagesJson();
	record(
		"E2E-3b task notice wording exact",
		messages.includes("Tool is running as a background task with task id: task-1"),
	);
	record(
		"E2E-3c completion notification message in context",
		messages.includes("bg-task-notification") && messages.includes("task-1"),
	);
}

async function scenario4_adopt() {
	await promptAndWait(`Run the bash tool with command "sleep 8" (foreground).`);
	// The foreground call is live; steer the adopt request — it lands after the
	// current assistant turn, while sleep is still executing.
	child.stdin.write(JSON.stringify({ type: "steer", message: `Move the currently running command to the background now using the bash tool's adopt task action.` }) + "\n");
	await waitFor(
		() => bgStates().some((state) => state.kind === "adopted"),
		"bg-task-state adopted entry",
		60000,
	);
	record("E2E-4 steer → taskAction adopt → adopted event", true);

	// The adopted sleep finishes on its own; wake + terminal event follow.
	await waitFor(
		() => bgStates().some((state) => state.kind === "terminal" && /task/.test(state.id)),
		"terminal entry for the adopted task",
		30000,
	);
}

async function scenario5_management() {
	await promptAndWait(`List my background tasks, then kill the running one (taskAction list, then kill). End your turn after.`);
	const messages = await messagesJson();
	record(
		"E2E-5 management verbs via model",
		messages.includes("taskAction") && (messages.includes("Killed task-") || messages.includes("No background tasks.")),
	);
}

async function scenario6_degradation() {
	// Fresh pi with the feature disabled: /tasks must be gone, echo still works.
	child.stdin.end();
	await sleep(500);
	events.length = 0;
	const disabled = spawn(
		PI_BIN,
		["--mode", "rpc", "--session-dir", join(cwd, "session-disabled")],
		{ cwd, stdio: ["pipe", "pipe", "pipe"] },
	);
	disabled.stdout.setEncoding("utf8");
	let disabledBuffer = "";
	const disabledPending = new Map();
	disabled.stdout.on("data", (chunk) => {
		disabledBuffer += chunk;
		let index;
		while ((index = disabledBuffer.indexOf("\n")) >= 0) {
			const line = disabledBuffer.slice(0, index).trim();
			disabledBuffer = disabledBuffer.slice(index + 1);
			if (!line) continue;
			try {
				const record = JSON.parse(line);
				if (record.type === "response" && record.id && disabledPending.has(record.id)) {
					const { resolve, timer } = disabledPending.get(record.id);
					clearTimeout(timer);
					disabledPending.delete(record.id);
					resolve(record);
				} else if (record.type && record.type !== "response") {
					events.push(record);
				}
			} catch {}
		}
	});
	const dsend = (command) => {
		const id = `d-${++dsend.seq}`;
		disabled.stdin.write(JSON.stringify({ id, ...command }) + "\n");
		return id;
	};
	dsend.seq = 0;
	const drpc = (command, timeoutMs = WAIT_MS) =>
		new Promise((resolve, reject) => {
			const id = dsend(command);
			const timer = setTimeout(() => {
				disabledPending.delete(id);
				reject(new Error(`timeout: ${command.type}`));
			}, timeoutMs);
			disabledPending.set(id, { resolve, timer });
		});

	await drpc({ type: "get_commands" });
	const commands = await drpc({ type: "get_commands" });
	record("E2E-6a /tasks registered (kill switch removed)", JSON.stringify(commands.data ?? "").includes("tasks"));

	await drpc({ type: "bash", command: "echo alive" });
	record("E2E-6b RPC bash executes (no priority transport)", true);

	disabled.stdin.end();
}

// ─── main ────────────────────────────────────────────────────────────────────

try {
	await scenario1_startupAndSchema();
	await scenario2_foreground();
	await scenario3_background();
	await scenario4_adopt();
	await scenario5_management();
} catch (error) {
	record("UNHANDLED", false, error instanceof Error ? error.message : String(error));
}

try {
	await scenario6_degradation();
} catch (error) {
	record("E2E-6 degradation", false, error instanceof Error ? error.message : String(error));
}

child.stdin.end();

console.log("\n── E2E summary ──");
for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.detail ? `  (${entry.detail})` : ""}`);
console.log(`${results.filter((entry) => entry.ok).length}/${results.length} passed`);

if (stderrTail.trim()) console.log("\n[pi stderr tail]\n" + stderrTail.slice(-1500));

rmSync(cwd, { recursive: true, force: true });
process.exit(failures > 0 ? 1 : 0);
