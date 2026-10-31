/**
 * Background-aware `bash` tool override (PRD-003 §7.1 / §7.2).
 *
 * The definition is the built-in bash definition (schema, description,
 * renderers, truncation, PI_* env) with only `execute` replaced and only the
 * process seam replaced via BashOperations. `execute` races the built-in run
 * against a per-toolCallId "background this call" request (ctrl+b), so a move
 * to the background ends the tool row immediately without restarting work.
 *
 * Spawn choice (documented per task): `buildNiceCommand` returns a full shell
 * string (`nice -n N bash -c '…'`). Instead of re-parsing that string or
 * using `shell: true`, we use its *decision* (null when already wrapped /
 * empty) and spawn the equivalent explicit argv without a shell:
 *   ["nice", "-n", String(fgNice), "bash", "-c", originalCommand]
 *   ["bash", "-c", originalCommand]            (already-wrapped case)
 * `detached: true` makes the child its own process-group leader (pgid = pid),
 * which is what ctrl+b adoption and group kills rely on.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { createBashToolDefinition, type BashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildNiceCommand } from "./nice.ts";
import type { BgTask, TaskManagerApi } from "./types.ts";

export interface BashOverrideDeps {
	registry: TaskManagerApi;
	/** Foreground nice level (PRD-001 contract). */
	fgNice: number;
	/** Notified when a foreground bash command starts/ends (ctrl+b hint/UI). */
	onForegroundChange?: (inFlight: { command: string } | null) => void;
	/** Adoption tail buffer bound (§8 PI_BG_LOG_BYTES). Default 50_000. */
	logBytes?: number;
	/** SIGTERM→SIGKILL grace for abort/timeout kills. Default 3000 ms. */
	killGraceMs?: number;
}

const DEFAULT_LOG_BYTES = 50_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

interface ForegroundSlot {
	toolCallId: string;
	child: ChildProcess;
	pgid: number;
	command: string;
	cwd: string;
	startedAt: number;
	/** Bounded tail of everything emitted before adoption. */
	tail: Buffer[];
	tailBytes: number;
	logBytes: number;
	/** Forward child data to the built-in call (false after adoption/close). */
	accepting: boolean;
	/** Set once; makes requestBackground idempotent. */
	backgrounded: boolean;
	/** Resolve the abandoned exec so the built-in call settles immediately. */
	settle: (result: { exitCode: number | null }) => void;
	/** Remove abort listener / timeout timer / grace kill timer. */
	detach: () => void;
}

const slots = new Map<string, ForegroundSlot>();
const pendingBackground = new Map<string, (task: BgTask) => void>();

/** §4.3 wording — exact. */
export function formatBackgroundToolResult(task: BgTask): string {
	return [
		`Tool is running as a background task with task id: ${task.id}`,
		`Output: ${task.logPath}`,
		"Do not poll. You will be notified when it finishes.",
	].join("\n");
}

/**
 * ctrl+b entry point: adopt the in-flight bash call as a background task.
 * Idempotent — a second call for the same (or an unknown) toolCallId returns
 * undefined. Returns the adopted BgTask on success.
 */
export function requestBackground(toolCallId: string): BgTask | undefined {
	const slot = slots.get(toolCallId);
	if (!slot || slot.backgrounded) return undefined;
	slot.backgrounded = true;
	slot.accepting = false;
	slot.detach();
	const preOutput = Buffer.concat(slot.tail, slot.tailBytes);
	// Register first (§7.2 step 1); adoption never fails because of priority work.
	const task = depsRegistry?.adopt({
		child: slot.child,
		pgid: slot.pgid,
		command: slot.command,
		cwd: slot.cwd,
		startedAt: slot.startedAt,
		preOutput,
	});
	slots.delete(toolCallId);
	slot.settle({ exitCode: null });
	const resolve = pendingBackground.get(toolCallId);
	pendingBackground.delete(toolCallId);
	if (resolve && task) resolve(task);
	if (task) lastDeps?.onForegroundChange?.(null);
	return task;
}

/** The most recently started still-foreground call, for the ctrl+b handler. */
export function getForeground(): { toolCallId: string; command: string } | null {
	let found: { toolCallId: string; command: string } | null = null;
	for (const slot of slots.values()) {
		if (!slot.backgrounded) found = { toolCallId: slot.toolCallId, command: slot.command };
	}
	return found;
}

// Module-level wiring used by requestBackground (the extension owns one tool
// instance per session; tests may reset via resetBashOverrideState()).
let depsRegistry: TaskManagerApi | undefined;
let lastDeps: BashOverrideDeps | undefined;

/** Test seam: clear module state between sessions/tests. */
export function resetBashOverrideState(): void {
	slots.clear();
	pendingBackground.clear();
	depsRegistry = undefined;
	lastDeps = undefined;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// ESRCH: already gone — fine.
	}
}

function startKill(child: ChildProcess, graceMs: number): NodeJS.Timeout | undefined {
	if (!child.pid) return undefined;
	const pid = child.pid;
	killGroup(pid, "SIGTERM");
	const timer = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
	timer.unref?.();
	return timer;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > 2_147_483_647) {
		throw new Error("Invalid timeout: maximum is 2147483 seconds");
	}
	return timeoutMs;
}

