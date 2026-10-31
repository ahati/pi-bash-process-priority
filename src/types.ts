/**
 * Shared contracts for PRD-003 background tasks.
 *
 * Pure types only: no pi imports, no node side-effects — every module in the
 * feature (registry, bash override, bg_task tool, UI, tests) codes against
 * this file so the pieces stay independently testable and swappable.
 * See docs/background-task-design-and-ui.md (§6 architecture, §7 design).
 */

// ---------------------------------------------------------------------------
// Task model (§7.3)
// ---------------------------------------------------------------------------

export type BgTaskStatus = "running" | "completed" | "failed" | "killed";

/** Who started the work. Mirrors agy's `Type: Agent` semantics (§7.8). */
export type BgTaskOrigin = "bg_task" | "foreground-adopted";

/** Notification payload kinds rendered by the §7.10 message renderer. */
export type BgNotificationKind = "terminal" | "still-running";

export interface BgTask {
	/** "task-N" — N from a monotonically increasing session counter (§7.3). */
	id: string;
	/** Original command text, unwrapped (no nice prefix). */
	command: string;
	/** Optional model-provided name; survives into notifications and lists. */
	name?: string;
	origin: BgTaskOrigin;
	status: BgTaskStatus;
	pid: number | null;
	/** Process group id the whole tree lives in (spawned detached). */
	pgid: number | null;
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** <logDir>/task-N.log — merged stdout+stderr (§7.3). */
	logPath: string;
	/** For killed tasks: why (signal name, "session shutdown", user kill…). */
	reason?: string;
}

/**
 * Structured payload attached to every `bg-task-notification` custom message
 * (§7.6). NOT sent to the model — it drives the §7.10 message renderer and
 * the session_start registry rebuild.
 */
export interface BgNotificationDetails {
	kind: BgNotificationKind;
	task: BgTask;
	/** Preformatted for the renderer: "2m 01s" / "45s" (§7.8). */
	durationText?: string;
	/** Preformatted start clock "HH:MM:SS" (local). */
	startedClock?: string;
	/** For kind "still-running": seconds elapsed since start. */
	elapsedSeconds?: number;
}

// ---------------------------------------------------------------------------
// Registry contract (§7.3) — implemented by src/registry.ts
// ---------------------------------------------------------------------------

/** A foreground bash child handed over by ctrl+b (§7.2 adoption input). */
export interface ForegroundHandle {
	child: import("node:child_process").ChildProcess;
	/** POSIX group id (negative-pid kill target). */
	pgid: number;
	command: string;
	cwd: string;
	startedAt: number;
	/**
	 * Output captured before adoption (bounded tail, ≤ PI_BG_LOG_BYTES) —
	 * prepended to the task log so it contains the full history.
	 */
	preOutput: Buffer;
}

export interface TaskManagerOptions {
	/** Directory for task logs (§8 PI_BG_TASK_LOG_DIR). */
	logDir: string;
	/** SIGTERM→SIGKILL grace (§8 PI_BG_KILL_GRACE_MS). */
	killGraceMs: number;
	/** Model-visible log read cap + adoption tail buffer (§8 PI_BG_LOG_BYTES). */
	logBytes: number;
	/** Finished tasks retained before eviction (§8 PI_BG_TASKS_MAX). */
	maxFinished: number;
	/** Fired on every state change (spawn/adopt/exit/kill) — drives UI. */
	onChange?: () => void;
	/**
	 * Fired once per task on terminal transition. The wiring layer (index.ts)
	 * turns this into the §7.6 notification + §7.10 renderer message.
	 */
	onTerminal?: (task: BgTask) => void;
	/**
	 * Fired on every registry transition (PRD-004 §6): "spawned" when a task
	 * starts via run(), "adopted" when a foreground call is adopted, "terminal"
	 * when it reaches a final state. Drives bg-task-state event entries.
	 */
	onTransition?: (kind: "spawned" | "adopted" | "terminal", task: BgTask) => void;
	/** Background nice applied at spawn/adoption (default 19). */
	bgNice?: number;
	/** Absolute `nice` binary path; when set, spawn uses it instead of bare PATH lookup. */
	niceBin?: string;
	/** Absolute `ionice` binary path (spawn-time for bg tasks). */
	ioniceBin?: string;
	/** Absolute `renice` binary path (adoption-time). */
	reniceBin?: string;
	/** ionice class applied at spawn/adoption (0 disables; default 3). */
	ioniceClass?: number;
	/** One-shot still-running notice (§7.6), armed by notificationTimeoutSeconds. */
	onStillRunning?: (task: BgTask, elapsedSeconds: number) => void;
}

