import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskManager, resolveTaskId } from "../src/registry.ts";
import type { BgTask, TaskManagerApi, TaskManagerOptions } from "../src/types.ts";

interface Harness {
	dir: string;
	manager: TaskManagerApi;
	terminals: BgTask[];
	still: Array<{ task: BgTask; elapsedSeconds: number }>;
	changes: () => number;
	waitTerminal(id: string, timeoutMs?: number): Promise<BgTask>;
}

async function harness(overrides: Partial<TaskManagerOptions> = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-reg-"));
	const terminals: BgTask[] = [];
	const still: Array<{ task: BgTask; elapsedSeconds: number }> = [];
	const listeners = new Set<(task: BgTask) => void>();
	let changeCount = 0;

	const manager = createTaskManager({
		logDir: dir,
		killGraceMs: 300,
		logBytes: 4096,
		maxFinished: 100,
		bgNice: 19,
		ioniceClass: 0,
		...overrides,
		onChange: () => {
			changeCount++;
			overrides.onChange?.();
		},
		onTerminal: (task) => {
			terminals.push(task);
			overrides.onTerminal?.(task);
			for (const listener of [...listeners]) listener(task);
		},
		onStillRunning: (task, elapsedSeconds) => {
			still.push({ task, elapsedSeconds });
			overrides.onStillRunning?.(task, elapsedSeconds);
		},
	});

	const waitTerminal = (id: string, timeoutMs = 8000): Promise<BgTask> => {
		const found = terminals.find((task) => task.id === id);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.delete(listener);
				reject(new Error(`timed out waiting for ${id}`));
			}, timeoutMs);
			const listener = (task: BgTask) => {
				if (task.id !== id) return;
				clearTimeout(timer);
				listeners.delete(listener);
				resolve(task);
			};
			listeners.add(listener);
		});
	};

	return { dir, manager, terminals, still, changes: () => changeCount, waitTerminal };
}

async function cleanup(h: Harness): Promise<void> {
	await h.manager.disposeAll("test cleanup").catch(() => undefined);
	await rm(h.dir, { recursive: true, force: true });
}

async function waitUntil(
	fn: () => Promise<boolean> | boolean,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (await fn()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("waitUntil timed out");
}

function groupAlive(pgid: number | null): boolean {
	if (pgid === null) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

function fakeTask(id: string, overrides: Partial<BgTask> = {}): BgTask {
	return {
		id,
		command: "sleep 1",
		origin: "bg_task",
		status: "running",
		pid: null,
		pgid: null,
		startedAt: 1000,
		endedAt: null,
		exitCode: null,
		signal: null,
		logPath: `/tmp/${id}.log`,
		...overrides,
	};
}

test("run completes: status, exitCode, endedAt, log header", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const command = `printf 'hello\\n'; sleep 0.15`;
	const task = await h.manager.run(command, h.dir);
	assert.equal(task.id, "task-1");
	assert.equal(task.origin, "bg_task");
	assert.equal(task.status, "running");
	assert.equal(h.manager.hasRunning(), true);
	assert.ok(task.pid && task.pgid);

	const done = await h.waitTerminal(task.id);
	assert.equal(done.status, "completed");
	assert.equal(done.exitCode, 0);
	assert.equal(done.signal, null);
	assert.ok(done.endedAt !== null && done.endedAt >= done.startedAt);

	const log = await readFile(done.logPath, "utf8");
	assert.ok(log.startsWith(`$ ${command}\n`), `header: ${log.slice(0, 80)}`);
	assert.match(log, /^\[started\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m);
	assert.ok(log.includes("hello"));
	assert.ok(log.includes("[exited] 0 after "));
	assert.equal(h.manager.get("1")?.id, "task-1", "bare digits resolve");
	assert.equal(h.manager.hasRunning(), false);
});

test("logPath includes sessionId when provided", async (t) => {
	const h = await harness({ sessionId: "sess-abc-123" });
	t.after(() => cleanup(h));

	const task = await h.manager.run(`printf 'hello session\\n'`, h.dir);
	assert.equal(task.id, "task-1");
	assert.equal(task.logPath, join(h.dir, "task-1-sess-abc-123.log"));

	const done = await h.waitTerminal(task.id);
	assert.equal(done.logPath, join(h.dir, "task-1-sess-abc-123.log"));
	const log = await readFile(done.logPath, "utf8");
	assert.ok(log.includes("hello session"));
});

test("run stores callerType and subagentName", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const task = await h.manager.run(`printf 'subagent work\\n'`, h.dir, {
		callerType: "subagent",
		subagentName: "researcher#123",
	});
	assert.equal(task.callerType, "subagent");
	assert.equal(task.subagentName, "researcher#123");

	const done = await h.waitTerminal(task.id);
	assert.equal(done.callerType, "subagent");
	assert.equal(done.subagentName, "researcher#123");
});

test("run -> kill: status killed, reason recorded, group gone", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const task = await h.manager.run("sleep 30", h.dir);
	assert.equal(await h.manager.kill(task.id, "user kill"), task.id);
	const done = h.manager.get(task.id)!;
	assert.equal(done.status, "killed");
	assert.equal(done.reason, "user kill");
	assert.ok(done.endedAt !== null);
	assert.equal(groupAlive(done.pgid), false, "whole process group killed");
});

