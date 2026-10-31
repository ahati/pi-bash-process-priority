/**
 * TaskManager registry for PRD-003 background tasks (§7.3/§7.4/§7.6).
 *
 * Pure node + local helpers: no pi imports, so the whole state machine is
 * unit-testable with real short-lived child processes.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import { escapeSingleQuotes } from "./nice.ts";
import type {
	BgTask,
	ForegroundHandle,
	RunOptions,
	TaskManagerApi,
	TaskManagerOptions,
} from "./types.ts";

const DEFAULT_BG_NICE = 19;
const DEFAULT_IONICE_CLASS = 3;
const PRIORITY_TIMEOUT_MS = 5000;

interface TaskRecord {
	task: BgTask;
	child?: ChildProcess;
	fd?: number;
	logBroken: boolean;
	memory: string;
	memoryTruncated: boolean;
	closed: Promise<void>;
	resolveClosed: () => void;
	finalized: boolean;
	killRequested: boolean;
	stillTimer?: NodeJS.Timeout;
	timeoutTimer?: NodeJS.Timeout;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** ISO-8601 timestamp in local time (the `[started]` header line). */
function localIso(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
		`${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
	);
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
	return String(error);
}

function delayWait(closed: Promise<void>, ms: number): Promise<boolean> {
	if (ms <= 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(false);
			}
		}, ms);
		timer.unref?.();
		closed.then(() => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(true);
			}
		});
	});
}

/**
 * Resolve `task-N`, a unique id prefix, or bare digits ("2" → "task-2").
 * Exact matches win; ambiguous/unknown ids throw.
 */
export function resolveTaskId(tasks: BgTask[], idOrPrefix: string): BgTask {
	const raw = typeof idOrPrefix === "string" ? idOrPrefix.trim() : "";
	if (raw === "") throw new Error(`Unknown background task: ${idOrPrefix}`);

	const exact = tasks.find((task) => task.id === raw);
	if (exact) return exact;

	const normalized = /^\d+$/.test(raw) ? `task-${raw}` : raw;
	const normalizedExact = tasks.find((task) => task.id === normalized);
	if (normalizedExact) return normalizedExact;

	const matches = tasks.filter((task) => task.id.startsWith(normalized));
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous background task id "${raw}" (matches ${matches.map((task) => task.id).join(", ")})`,
		);
	}
	throw new Error(`Unknown background task: ${raw}`);
}

class TaskManager implements TaskManagerApi {
	private readonly options: TaskManagerOptions;
	private readonly changeListeners = new Set<() => void>();
	private readonly niceBin?: string;
	private readonly ioniceBin?: string;
	private readonly reniceBin?: string;
	private readonly logDir: string;
	private readonly killGraceMs: number;
	private readonly logBytes: number;
	private readonly maxFinished: number;
	private readonly bgNice: number;
	private readonly ioniceClass: number;
	private readonly records = new Map<string, TaskRecord>();
	private counter = 1;

	constructor(options: TaskManagerOptions) {
		this.options = options;
		this.niceBin = options.niceBin;
		this.ioniceBin = options.ioniceBin;
		this.reniceBin = options.reniceBin;
		this.logDir = options.logDir;
		this.killGraceMs = Math.max(0, Math.floor(options.killGraceMs));
		this.logBytes = Math.max(1024, Math.floor(options.logBytes));
		this.maxFinished = Math.max(0, Math.floor(options.maxFinished));
		this.bgNice = clamp(options.bgNice ?? DEFAULT_BG_NICE, 1, 19);
		this.ioniceClass = clamp(options.ioniceClass ?? DEFAULT_IONICE_CLASS, 0, 3);
	}