export interface RunOptions {
	/** Optional human-readable task name (agy: name survives backgrounding). */
	name?: string;
	/**
	 * Still-running notice timeout in seconds (§7.6). The registry arms the
	 * timer and reports through onTerminal with kind "still-running" semantics
	 * via the stillRunning callback below; the task keeps running regardless.
	 */
	notificationTimeoutSeconds?: number;
	/**
	 * Hard wall-clock limit: kill the task after this many seconds (§4.1 —
	 * background commands may run up to PI_BASH_TIMEOUT_BG_MAX, default 300).
	 * The task is killed with reason `timeout (<n>s)`.
	 */
	timeoutSeconds?: number;
}

export interface TaskManagerApi {
	/** Start `command` at bg priority; resolves once the child spawns. */
	run(command: string, cwd: string, options?: RunOptions): Promise<BgTask>;
	/** Adopt a foreground child (ctrl+b) — never restarts or kills it (§7.2). */
	adopt(handle: ForegroundHandle, opts?: { name?: string; notificationTimeoutSeconds?: number }): BgTask;
	/** SIGTERM → grace → SIGKILL the whole group; ESRCH counts as success. */
	kill(idOrPrefix: string, reason?: string): Promise<string>;
	/** Write `<input>\n` to the task's stdin. */
	sendInput(idOrPrefix: string, input: string): string;
	/** All tasks, running first, then finished newest-first. */
	list(): BgTask[];
	/** Exact id or unique prefix lookup ("2" → "task-2"); undefined if unknown. */
	get(idOrPrefix: string): BgTask | undefined;
	/** Tail-capped log read (≤ maxBytes) with `[Full output: …]` notice. */
	logs(idOrPrefix: string, maxBytes?: number): Promise<string>;
	/**
	 * Rebuild from prior transcript details on session_start (§7.3): inserts
	 * finished tasks as-is; tasks that were `running` become
	 * `killed (session ended)`; the id counter resumes past the max seen.
	 */
	rebuild(tasks: BgTask[]): void;
	/** True while any task is running (dock/footer visibility). */
	hasRunning(): boolean;
	/** Kill everything still running; idempotent; for session_shutdown. */
	disposeAll(reason?: string): Promise<void>;
	/**
	 * Subscribe to registry changes (spawn/adopt/exit/kill). Returns an
	 * unsubscribe function. UI surfaces (dock, panel) use this to refresh.
	 */
	onChange(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Probes (§7.4) — implemented in src/probe.ts
// ---------------------------------------------------------------------------

/** Result of the per-session priority probe (fail-open inputs). */
export interface PriorityProbe {
	/** nice available (PRD-001 probe). */
	nice: boolean;
	/** `renice -n <level> -g <pgid>` works (needed for ctrl+b adoption). */
	renice: boolean;
	/** ionice available (only meaningful when ioniceClass !== 0). */
	ionice: boolean;
}

// ---------------------------------------------------------------------------
// Config (§8) — implemented in src/config.ts
// ---------------------------------------------------------------------------

export interface BgConfig {
	/** Foreground nice (PI_BASH_NICE_LEVEL, default 10) — PRD-001 contract. */
	fgNice: number;
	/** Background nice (PI_BG_NICE_LEVEL, default 19, clamped ≥ fgNice). */
	bgNice: number;
	/** Background IO class (PI_BG_IONICE_CLASS, default 3; 0 = off). */
	ioniceClass: number;
	/** PI_BG_TASKS_DISABLE=1 disables the whole feature. */
	disabled: boolean;
	/** Platform gate: win32 without WSL is inert (PRD-002). */
	supportedPlatform: boolean;
	logDir: string | undefined; // undefined → default <cwd>/.pi/bg-tasks
	tasksMax: number;
	killGraceMs: number;
	logBytes: number;
	/** Foreground timeout cap in seconds (PI_BASH_FG_TIMEOUT_MAX, default 60). */
	fgTimeoutMax: number;
	/** Background timeout cap in seconds (PI_BASH_TIMEOUT_BG_MAX, default 300). */
	bgTimeoutMax: number;
}
