import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { createBackgroundAwareBashTool, normalizeBashArgs } from "../src/bash-override.ts";
import { createTaskManager } from "../src/registry.ts";

/**
 * The bash tool has exactly one entry point per call (PRD-004 §4.1):
 *
 *   command                              → execute
 *   taskAction: list | adopt             → manage, no target
 *   taskAction: status | kill  + taskId  → manage, one target
 *   taskAction: input          + taskId + input → manage, one target + stdin
 *
 * Both `command` and `taskAction` are `Type.Optional` on the individual
 * properties — JSON Schema property optionality cannot express "one of these",
 * and making either one root-required would make the other mode uncallable.
 * The requirement is declared once per variant and projected into the root
 * `oneOf`, which pi's TypeBox validator enforces before `execute` runs.
 */
function schemaOf() {
	const registry = createTaskManager({ logDir: "/tmp/schema-tests", killGraceMs: 100, logBytes: 4096, maxFinished: 10 });
	const tool = createBackgroundAwareBashTool("/tmp", {
		registry,
		fgNice: 10,
		fgTimeoutMax: 60,
		bgTimeoutMax: 300,
	}) as unknown as { parameters: Record<string, unknown> };
	return tool.parameters;
}

const valid = (schema: Record<string, unknown>, value: unknown): boolean => Check(schema, value);

test("bash schema: root stays object-shaped with the full property map", () => {
	const schema = schemaOf();
	assert.equal(schema.type, "object");
	// pi's Anthropic adapter rebuilds input_schema from schema.properties, so the
	// properties must live at the root — not inside a top-level union.
	const properties = schema.properties as Record<string, unknown>;
	assert.deepEqual(Object.keys(properties).sort(), [
		"background",
		"command",
		"cwd",
		"input",
		"intent",
		"taskAction",
		"taskId",
		"taskName",
		"timeout",
		"tool",
	]);
	assert.equal(schema.required, undefined, "no entry point is unconditionally required");
});

test("bash schema: every property keeps its model-facing description", () => {
	const schema = schemaOf();
	const properties = schema.properties as Record<string, Record<string, unknown>>;
	for (const [key, property] of Object.entries(properties)) {
		// taskAction documents each action on its own const branch.
		const described =
			typeof property.description === "string" ||
			(Array.isArray(property.anyOf) && property.anyOf.every((branch) => typeof (branch as { description?: string }).description === "string"));
		assert.ok(described, `property "${key}" lost its description`);
	}
	// The pinned union keeps the management summary on the property itself.
	assert.match(String(properties.taskAction?.description ?? ""), /Manage background tasks/);
});

test("bash schema: oneOf declares each entry point with its required parameters", () => {
	const schema = schemaOf();
	const branches = schema.oneOf as Array<{ required: string[]; properties?: { taskAction?: { const?: string } } }>;
	const requiredSets = branches.map((branch) => `${branch.properties?.taskAction?.const ?? "command"}:${branch.required.join("+")}`);
	assert.deepEqual(requiredSets, [
		"command:command",
		"list:taskAction",
		"status:taskAction+taskId",
		"kill:taskAction+taskId",
		"input:taskAction+taskId+input",
		"adopt:taskAction",
	]);
});

test("bash schema: exactly one entry point — neither and both are invalid", () => {
	const schema = schemaOf();
	assert.equal(valid(schema, {}), false);
	assert.equal(valid(schema, { background: true }), false);
	assert.equal(valid(schema, { timeout: 5, taskName: "x" }), false);
	assert.equal(valid(schema, { command: "ls", taskAction: "list" }), false);
	assert.equal(valid(schema, { command: "ls", taskAction: "status" }), false);
	assert.equal(valid(schema, { command: "ls", taskAction: "status", taskId: "task-1" }), false);
	assert.equal(valid(schema, { command: "ls", taskAction: "kill" }), false);
	assert.equal(valid(schema, { command: "ls", taskAction: "kill", taskId: "task-1" }), false);
	assert.equal(valid(schema, { command: "ls", taskAction: "adopt" }), false);
	assert.equal(valid(schema, { command: "ls", taskAction: "input", taskId: "task-1", input: "y" }), false);
	assert.equal(valid(schema, { command: "ls" }), true);
	assert.equal(
		valid(schema, {
			command: "ls",
			timeout: 10,
			background: true,
			taskName: "test",
			cwd: "/tmp",
			intent: "list files",
			tool: "ls",
		}),
		true,
	);
});

test("bash schema: taskId is mandatory for status/kill/input, not for list/adopt", () => {
	const schema = schemaOf();
	assert.equal(valid(schema, { taskAction: "list" }), true);
	assert.equal(valid(schema, { taskAction: "adopt" }), true);

	assert.equal(valid(schema, { taskAction: "status", taskId: "task-7" }), true);
	assert.equal(valid(schema, { taskAction: "status" }), false);
	assert.equal(valid(schema, { taskAction: "kill", taskId: "task-7" }), true);
	assert.equal(valid(schema, { taskAction: "kill" }), false);
	assert.equal(valid(schema, { taskAction: "input", taskId: "task-7", input: "y\n" }), true);
	assert.equal(valid(schema, { taskAction: "input" }), false);
});

test("bash schema: input text is mandatory for taskAction 'input'", () => {
	const schema = schemaOf();
	assert.equal(valid(schema, { taskAction: "input", taskId: "task-7" }), false);
	assert.equal(valid(schema, { taskAction: "input", taskId: "task-7", input: "yes\n" }), true);
});

test("bash schema: unknown taskAction is rejected", () => {
	const schema = schemaOf();
	assert.equal(valid(schema, { taskAction: "restart" }), false);
	assert.equal(valid(schema, { taskAction: "restart", taskId: "task-1" }), false);
});

test("bash schema: junk-only args normalize to {} and are then schema-invalid", () => {
	const schema = schemaOf();
	const normalized = normalizeBashArgs({ command: "null", taskAction: "undefined", cwd: "" });
	assert.deepEqual(normalized, {});
	assert.equal(valid(schema, normalized), false, "a normalized-away call must not validate");
});

test("bash schema: junk taskId is normalized away, so status then fails like a missing taskId", () => {
	const schema = schemaOf();
	const normalized = normalizeBashArgs({ taskAction: "status", taskId: "null" });
	assert.equal("taskId" in normalized, false);
	assert.equal(valid(schema, normalized), false);
});