	async run(command: string, cwd: string, options: RunOptions = {}): Promise<BgTask> {
		const rec = this.createRecord({
			command,
			origin: "bg_task",
			name: options.name,
			pid: null,
			pgid: null,
			startedAt: Date.now(),
		});
		const wrapped = this.buildBgCommandAbs(command);

		return new Promise<BgTask>((resolve, reject) => {
			let spawned = false;
			let child: ChildProcess;
			try {
				child = spawn("bash", ["-c", wrapped], {
					cwd,
					detached: true,
					stdio: ["pipe", "pipe", "pipe"],
					env: process.env,
				});
			} catch (error) {
				this.dropRecord(rec);
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}

			rec.child = child;
			rec.task.pid = child.pid ?? null;
			rec.task.pgid = child.pid ?? null;

			child.once("spawn", () => {
				spawned = true;
				this.armStillRunning(rec, options.notificationTimeoutSeconds);
				this.armTimeout(rec, options.timeoutSeconds);
				this.emitChange();
				this.options.onTransition?.("spawned", this.snapshot(rec));
				resolve(this.snapshot(rec));
			});
			child.on("error", (error) => {
				this.appendLog(rec, `[error] ${errorText(error)}\n`);
				if (!spawned) {
					this.dropRecord(rec);
					reject(error);
					return;
				}
				this.finalize(rec, null, null);
			});
			child.once("close", (code, signal) => {
				rec.resolveClosed();
				this.finalize(rec, code, signal);
			});
			this.attachOutput(rec, child);
		});
	}

	adopt(
		handle: ForegroundHandle,
		opts: { name?: string; notificationTimeoutSeconds?: number } = {},
	): BgTask {
		const rec = this.createRecord({
			command: handle.command,
			origin: "foreground-adopted",
			name: opts.name,
			pid: handle.child.pid ?? null,
			pgid: handle.pgid,
			startedAt: handle.startedAt,
		});
		rec.child = handle.child;

		// Prepend the output captured before adoption so the log has full history.
		if (handle.preOutput?.length) this.appendLog(rec, handle.preOutput);

		this.attachOutput(rec, handle.child);
		handle.child.on("error", (error) => {
			this.appendLog(rec, `[error] ${errorText(error)}\n`);
		});
		if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
			queueMicrotask(() =>
				this.finalize(rec, handle.child.exitCode, handle.child.signalCode),
			);
		} else {
			handle.child.once("close", (code, signal) => {
				rec.resolveClosed();
				this.finalize(rec, code, signal);
			});
		}

