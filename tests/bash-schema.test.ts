import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
	createBackgroundTaskTool,
	createManageBackgroundTaskTool,
	normalizeBackgroundTaskArgs,
	normalizeManageBackgroundTaskArgs,
} from "../src/bash-override.ts";
import { createTaskManager } from "../src/registry.ts";

function createTools() {
	const registry = createTaskManager({
		logDir: "/tmp/schema-tests",
		killGraceMs: 100,
		logBytes: 4096,
		maxFinished: 10,
	});
	const deps = {
		registry,
		fgTimeoutMax: 60,
		bgTimeoutMax: 300,
	};
	const bgTool = createBackgroundTaskTool("/tmp", deps, "background_task") as unknown as {
		parameters: Record<string, unknown>;
	};
	const manageTool = createManageBackgroundTaskTool(deps, "manage_background_task") as unknown as {
		parameters: Record<string, unknown>;
	};
	return { backgroundTask: bgTool.parameters, manageBackgroundTask: manageTool.parameters };
}

const valid = (schema: Record<string, unknown>, value: unknown): boolean => Check(schema, value);

// ─── 1. background_task Schema ──────────────────────────────────────────────

test("background_task schema: root stays object-shaped with background properties", () => {
	const { backgroundTask } = createTools();
	assert.equal(backgroundTask.type, "object");
	const properties = backgroundTask.properties as Record<string, unknown>;
	assert.deepEqual(Object.keys(properties).sort(), ["command", "cwd", "taskName", "timeout"]);
	assert.deepEqual(backgroundTask.required, ["command"]);
});

test("background_task schema: command is required, taskName and timeout are optional", () => {
	const { backgroundTask } = createTools();
	assert.equal(valid(backgroundTask, {}), false, "missing command must fail");
	assert.equal(valid(backgroundTask, { taskName: "server" }), false, "missing command must fail");
	assert.equal(valid(backgroundTask, { command: "npm start" }), true);
	assert.equal(
		valid(backgroundTask, {
			command: "npm start",
			taskName: "dev-server",
			timeout: 300,
			cwd: "/workspace",
		}),
		true,
	);
});

// ─── 2. manage_background_task Schema ───────────────────────────────────────

test("manage_background_task schema: root is object-shaped and requires action", () => {
	const { manageBackgroundTask } = createTools();
	assert.equal(manageBackgroundTask.type, "object");
	const properties = manageBackgroundTask.properties as Record<string, unknown>;
	assert.deepEqual(Object.keys(properties).sort(), ["action", "input", "lines", "taskId"]);
	assert.deepEqual(manageBackgroundTask.required, ["action"]);
});

test("manage_background_task schema: validates all supported actions", () => {
	const { manageBackgroundTask } = createTools();
	assert.equal(valid(manageBackgroundTask, {}), false, "missing action must fail");
	assert.equal(valid(manageBackgroundTask, { action: "unknown" }), false, "unknown action must fail");

	assert.equal(valid(manageBackgroundTask, { action: "list" }), true);
	assert.equal(valid(manageBackgroundTask, { action: "status", taskId: "task-1" }), true);
	assert.equal(valid(manageBackgroundTask, { action: "logs", taskId: "task-1", lines: 20 }), true);
	assert.equal(valid(manageBackgroundTask, { action: "kill", taskId: "task-1" }), true);
	assert.equal(valid(manageBackgroundTask, { action: "input", taskId: "task-1", input: "y\n" }), true);
});

// ─── 3. Argument Normalization Across Tools ─────────────────────────────────

test("normalizeBackgroundTaskArgs: normalizes command, taskName, timeout", () => {
	const normalized = normalizeBackgroundTaskArgs({
		command: "npm run dev",
		taskName: "dev",
		timeout: "120",
		cwd: "   ",
	});
	assert.equal(normalized.command, "npm run dev");
	assert.equal(normalized.taskName, "dev");
	assert.equal(normalized.timeout, 120);
	assert.equal("cwd" in normalized, false);
});

test("normalizeManageBackgroundTaskArgs: maps taskAction to action and normalizes fields", () => {
	const fromTaskAction = normalizeManageBackgroundTaskArgs({
		taskAction: "status",
		taskId: "task-5",
		lines: "50",
	});
	assert.equal(fromTaskAction.action, "status");
	assert.equal(fromTaskAction.taskId, "task-5");
	assert.equal(fromTaskAction.lines, 50);

	const unknownAction = normalizeManageBackgroundTaskArgs({
		action: "restart",
		taskId: "task-1",
	});
	assert.equal("action" in unknownAction, false);
});

test("schemas: accept nulls for optional inputs", () => {
	const { backgroundTask, manageBackgroundTask } = createTools();
	assert.equal(valid(backgroundTask, { command: "sleep 5", timeout: null, cwd: null, taskName: null }), true);
	assert.equal(valid(manageBackgroundTask, { action: "list", taskId: null, input: null, lines: null }), true);
});

test("normalizeBackgroundTaskArgs and normalizeManageBackgroundTaskArgs: drop '', null, 'null', 'NULL', 'Null', 'undefined'", () => {
	for (const nilVal of ["", null, "null", "NULL", "Null", "undefined", "UNDEFINED"]) {
		const bg = normalizeBackgroundTaskArgs({
			command: "sleep 1",
			taskName: nilVal,
			timeout: nilVal,
			cwd: nilVal,
		});
		assert.equal(bg.command, "sleep 1");
		assert.equal(bg.taskName, undefined);
		assert.equal(bg.timeout, undefined);
		assert.equal(bg.cwd, undefined);

		const mg = normalizeManageBackgroundTaskArgs({
			action: "status",
			taskId: nilVal,
			input: nilVal,
			lines: nilVal,
		});
		assert.equal(mg.action, "status");
		assert.equal(mg.taskId, undefined);
		assert.equal(mg.input, undefined);
		assert.equal(mg.lines, undefined);
	}
});
