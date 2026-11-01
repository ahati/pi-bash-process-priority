import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
	createForegroundBashTool,
	createBackgroundTaskTool,
	createManageBackgroundTaskTool,
	normalizeBashArgs,
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
		fgNice: 10,
		fgTimeoutMax: 60,
		bgTimeoutMax: 300,
	};
	const bashTool = createForegroundBashTool("/tmp", deps) as unknown as { parameters: Record<string, unknown> };
	const bgTool = createBackgroundTaskTool("/tmp", deps, "background_task") as unknown as {
		parameters: Record<string, unknown>;
	};
	const manageTool = createManageBackgroundTaskTool(deps, "manage_background_task") as unknown as {
		parameters: Record<string, unknown>;
	};
	return { bash: bashTool.parameters, backgroundTask: bgTool.parameters, manageBackgroundTask: manageTool.parameters };
}

const valid = (schema: Record<string, unknown>, value: unknown): boolean => Check(schema, value);

// ─── 1. bash (Foreground) Schema ─────────────────────────────────────────────

test("bash schema: root stays object-shaped with foreground execution properties", () => {
	const { bash } = createTools();
	assert.equal(bash.type, "object");
	const properties = bash.properties as Record<string, unknown>;
	assert.deepEqual(Object.keys(properties).sort(), ["command", "cwd", "intent", "timeout", "tool"]);
	assert.deepEqual(bash.required, ["command"]);
});

test("bash schema: every property keeps its model-facing description", () => {
	const { bash } = createTools();
	const properties = bash.properties as Record<string, Record<string, unknown>>;
	for (const [key, property] of Object.entries(properties)) {
		assert.ok(typeof property.description === "string", `property "${key}" lost its description`);
	}
});

test("bash schema: command is required, execution options are optional", () => {
	const { bash } = createTools();
	assert.equal(valid(bash, {}), false, "missing command must fail");
	assert.equal(valid(bash, { timeout: 10 }), false, "missing command must fail");
	assert.equal(valid(bash, { command: "ls -la" }), true);
	assert.equal(valid(bash, { command: "ls -la", timeout: 15, cwd: "/tmp", intent: "list directory", tool: "ls" }), true);
});

// ─── 2. background_task Schema ──────────────────────────────────────────────

test("background_task schema: root stays object-shaped with background properties", () => {
	const { backgroundTask } = createTools();
	assert.equal(backgroundTask.type, "object");
	const properties = backgroundTask.properties as Record<string, unknown>;
	assert.deepEqual(Object.keys(properties).sort(), ["command", "cwd", "intent", "taskName", "timeout", "tool"]);
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

// ─── 3. manage_background_task Schema ───────────────────────────────────────

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
	assert.equal(valid(manageBackgroundTask, { action: "adopt" }), true);
	assert.equal(valid(manageBackgroundTask, { action: "status", taskId: "task-1" }), true);
	assert.equal(valid(manageBackgroundTask, { action: "logs", taskId: "task-1", lines: 20 }), true);
	assert.equal(valid(manageBackgroundTask, { action: "kill", taskId: "task-1" }), true);
	assert.equal(valid(manageBackgroundTask, { action: "input", taskId: "task-1", input: "y\n" }), true);
});

// ─── 4. Argument Normalization Across Tools ─────────────────────────────────

test("normalizeBashArgs: empty and literal null/undefined are dropped", () => {
	const normalized = normalizeBashArgs({
		command: "echo test",
		cwd: "",
		timeout: "30",
		intent: "null",
		tool: "undefined",
	});
	assert.equal(normalized.command, "echo test");
	assert.equal(normalized.timeout, 30);
	assert.equal("cwd" in normalized, false);
	assert.equal("intent" in normalized, false);
	assert.equal("tool" in normalized, false);
});

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