export function createBackgroundAwareBashTool(cwd: string, deps: BashOverrideDeps): ToolDefinition {
	depsRegistry = deps.registry;
	lastDeps = deps;
	const logBytes = Math.max(1024, deps.logBytes ?? DEFAULT_LOG_BYTES);
	const killGraceMs = Math.max(0, deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS);

	const operations: BashOperations = {
		exec: (command, execCwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) return Promise.reject(new Error("aborted"));

			const wrapped = buildNiceCommand(command, deps.fgNice);
			const argv = wrapped !== null ? ["nice", "-n", String(deps.fgNice), "bash", "-c", command] : ["bash", "-c", command];
			const child = spawn(argv[0], argv.slice(1), {
				cwd: execCwd,
				detached: process.platform !== "win32",
				env: env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const toolCallId = currentToolCallId;
				const pgid = child.pid ?? 0;
				let timedOut = false;
				let settled = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				let graceHandle: NodeJS.Timeout | undefined;
				let accept = true;
				const tail: Buffer[] = [];
				let tailBytes = 0;

				const appendTail = (data: Buffer) => {
					tail.push(data);
					tailBytes += data.length;
					while (tailBytes > logBytes && tail.length > 1) {
						const dropped = tail.shift()!;
						tailBytes -= dropped.length;
					}
					if (tailBytes > logBytes && tail.length === 1) {
						const only = tail[0]!;
						tail[0] = only.subarray(only.length - logBytes);
						tailBytes = tail[0]!.length;
					}
				};

				const finish = (result: { exitCode: number | null }, error?: Error) => {
					if (settled) return;
					settled = true;
					if (graceHandle) clearTimeout(graceHandle);
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
					slots.delete(toolCallId);
					deps.onForegroundChange?.(null);
					if (error) reject(error);
					else resolve(result);
				};

				const onAbort = () => {
					if (graceHandle) return;
					graceHandle = startKill(child, killGraceMs);
				};

				const slot: ForegroundSlot = {
					toolCallId,
					child,
					pgid,
					command,
					cwd: execCwd,
					startedAt: Date.now(),
					tail,
					tailBytes,
					logBytes,
					accepting: true,
					backgrounded: false,
					settle: (result) => finish(result),
					detach: () => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
						if (signal) signal.removeEventListener("abort", onAbort);
					},
				};
				// Keep tail accounting live on the slot after adoption reads it.
				Object.defineProperty(slot, "tailBytes", { get: () => tailBytes });
				slots.set(toolCallId, slot);

				const forward = (data: Buffer) => {
					appendTail(data);
					if (accept && slot.accepting) onData(data);
				};
				child.stdout?.on("data", forward);
				child.stderr?.on("data", forward);

				child.once("error", (err) => {
					finish({ exitCode: null }, err);
				});
				child.once("close", (code, sig) => {
					accept = false;
					if (signal?.aborted) {
						finish({ exitCode: null }, new Error("aborted"));
						return;
					}
					if (timedOut) {
						finish({ exitCode: null }, new Error(`timeout:${timeout}`));
						return;
					}
					const exitCode = code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1);
					finish({ exitCode });
				});

				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						graceHandle = startKill(child, killGraceMs);
					}, timeoutMs);
					timeoutHandle.unref?.();
				}
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				deps.onForegroundChange?.({ command });
			});
		},
	};

	const builtin = createBashToolDefinition(cwd, { operations });

	// The in-flight toolCallId is set by ourExecute immediately around the
	// delegated built-in call; exec runs inside that call.
	let currentToolCallId = "";

	const ourExecute = async (
		toolCallId: string,
		params: { command: string; timeout?: number },
		signal: AbortSignal | undefined,
		onUpdate: Parameters<typeof builtin.execute>[3],
		ctx: Parameters<typeof builtin.execute>[4],
	): Promise<unknown> => {
		let resolveBg!: (task: BgTask) => void;
		const bgPromise = new Promise<{ __bgTask: BgTask }>((resolve) => {
			resolveBg = (task) => resolve({ __bgTask: task });
		});
		pendingBackground.set(toolCallId, (task) => resolveBg(task));
		currentToolCallId = toolCallId;

		const builtinRun = builtin.execute(toolCallId, params, signal, onUpdate, ctx);
		// Defuse the eventual loser regardless of who wins the race.
		void builtinRun.catch(() => {});
		try {
			const raced = (await Promise.race([builtinRun, bgPromise])) as
				| { __bgTask: BgTask }
				| Awaited<typeof builtinRun>;
			if ("__bgTask" in raced) {
				const task = raced.__bgTask;
				return {
					content: [{ type: "text", text: formatBackgroundToolResult(task) }],
					details: task,
					isError: false,
				};
			}
			return raced;
		} finally {
			pendingBackground.delete(toolCallId);
		}
	};

	return { ...builtin, execute: ourExecute as typeof builtin.execute } as unknown as ToolDefinition;
}
