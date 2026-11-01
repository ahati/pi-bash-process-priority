import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTaskManager } from "../src/registry.ts";
import type { BgTask, TaskManagerApi } from "../src/types.ts";

test("registry: tracks bytesWritten accurately", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-bytes-"));
	const manager: TaskManagerApi = createTaskManager({
		logDir: dir,
		killGraceMs: 300,
		logBytes: 4096,
		maxFinished: 10,
	});

	try {
		const task = await manager.run('echo "hello world 12345"', dir);
		// Wait for completion
		await new Promise<void>((resolve) => {
			const unsub = manager.onChange(() => {
				const current = manager.get(task.id);
				if (current && current.status !== "running") {
					unsub();
					resolve();
				}
			});
		});

		const current = manager.get(task.id)!;
		assert.equal(current.status, "completed");
		assert.ok((current.bytesWritten ?? 0) > 0);
	} finally {
		await manager.disposeAll();
		await rm(dir, { recursive: true, force: true });
	}
});

test("registry: rerun re-executes task with original command and cwd", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-rerun-"));
	const manager: TaskManagerApi = createTaskManager({
		logDir: dir,
		killGraceMs: 300,
		logBytes: 4096,
		maxFinished: 10,
	});

	try {
		const task1 = await manager.run('echo "rerun test"', dir, { name: "custom-job" });
		assert.ok(manager.rerun);
		const task2 = await manager.rerun(task1.id);

		assert.notEqual(task1.id, task2.id);
		assert.equal(task2.command, 'echo "rerun test"');
		assert.equal(task2.name, "custom-job");
		assert.equal(task2.cwd, dir);
	} finally {
		await manager.disposeAll();
		await rm(dir, { recursive: true, force: true });
	}
});

test("registry: stopAllRunning kills all running tasks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-stopall-"));
	const manager: TaskManagerApi = createTaskManager({
		logDir: dir,
		killGraceMs: 300,
		logBytes: 4096,
		maxFinished: 10,
	});

	try {
		await manager.run("sleep 60", dir);
		await manager.run("sleep 60", dir);
		assert.equal(manager.list().filter((t) => t.status === "running").length, 2);

		assert.ok(manager.stopAllRunning);
		const result = await manager.stopAllRunning();
		assert.equal(result.stopped, 2);
		assert.equal(result.failures.length, 0);
		assert.equal(manager.hasRunning(), false);
	} finally {
		await manager.disposeAll();
		await rm(dir, { recursive: true, force: true });
	}
});
