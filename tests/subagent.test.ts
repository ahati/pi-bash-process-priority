import test from "node:test";
import assert from "node:assert/strict";
import { isSubagentSession, getSubagentLabel, SHARED_TASK_MANAGER_KEY } from "../index.ts";
import { detailLines } from "../src/ui/format.ts";
import { createTaskManager } from "../src/registry.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

test("isSubagentSession identifies subagent sessions correctly", () => {
	// Main interactive session
	const mainCtx = {
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getHeader: () => ({ parentSession: undefined }),
			getSessionName: () => undefined,
			getSessionFile: () => "/tmp/sess.jsonl",
		},
	} as unknown as ExtensionContext;
	assert.equal(isSubagentSession(mainCtx), false);

	// Subagent with parentSession
	const parentChildCtx = {
		hasUI: false,
		mode: "print",
		sessionManager: {
			getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }),
			getSessionName: () => undefined,
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
	assert.equal(isSubagentSession(parentChildCtx), true);

	// Subagent with session name pattern
	const namedCtx = {
		hasUI: false,
		mode: "print",
		sessionManager: {
			getHeader: () => ({ parentSession: undefined }),
			getSessionName: () => "researcher#a1b2c3d4",
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
	assert.equal(isSubagentSession(namedCtx), true);
	assert.equal(getSubagentLabel(namedCtx), "researcher#a1b2c3d4");

	// Headless session when shared registry is present
	(globalThis as any)[SHARED_TASK_MANAGER_KEY] = { registry: {} };
	try {
		const headlessWithShared = {
			hasUI: false,
			mode: "print",
			sessionManager: {
				getHeader: () => ({}),
				getSessionName: () => undefined,
				getSessionFile: () => undefined,
			},
		} as unknown as ExtensionContext;
		assert.equal(isSubagentSession(headlessWithShared), true);
	} finally {
		delete (globalThis as any)[SHARED_TASK_MANAGER_KEY];
	}
});

test("subagent background task has callerType and renders Type: Subagent in detailLines", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "subagent-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const manager = createTaskManager({
		logDir: dir,
		killGraceMs: 500,
		logBytes: 10_000,
		maxFinished: 5,
	});
	t.after(() => manager.disposeAll());

	// Simulate subagent launching a task through the shared registry
	const task = await manager.run("echo 'hello from subagent'", dir, {
		callerType: "subagent",
		subagentName: "auditor#fe8a9012",
	});

	assert.equal(task.callerType, "subagent");
	assert.equal(task.subagentName, "auditor#fe8a9012");

	// Format detail lines
	const lines = detailLines(task, 60);
	assert.equal(lines[4], "Type:    Subagent (auditor#fe8a9012)");

	// Anonymous subagent
	const anonTask = await manager.run("echo 'hello anon'", dir, {
		callerType: "subagent",
	});
	const anonLines = detailLines(anonTask, 60);
	assert.equal(anonLines[4], "Type:    Subagent");

	// Main agent task
	const mainTask = await manager.run("echo 'hello main'", dir, {
		callerType: "agent",
	});
	const mainLines = detailLines(mainTask, 60);
	assert.equal(mainLines[4], "Type:    Agent");
});

test("createBackgroundAwareBashTool tags subagent background tasks", async (t) => {
	const { createBackgroundAwareBashTool } = await import("../src/bash-override.ts");
	const dir = await mkdtemp(join(tmpdir(), "subagent-tool-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const manager = createTaskManager({
		logDir: dir,
		killGraceMs: 500,
		logBytes: 10_000,
		maxFinished: 5,
	});
	t.after(() => manager.disposeAll());

	const tool = createBackgroundAwareBashTool(dir, {
		registry: manager,
		fgNice: 0,
		callerType: "subagent",
		subagentName: "worker#1111",
	});

	const result = await (tool.execute as any)("call-1", {
		command: "echo 'subagent tool test'",
		background: true,
	});

	assert.equal(result.isError, false);
	const details = result.details as any;
	assert.equal(details.callerType, "subagent");
	assert.equal(details.subagentName, "worker#1111");
});
