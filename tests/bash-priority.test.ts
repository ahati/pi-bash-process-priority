import test from "node:test";
import assert from "node:assert/strict";

import { buildBgCommandAbs } from "../src/registry.ts";
import { buildForegroundArgv, normalizeBashArgs } from "../src/bash-override.ts";

// ─── buildBgCommandAbs (registry spawn wrapper) ─────────────────────────────

test("buildBgCommandAbs: no nice bin → plain quoted wrapper (fail-open)", () => {
	assert.equal(
		buildBgCommandAbs("sleep 10", { bgNice: 19, ioniceClass: 3 }),
		`bash -c 'sleep 10'`,
	);
});

test("buildBgCommandAbs: absolute bins produce nice → ionice → bash chain", () => {
	assert.equal(
		buildBgCommandAbs("sleep 10", {
			niceBin: "/usr/bin/nice",
			bgNice: 19,
			ioniceBin: "/usr/bin/ionice",
			ioniceClass: 3,
		}),
		`/usr/bin/nice -n 19 /usr/bin/ionice -c 3 bash -c 'sleep 10'`,
	);
});

test("buildBgCommandAbs: ioniceClass 0 omits ionice", () => {
	assert.equal(
		buildBgCommandAbs("sleep 10", { niceBin: "/usr/bin/nice", bgNice: 19, ioniceClass: 0 }),
		`/usr/bin/nice -n 19 bash -c 'sleep 10'`,
	);
});

test("buildBgCommandAbs: single quotes in the command are POSIX-escaped", () => {
	assert.equal(
		buildBgCommandAbs(`echo it's`, { niceBin: "/usr/bin/nice", bgNice: 19, ioniceClass: 0 }),
		`/usr/bin/nice -n 19 bash -c 'echo it'\\''s'`,
	);
});

// ─── buildForegroundArgv (masked tool spawn) ────────────────────────────────

test("buildForegroundArgv: absolute nice bin + level", () => {
	assert.deepEqual(buildForegroundArgv("npm test", 10, "/usr/bin/nice"), [
		"/usr/bin/nice",
		"-n",
		"10",
		"bash",
		"-c",
		"npm test",
	]);
});

test("buildForegroundArgv: no nice bin → plain bash (fail-open)", () => {
	assert.deepEqual(buildForegroundArgv("ls", 10, undefined), ["bash", "-c", "ls"]);
});

test("buildForegroundArgv: fgNice 0 → plain bash even with a bin", () => {
	assert.deepEqual(buildForegroundArgv("ls", 0, "/usr/bin/nice"), ["bash", "-c", "ls"]);
});

// ─── normalizeBashArgs: literal "null"/"undefined" emissions ────────────────

test("normalizeBashArgs: literal null/undefined strings are treated as absent", () => {
	const out = normalizeBashArgs({
		command: "sleep 1",
		taskAction: "null",
		taskId: "null",
		input: "undefined",
		cwd: "null",
		taskName: "null",
		intent: "null",
		tool: "null",
		background: "false",
	});
	assert.equal(out.command, "sleep 1");
	assert.equal(out.background, false);
	assert.equal("taskAction" in out, false);
	assert.equal("taskId" in out, false);
	assert.equal("input" in out, false);
	assert.equal("cwd" in out, false);
	assert.equal("taskName" in out, false);
	assert.equal("intent" in out, false);
	assert.equal("tool" in out, false);
});
