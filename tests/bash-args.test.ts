import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBashArgs } from "../src/bash-override.ts";

test("normalizeBashArgs: empty-string optionals from the field failure are dropped", () => {
	// Verbatim failing payload (glm-5.3-flash, first env-check call).
	const raw = {
		command: 'echo "== pwd =="; pwd',
		intent: "setup: environment check (not under test)",
		tool: "env check",
		timeout: 15,
		background: false,
		taskName: "",
		cwd: "",
		taskAction: "",
		taskId: "",
		input: "",
	};
	const out = normalizeBashArgs(raw);
	assert.equal(out.command, raw.command);
	assert.equal(out.intent, "setup: environment check (not under test)");
	assert.equal(out.tool, "env check");
	assert.equal(out.timeout, 15);
	assert.equal(out.background, false);
	assert.equal("taskAction" in out, false);
	assert.equal("taskName" in out, false);
	assert.equal("cwd" in out, false);
	assert.equal("taskId" in out, false);
	assert.equal("input" in out, false);
});

test("normalizeBashArgs: blank/whitespace strings are dropped", () => {
	const out = normalizeBashArgs({ command: "  ", cwd: "   ", taskAction: "  " });
	assert.equal(out.command, undefined);
	assert.equal(out.cwd, undefined);
	assert.equal(out.taskAction, undefined);
});

test("normalizeBashArgs: coerces stringified booleans and numbers", () => {
	const out = normalizeBashArgs({ background: "true", timeout: "45" });
	assert.equal(out.background, true);
	assert.equal(out.timeout, 45);
	const out2 = normalizeBashArgs({ background: "false", timeout: "abc" });
	assert.equal(out2.background, false);
	assert.equal(out2.timeout, undefined);
});

test("normalizeBashArgs: unknown taskAction is dropped (falls through to command path)", () => {
	const out = normalizeBashArgs({ taskAction: "restart", command: "ls" });
	assert.equal(out.taskAction, undefined);
	assert.equal(out.command, "ls");
	const valid = normalizeBashArgs({ taskAction: "adopt" });
	assert.equal(valid.taskAction, "adopt");
});

test("normalizeBashArgs: non-object input yields empty object", () => {
	assert.deepEqual(normalizeBashArgs(undefined), {});
	assert.deepEqual(normalizeBashArgs(null), {});
	assert.deepEqual(normalizeBashArgs("nope"), {});
});

test("normalizeBashArgs: supports optional inputs as '', null, 'null', 'NULL', 'Null', 'undefined'", () => {
	for (const nilVal of ["", null, "null", "NULL", "Null", "undefined", "UNDEFINED"]) {
		const out = normalizeBashArgs({
			command: "echo test",
			cwd: nilVal,
			timeout: nilVal,
			intent: nilVal,
			tool: nilVal,
			taskName: nilVal,
			taskAction: nilVal,
			taskId: nilVal,
			input: nilVal,
		});
		assert.equal(out.command, "echo test");
		assert.equal(out.cwd, undefined, `cwd should be undefined for ${JSON.stringify(nilVal)}`);
		assert.equal(out.timeout, undefined, `timeout should be undefined for ${JSON.stringify(nilVal)}`);
		assert.equal(out.intent, undefined, `intent should be undefined for ${JSON.stringify(nilVal)}`);
		assert.equal(out.tool, undefined, `tool should be undefined for ${JSON.stringify(nilVal)}`);
		assert.equal(out.taskName, undefined, `taskName should be undefined for ${JSON.stringify(nilVal)}`);
		assert.equal(out.taskAction, undefined, `taskAction should be undefined for ${JSON.stringify(nilVal)}`);
		assert.equal(out.taskId, undefined, `taskId should be undefined for ${JSON.stringify(nilVal)}`);
		assert.equal(out.input, undefined, `input should be undefined for ${JSON.stringify(nilVal)}`);
	}
});