test("kill escalates SIGTERM -> SIGKILL after grace", async (t) => {
	const h = await harness({ killGraceMs: 150 });
	t.after(() => cleanup(h));

	const task = await h.manager.run(`trap '' TERM; while :; do sleep 1; done`, h.dir);
	await new Promise((resolve) => setTimeout(resolve, 100)); // let bash install the trap
	const started = Date.now();
	await h.manager.kill(task.id, "stubborn");
	const done = h.manager.get(task.id)!;
	assert.equal(done.status, "killed");
	assert.ok(Date.now() - started >= 120, "waited the grace period");
	await waitUntil(() => !groupAlive(done.pgid));
	assert.equal(groupAlive(done.pgid), false);
});

test("ids are monotonic and resolveTaskId handles exact/prefix/digits", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const first = await h.manager.run("true", h.dir);
	const second = await h.manager.run("true", h.dir);
	assert.equal(first.id, "task-1");
	assert.equal(second.id, "task-2");
	await h.waitTerminal(first.id);
	await h.waitTerminal(second.id);

	const tasks = [fakeTask("task-2"), fakeTask("task-12"), fakeTask("task-13")];
	assert.equal(resolveTaskId(tasks, "task-2").id, "task-2");
	assert.equal(resolveTaskId(tasks, "2").id, "task-2");
	assert.equal(resolveTaskId(tasks, "12").id, "task-12");
	assert.equal(resolveTaskId([fakeTask("task-12")], "task-1").id, "task-12", "unique prefix");
	assert.throws(() => resolveTaskId(tasks, "task-1"), /Ambiguous/);
	assert.throws(() => resolveTaskId(tasks, "99"), /Unknown/);
	assert.throws(() => resolveTaskId(tasks, ""), /Unknown/);
});

test("sendInput writes to a reader process; throws once not running", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const task = await h.manager.run("cat", h.dir);
	assert.match(h.manager.sendInput(task.id, "hello stdin"), /Sent input to task-1\./);
	await waitUntil(async () => (await h.manager.logs(task.id)).includes("hello stdin"));
	await h.manager.kill(task.id, "done");
	assert.throws(() => h.manager.sendInput(task.id, "late"), /not running/);
});

test("logs are tail-capped with a [Full output: ...] notice", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const task = await h.manager.run(
		`for i in {1..200}; do printf '0123456789'; done; sleep 0.1`,
		h.dir,
	);
	const done = await h.waitTerminal(task.id);
	const full = await h.manager.logs(task.id, 100000);
	assert.ok(full.length > 2000, `full log length ${full.length}`);

	const tail = await h.manager.logs(task.id, 200);
	assert.ok(tail.startsWith("[Full output: "), `tail starts: ${tail.slice(0, 40)}`);
	assert.ok(tail.includes(done.logPath));
	assert.ok(tail.includes("0123456789"));
	assert.ok(tail.includes("[exited] 0 after "));
	assert.ok(
		tail.length <= 200 + done.logPath.length + 30,
		`tail capped (${tail.length} chars)`,
	);
});

