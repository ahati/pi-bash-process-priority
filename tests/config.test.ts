import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_BG_NICE,
	DEFAULT_BG_TIMEOUT_MAX,
	DEFAULT_FG_NICE,
	DEFAULT_FG_TIMEOUT_MAX,
	DEFAULT_IONICE_CLASS,
	DEFAULT_KILL_GRACE_MS,
	DEFAULT_LOG_BYTES,
	DEFAULT_TASKS_MAX,
	resolveBgConfig,
	resolveLogDir,
} from "../src/config.ts";

test("resolveBgConfig: defaults", () => {
	assert.deepEqual(resolveBgConfig({}, "linux"), {
		fgNice: DEFAULT_FG_NICE,
		bgNice: DEFAULT_BG_NICE,
		ioniceClass: DEFAULT_IONICE_CLASS,
		supportedPlatform: true,
		logDir: undefined,
		tasksMax: DEFAULT_TASKS_MAX,
		killGraceMs: DEFAULT_KILL_GRACE_MS,
		logBytes: DEFAULT_LOG_BYTES,
		fgTimeoutMax: DEFAULT_FG_TIMEOUT_MAX,
		bgTimeoutMax: DEFAULT_BG_TIMEOUT_MAX,
	});
	assert.equal(DEFAULT_FG_NICE, 10);
	assert.equal(DEFAULT_BG_NICE, 19);
	assert.equal(DEFAULT_IONICE_CLASS, 3);
});

test("resolveBgConfig: bgNice >= fgNice and clamped to 1..19", () => {
	assert.equal(resolveBgConfig({ PI_BASH_NICE_LEVEL: "15", PI_BG_NICE_LEVEL: "5" }, "linux").bgNice, 15);
	assert.equal(resolveBgConfig({ PI_BASH_NICE_LEVEL: "15" }, "linux").bgNice, 19);
	assert.equal(resolveBgConfig({ PI_BG_NICE_LEVEL: "25" }, "linux").bgNice, 19);
	assert.equal(resolveBgConfig({ PI_BG_NICE_LEVEL: "0" }, "linux").bgNice, 10);
	assert.equal(resolveBgConfig({ PI_BG_NICE_LEVEL: "7" }, "linux").bgNice, 10);
	assert.equal(resolveBgConfig({ PI_BASH_NICE_LEVEL: "0" }, "linux").fgNice, 1);
	assert.equal(resolveBgConfig({ PI_BASH_NICE_LEVEL: "99" }, "linux").fgNice, 19);
	assert.equal(resolveBgConfig({ PI_BASH_NICE_LEVEL: "abc" }, "linux").fgNice, 10);
});

test("resolveBgConfig: ionice class clamped 0..3", () => {
	assert.equal(resolveBgConfig({ PI_BG_IONICE_CLASS: "-1" }, "linux").ioniceClass, 0);
	assert.equal(resolveBgConfig({ PI_BG_IONICE_CLASS: "0" }, "linux").ioniceClass, 0);
	assert.equal(resolveBgConfig({ PI_BG_IONICE_CLASS: "2" }, "linux").ioniceClass, 2);
	assert.equal(resolveBgConfig({ PI_BG_IONICE_CLASS: "9" }, "linux").ioniceClass, 3);
});

test("resolveBgConfig: tasksMax >= 1 and logBytes >= 1024", () => {
	assert.equal(resolveBgConfig({ PI_BG_TASKS_MAX: "0" }, "linux").tasksMax, 1);
	assert.equal(resolveBgConfig({ PI_BG_TASKS_MAX: "-9" }, "linux").tasksMax, 1);
	assert.equal(resolveBgConfig({ PI_BG_TASKS_MAX: "5" }, "linux").tasksMax, 5);
	assert.equal(resolveBgConfig({ PI_BG_LOG_BYTES: "10" }, "linux").logBytes, 1024);
	assert.equal(resolveBgConfig({ PI_BG_LOG_BYTES: "0" }, "linux").logBytes, 1024);
	assert.equal(resolveBgConfig({ PI_BG_LOG_BYTES: "2048" }, "linux").logBytes, 2048);
	assert.equal(resolveBgConfig({ PI_BG_LOG_BYTES: "abc" }, "linux").logBytes, DEFAULT_LOG_BYTES);
});


test("resolveBgConfig: kill grace non-negative", () => {
	assert.equal(resolveBgConfig({ PI_BG_KILL_GRACE_MS: "-100" }, "linux").killGraceMs, 0);
	assert.equal(resolveBgConfig({ PI_BG_KILL_GRACE_MS: "250" }, "linux").killGraceMs, 250);
});

test("resolveLogDir: explicit or <cwd>/.pi/bg-tasks", () => {
	assert.equal(resolveLogDir(resolveBgConfig({}, "linux"), "/work"), "/work/.pi/bg-tasks");
	const explicit = resolveBgConfig({ PI_BG_TASK_LOG_DIR: " /tmp/bg-logs " }, "linux");
	assert.equal(explicit.logDir, "/tmp/bg-logs");
	assert.equal(resolveLogDir(explicit, "/work"), "/tmp/bg-logs");
	assert.equal(
		resolveLogDir(resolveBgConfig({ PI_BG_TASK_LOG_DIR: "   " }, "linux"), "/work"),
		"/work/.pi/bg-tasks",
	);
});

test("resolveBgConfig: timeout caps parse and clamp to >= 1", () => {
	assert.equal(resolveBgConfig({}, "linux").fgTimeoutMax, 60);
	assert.equal(resolveBgConfig({}, "linux").bgTimeoutMax, 300);
	assert.equal(resolveBgConfig({ PI_BASH_FG_TIMEOUT_MAX: "30" }, "linux").fgTimeoutMax, 30);
	assert.equal(resolveBgConfig({ PI_BASH_TIMEOUT_BG_MAX: "120" }, "linux").bgTimeoutMax, 120);
	assert.equal(resolveBgConfig({ PI_BASH_FG_TIMEOUT_MAX: "0" }, "linux").fgTimeoutMax, 1);
	assert.equal(resolveBgConfig({ PI_BASH_FG_TIMEOUT_MAX: "abc" }, "linux").fgTimeoutMax, 60);
});