		this.armStillRunning(rec, opts.notificationTimeoutSeconds);
		this.applyAdoptedPriority(rec);
		this.emitChange();
		this.options.onTransition?.("adopted", this.snapshot(rec));
		return this.snapshot(rec);
	}

	async kill(idOrPrefix: string, reason = "killed"): Promise<string> {
		const rec = this.findRecord(idOrPrefix);
		if (rec.task.status !== "running") {
			throw new Error(`Cannot kill ${rec.task.id}: task is not running`);
		}
		rec.killRequested = true;
		rec.task.reason = reason;

		this.signalGroup(rec, "SIGTERM");
		let closed = rec.finalized || (await delayWait(rec.closed, this.killGraceMs));
		if (!closed) {
			this.signalGroup(rec, "SIGKILL");
			closed = await delayWait(rec.closed, Math.max(1000, this.killGraceMs));
		}
		if (!closed) this.finalize(rec, null, "SIGKILL");
		return rec.task.id;
	}

	sendInput(idOrPrefix: string, input: string): string {
		const rec = this.findRecord(idOrPrefix);
		if (rec.task.status !== "running") {
			throw new Error(`Cannot send input to ${rec.task.id}: command not running`);
		}
		const stdin = rec.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error(`Cannot send input to ${rec.task.id}: stdin is not available`);
		}
		stdin.write(`${input}\n`);
		return `Sent input to ${rec.task.id}.`;
	}

	list(): BgTask[] {
		const all = [...this.records.values()].map((rec) => this.snapshot(rec));
		const running = all
			.filter((task) => task.status === "running")
			.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
		const finished = all
			.filter((task) => task.status !== "running")
			.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		return [...running, ...finished];
	}

	get(idOrPrefix: string): BgTask | undefined {
		try {
			return this.snapshot(this.findRecord(idOrPrefix));
		} catch {
			return undefined;
		}
	}

	async logs(idOrPrefix: string, maxBytes?: number): Promise<string> {
		const rec = this.findRecord(idOrPrefix);
		const cap = Math.max(1, Math.floor(maxBytes ?? this.logBytes));
		try {
			const info = await stat(rec.task.logPath);
			const start = Math.max(0, info.size - cap);
			const length = info.size - start;
			if (length <= 0) return rec.memory;
			const buf = Buffer.alloc(length);
			const fh = await open(rec.task.logPath, "r");
			let bytesRead = 0;
			try {
				bytesRead = (await fh.read(buf, 0, length, start)).bytesRead;
			} finally {
				await fh.close();
			}
			const tail = buf.subarray(0, bytesRead).toString("utf8");
			return start > 0 ? `[Full output: ${rec.task.logPath}]\n${tail}` : tail;
		} catch {
			return rec.memoryTruncated
				? `[Full output: ${rec.task.logPath}]\n${rec.memory}`
				: rec.memory;
		}
	}

	rebuild(tasks: BgTask[]): void {
		let maxN = this.counter - 1;
		for (const input of tasks) {
			const task: BgTask = { ...input };
			if (task.status === "running") {
				task.status = "killed";
				task.reason = "session ended";
				task.endedAt = task.startedAt;
			}
			this.records.set(task.id, this.restoredRecord(task));
			const match = /^task-(\d+)$/.exec(task.id);
			if (match) maxN = Math.max(maxN, Number.parseInt(match[1]!, 10));
		}
		this.counter = Math.max(this.counter, maxN + 1);
		this.enforceEviction();
	}

	hasRunning(): boolean {
		return [...this.records.values()].some((rec) => rec.task.status === "running");
	}

	async disposeAll(reason = "session shutdown"): Promise<void> {
		const running = [...this.records.values()].filter(
			(rec) => rec.task.status === "running",
		);
		await Promise.all(
			running.map((rec) => this.kill(rec.task.id, reason).catch(() => undefined)),
		);
	}

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	private snapshot(rec: TaskRecord): BgTask {
		return { ...rec.task };
	}

	private restoredRecord(task: BgTask): TaskRecord {
		let resolveClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		resolveClosed();
		return {
			task,
			logBroken: false,
			memory: "",
			memoryTruncated: false,
			closed,
			resolveClosed,
			finalized: true,
			killRequested: false,
		};
	}

	private createRecord(input: {
		command: string;
		origin: BgTask["origin"];
		name?: string;
		pid: number | null;
		pgid: number | null;
		startedAt: number;
	}): TaskRecord {
		this.ensureLogDir();
		const id = `task-${this.counter++}`;
		const task: BgTask = {
			id,
			command: input.command,
			origin: input.origin,
			status: "running",
			pid: input.pid,
			pgid: input.pgid,
			startedAt: input.startedAt,
			endedAt: null,
			exitCode: null,
			signal: null,
			logPath: join(this.logDir, `${id}.log`),
		};
		if (input.name !== undefined) task.name = input.name;

		let resolveClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		const rec: TaskRecord = {
			task,
			logBroken: false,
			memory: "",
			memoryTruncated: false,
			closed,
			resolveClosed,
			finalized: false,
			killRequested: false,
		};
		this.records.set(id, rec);
		this.appendLog(
			rec,
			`$ ${input.command}\n[started] ${localIso(input.startedAt)}\n`,
		);
		return rec;
	}

	private ensureLogDir(): void {
		try {
			mkdirSync(this.logDir, { recursive: true });
		} catch {
			// Log dir unwritable: output falls back to the in-memory tail.
		}
	}

	private openLog(rec: TaskRecord): number | undefined {
		if (rec.fd !== undefined) return rec.fd;
		if (rec.logBroken) return undefined;
		try {
			rec.fd = openSync(rec.task.logPath, "a");
			return rec.fd;
		} catch {
			rec.logBroken = true;
			return undefined;
		}
	}

	private appendLog(rec: TaskRecord, chunk: string | Buffer): void {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		const fd = this.openLog(rec);
		if (fd !== undefined) {
			try {
				if (typeof chunk === "string") writeSync(fd, chunk);
				else writeSync(fd, chunk);
				return;
			} catch {
				try {
					closeSync(fd);
				} catch {
					// ignore
				}
				rec.fd = undefined;
				rec.logBroken = true;
			}
		}
		const combined = rec.memory + text;
		if (combined.length > this.logBytes) rec.memoryTruncated = true;
		rec.memory = combined.slice(-this.logBytes);
	}

	private closeLog(rec: TaskRecord): void {
		if (rec.fd === undefined) return;
		try {
			closeSync(rec.fd);
		} catch {
			// ignore
		}
		rec.fd = undefined;
	}

	private attachOutput(rec: TaskRecord, child: ChildProcess): void {
		const onData = (chunk: Buffer) => this.appendLog(rec, chunk);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.stdin?.on("error", () => {
			// EPIPE after the child exits must not become an unhandled error.
		});
	}

	private armStillRunning(rec: TaskRecord, seconds?: number): void {
		if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return;
		rec.stillTimer = setTimeout(() => {
			rec.stillTimer = undefined;
			if (rec.task.status !== "running") return;
			const elapsedSeconds = Math.max(
				0,
				Math.round((Date.now() - rec.task.startedAt) / 1000),
			);
			try {
				this.options.onStillRunning?.(this.snapshot(rec), elapsedSeconds);
			} catch {
				// listener errors never affect the task
			}
		}, seconds * 1000);
		rec.stillTimer.unref?.();
	}

	/** Wrap with the priority prefix using the probed absolute binary paths. */
	private buildBgCommandAbs(command: string): string {
		return buildBgCommandAbs(command, {
			niceBin: this.niceBin,
			bgNice: this.bgNice,
			ioniceBin: this.ioniceBin,
			ioniceClass: this.ioniceClass,
		});
	}

	/** Hard wall-clock limit: kill the task after `seconds` (PRD-004 §4.1). */
	private armTimeout(rec: TaskRecord, seconds?: number): void {
		if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return;
		const capped = Math.max(1, Math.floor(seconds));
		rec.timeoutTimer = setTimeout(() => {
			rec.timeoutTimer = undefined;
			if (rec.task.status !== "running") return;
			void this.kill(rec.task.id, `timeout (${capped}s)`).catch(() => {});
		}, capped * 1000);
		rec.timeoutTimer.unref?.();
	}

	private clearStillTimer(rec: TaskRecord): void {
		if (rec.stillTimer !== undefined) {
			clearTimeout(rec.stillTimer);
			rec.stillTimer = undefined;
		}
	}

	private finalize(
		rec: TaskRecord,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (rec.finalized) return;
		rec.finalized = true;
		this.clearStillTimer(rec);
		if (rec.timeoutTimer !== undefined) {
			clearTimeout(rec.timeoutTimer);
			rec.timeoutTimer = undefined;
		}

		const task = rec.task;
		task.endedAt = Date.now();
		task.exitCode = code;
		task.signal = signal;
		if (rec.killRequested) {
			task.status = "killed";
			task.reason = task.reason ?? "killed";
		} else if (code === 0) {
			task.status = "completed";
		} else if (code !== null) {
			task.status = "failed";
		} else if (signal !== null) {
			task.status = "killed";
			task.reason = task.reason ?? `signal ${signal}`;
		} else {
			task.status = "failed";
		}

		const duration = Math.max(0, (task.endedAt - task.startedAt) / 1000).toFixed(2);
		const outcome = code !== null ? String(code) : (signal ?? "unknown");
		this.appendLog(rec, `[exited] ${outcome} after ${duration}s\n`);
		this.closeLog(rec);
		rec.resolveClosed();
		this.enforceEviction();

		try {
			this.options.onTransition?.("terminal", this.snapshot(rec));
			this.options.onTerminal?.(this.snapshot(rec));
		} catch {
			// listener errors never affect the registry
		}
		this.emitChange();
	}

	private signalGroup(rec: TaskRecord, signal: NodeJS.Signals): boolean {
		const pgid = rec.task.pgid;
		if (pgid !== null) {
			try {
				process.kill(-pgid, signal);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			}
		}
		try {
			rec.child?.kill(signal);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			this.appendLog(rec, `[kill] ${signal} failed: ${errorText(error)}\n`);
			return false;
		}
	}

	private applyAdoptedPriority(rec: TaskRecord): void {
		if (!this.reniceBin && !this.ioniceBin) return;
		const pid = rec.task.pid;
		if (!pid) return;
		try {
			if (this.reniceBin) {
				const child = spawn(this.reniceBin, ["-n", String(this.bgNice), "-g", String(rec.task.pgid ?? pid)], { stdio: "ignore" });
				child.on("error", () => this.appendLog(rec, `[priority] renice unavailable — kept current nice level\n`));
			}
			if (this.ioniceBin && this.ioniceClass > 0) {
				const child2 = spawn(this.ioniceBin, ["-c", String(this.ioniceClass), "-p", String(pid)], { stdio: "ignore" });
				child2.on("error", () => this.appendLog(rec, `[priority] ionice unavailable — kept current IO class\n`));
			}
		} catch (error) {
			this.appendLog(rec, `[priority] ${(error as Error).message}\n`);
		}
	}

	private findRecord(idOrPrefix: string): TaskRecord {
		const task = resolveTaskId(
			[...this.records.values()].map((rec) => rec.task),
			idOrPrefix,
		);
		const rec = this.records.get(task.id);
		if (!rec) throw new Error(`Unknown background task: ${idOrPrefix}`);
		return rec;
	}

	private dropRecord(rec: TaskRecord): void {
		rec.finalized = true;
		rec.resolveClosed();
		this.closeLog(rec);
		this.records.delete(rec.task.id);
	}

	private enforceEviction(): void {
		const finished = [...this.records.values()].filter(
			(rec) => rec.task.status !== "running",
		);
		if (finished.length <= this.maxFinished) return;
		finished.sort(
			(a, b) => (a.task.endedAt ?? a.task.startedAt) - (b.task.endedAt ?? b.task.startedAt),
		);
		for (const rec of finished.slice(0, finished.length - this.maxFinished)) {
			this.records.delete(rec.task.id);
		}
	}

	private emitChange(): void {
		this.options.onChange?.();
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch {
				// UI listener errors never affect the registry
			}
		}
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}
}


/**
 * Build the background spawn script (PRD-004 §7.4): the command is wrapped as
 * `bash -c '<command>'` (single-quote escaped) and — when the probed absolute
 * `nice` binary is available — prefixed with `nice -n <level>` (and
 * `ionice -c <class>`). Without a nice binary the plain wrapper is returned
 * (fail-open priority, PRD-001 G4).
 */
export function buildBgCommandAbs(
	command: string,
	priority: { niceBin?: string; bgNice: number; ioniceBin?: string; ioniceClass: number },
): string {
	const inner = `bash -c '${escapeSingleQuotes(command)}'`;
	if (!priority.niceBin) return inner;
	const prefix = [priority.niceBin, "-n", String(priority.bgNice)];
	if (priority.ioniceClass > 0 && priority.ioniceBin) {
		prefix.push(priority.ioniceBin, "-c", String(priority.ioniceClass));
	}
	return `${prefix.join(" ")} ${inner}`;
}

export function createTaskManager(options: TaskManagerOptions): TaskManagerApi {
	return new TaskManager(options);
}