test("rebuild: finished kept, running -> killed (session ended), counter resumes", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const startedAt = Date.now() - 5000;
	h.manager.rebuild([
		fakeTask("task-2", {
			status: "completed",
			exitCode: 0,
			startedAt,
			endedAt: startedAt + 1000,
			logPath: join(h.dir, "task-2.log"),
		}),
		fakeTask("task-7", {
			status: "running",
			startedAt,
			logPath: join(h.dir, "task-7.log"),
		}),
	]);

	const finished = h.manager.get("task-2")!;
	assert.equal(finished.status, "completed");
	assert.equal(finished.endedAt, startedAt + 1000);
	const orphan = h.manager.get("task-7")!;
	assert.equal(orphan.status, "killed");
	assert.equal(orphan.reason, "session ended");
	assert.equal(orphan.endedAt, startedAt);

	const next = await h.manager.run("true", h.dir);
	assert.equal(next.id, "task-8", "counter resumes past max seen");
	await h.waitTerminal(next.id);
});

test("eviction keeps only maxFinished finished tasks (oldest first)", async (t) => {
	const h = await harness({ maxFinished: 2 });
	t.after(() => cleanup(h));

	for (let i = 0; i < 3; i++) {
		const task = await h.manager.run("true", h.dir);
		await h.waitTerminal(task.id);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(h.manager.get("task-1"), undefined, "oldest evicted");
	assert.ok(h.manager.get("task-2"));
	assert.ok(h.manager.get("task-3"));
	assert.equal(h.manager.list().filter((task) => task.status !== "running").length, 2);
});

test("onChange/onTerminal fire; terminal fires once", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const task = await h.manager.run("sleep 0.12", h.dir);
	await h.waitTerminal(task.id);
	assert.equal(h.terminals.length, 1);
	assert.ok(h.changes() >= 2, `onChange fired ${h.changes()} times`);
	await assert.rejects(h.manager.kill(task.id), /not running/);
	assert.equal(h.terminals.length, 1, "no double terminal fire");
});

test("notificationTimeoutSeconds arms a one-shot still-running notice", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const task = await h.manager.run("sleep 0.6", h.dir, {
		notificationTimeoutSeconds: 0.1,
	});
	await waitUntil(() => h.still.length === 1, 2000);
	assert.equal(h.still[0]!.task.id, task.id);
	assert.ok(h.still[0]!.elapsedSeconds >= 0);
	assert.equal(h.manager.get(task.id)?.status, "running", "task keeps running");
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(h.still.length, 1, "one-shot, not re-armed");
	await h.manager.kill(task.id, "cleanup");
	assert.equal(h.still.length, 1, "cleared on finalize");
});

test("adopt: no signalling, preOutput + subsequent output logged, completes", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const command = `printf 'before\\n'; sleep 0.35; printf 'after\\n'`;
	const child = spawn("bash", ["-c", command], {
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	await new Promise((resolve) => child.once("spawn", resolve));
	const pgid = child.pid!;
	let pre = "";
	child.stdout!.on("data", (chunk: Buffer) => {
		pre += chunk.toString("utf8");
	});
	await new Promise((resolve) => setTimeout(resolve, 80));

	const task = h.manager.adopt({
		child,
		pgid,
		command,
		cwd: h.dir,
		startedAt: Date.now() - 80,
		preOutput: Buffer.from(pre),
	});
	assert.equal(task.origin, "foreground-adopted");
	assert.equal(task.status, "running");
	assert.equal(groupAlive(pgid), true, "adoption never signals the child");

	const done = await h.waitTerminal(task.id);
	assert.equal(done.status, "completed");
	const log = await readFile(done.logPath, "utf8");
	assert.ok(log.startsWith(`$ ${command}\n`));
	assert.ok(log.includes("before"));
	assert.ok(log.includes("after"));
});

test("disposeAll kills everything and is idempotent", async (t) => {
	const h = await harness();
	t.after(() => cleanup(h));

	const a = await h.manager.run("sleep 30", h.dir);
	const b = await h.manager.run("sleep 30", h.dir);
	await h.manager.disposeAll("test shutdown");
	assert.equal(h.manager.hasRunning(), false);
	for (const id of [a.id, b.id]) {
		const task = h.manager.get(id)!;
		assert.equal(task.status, "killed");
		assert.equal(task.reason, "test shutdown");
		assert.equal(groupAlive(task.pgid), false);
	}
	await h.manager.disposeAll();
	assert.equal(h.manager.hasRunning(), false);
});
