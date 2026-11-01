import test from "node:test";
import assert from "node:assert/strict";

import { stripCdPrefix, runTaskAction } from "../src/bash-override.ts";
import { createTaskManager } from "../src/registry.ts";

const CWD = "/home/u/proj";

test("stripCdPrefix: drops a leading cd to the tool cwd (unquoted)", () => {
	assert.equal(stripCdPrefix(`cd ${CWD} && npm test`, CWD), "npm test");
});

test("stripCdPrefix: drops quoted variants", () => {
	assert.equal(stripCdPrefix(`cd "${CWD}" && ls`, CWD), "ls");
	assert.equal(stripCdPrefix(`cd '${CWD}' && ls`, CWD), "ls");
});

test("stripCdPrefix: tolerates trailing slashes on both sides", () => {
	assert.equal(stripCdPrefix(`cd ${CWD}/ && ls`, CWD), "ls");
	assert.equal(stripCdPrefix(`cd ${CWD} && ls`, `${CWD}/`), "ls");
});

test("stripCdPrefix: keeps cd to a different directory", () => {
	assert.equal(stripCdPrefix(`cd /tmp && ls`, CWD), "cd /tmp && ls");
});

test("stripCdPrefix: keeps commands without a leading cd", () => {
	assert.equal(stripCdPrefix(`ls && cd ${CWD}`, CWD), `ls && cd ${CWD}`);
	assert.equal(stripCdPrefix(`npm test`, CWD), `npm test`);
});

test("runTaskAction: list — empty registry", async () => {
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-list", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		const outcome = await runTaskAction(reg, { taskAction: "list" });
		assert.equal(outcome.text, "No background tasks.");
		assert.notEqual(outcome.isError, true);
	} finally {
		await reg.disposeAll();
	}
});

test("runTaskAction: list and status report running tasks", async () => {
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-status", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		const task = await reg.run("sleep 2", "/tmp");
		const list = await runTaskAction(reg, { taskAction: "list" });
		assert.match(list.text, /task-1/);
		assert.match(list.text, /sleep 2/);
		const status = await runTaskAction(reg, { taskAction: "status", taskId: task.id });
		assert.match(status.text, /task-1/);
		assert.equal(status.details?.id, task.id);
	} finally {
		await reg.disposeAll();
	}
});

test("runTaskAction: unknown task and missing parameters are errors", async () => {
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-err", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		const unknown = await runTaskAction(reg, { taskAction: "kill", taskId: "task-99" });
		assert.equal(unknown.isError, true);
		assert.match(unknown.text, /Unknown task/);
		const noId = await runTaskAction(reg, { taskAction: "kill" });
		assert.equal(noId.isError, true);
		assert.match(noId.text, /taskId/);
		await reg.run("sleep 2", "/tmp");
		const noInput = await runTaskAction(reg, { taskAction: "input", taskId: "task-1" });
		assert.equal(noInput.isError, true);
		assert.match(noInput.text, /input/);
	} finally {
		await reg.disposeAll();
	}
});

test("runTaskAction: adopt without a foreground command is an error", async () => {
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-adopt", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		const outcome = await runTaskAction(reg, { taskAction: "adopt" });
		assert.equal(outcome.isError, true);
		assert.match(outcome.text, /No foreground command/);
	} finally {
		await reg.disposeAll();
	}
});

test("runTaskAction: kill terminates a running task", async () => {
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-kill", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		await reg.run("sleep 5", "/tmp");
		const outcome = await runTaskAction(reg, { taskAction: "kill", taskId: "task-1" });
		assert.equal(outcome.isError, undefined);
		assert.match(outcome.text, /task-1/);
		assert.equal(reg.get("task-1")?.status, "killed");
	} finally {
		await reg.disposeAll();
	}
});

test("registry: timeoutSeconds kills the task with a timeout reason", async () => {
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-timeout", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		await reg.run("sleep 10", "/tmp", { timeoutSeconds: 1 });
		await new Promise((resolve) => setTimeout(resolve, 1600));
		const task = reg.get("task-1");
		assert.equal(task?.status, "killed");
		assert.match(task?.reason ?? "", /timeout/);
	} finally {
		await reg.disposeAll();
	}
});

test("stripCdPrefix generalization: '.' and $PWD targets count as the cwd", async () => {
	const { stripCdPrefix } = await import("../src/bash-override.ts");
	const cwd = "/workspace/pi-extensions";
	assert.equal(stripCdPrefix("cd . && ls", cwd), "ls");
	assert.equal(stripCdPrefix("cd $PWD && ls", cwd), "ls");
	assert.equal(stripCdPrefix('cd "$PWD" && ls', cwd), "ls");
	assert.equal(stripCdPrefix(`cd ${cwd}/ && ls`, cwd), "ls");
	assert.equal(stripCdPrefix("cd /tmp && ls", cwd), "cd /tmp && ls"); // different dir kept
});

test("renderCall: does not mutate lines across multiple render passes", async () => {
	const { createBackgroundAwareBashTool } = await import("../src/bash-override.ts");
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-render", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		const tool = createBackgroundAwareBashTool("/workspace", {
			registry: reg,
			fgNice: 10,
		}) as unknown as {
			renderCall: (
				args: unknown,
				theme: { fg: (_c: string, t: string) => string },
				context: { expanded?: boolean; cwd?: string },
			) => { render: (w: number) => string[] };
		};
		const theme = { fg: (_c: string, t: string) => t };
		const component = tool.renderCall({ taskAction: "list" }, theme, { expanded: true, cwd: "/workspace" });
		const pass1 = component.render(80);
		const pass2 = component.render(80);
		assert.deepEqual(pass1, pass2);
		assert.equal(pass1.length, 1);
		assert.match(pass1[0], /bash tasks.*list/);
	} finally {
		await reg.disposeAll();
	}
});

test("createBackgroundTaskTool: launches background task directly", async () => {
	const { createBackgroundTaskTool } = await import("../src/bash-override.ts");
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-launch", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		const bgTool = createBackgroundTaskTool("/tmp", {
			registry: reg,
			fgNice: 10,
		});
		const result = await (bgTool.execute as any)("call-bg-1", {
			command: "sleep 2",
			taskName: "direct-bg-job",
		});
		assert.equal(result.isError, false);
		const details = result.details as any;
		assert.equal(details.id, "task-1");
		assert.equal(details.name, "direct-bg-job");
		assert.match(result.content[0].text, /task id: task-1/);
		assert.equal(reg.get("task-1")?.status, "running");
	} finally {
		await reg.disposeAll();
	}
});

test("createManageBackgroundTaskTool: handles list, status, and kill directly", async () => {
	const { createManageBackgroundTaskTool } = await import("../src/bash-override.ts");
	const reg = createTaskManager({ logDir: "/tmp/bg-tests-manage", killGraceMs: 100, logBytes: 4096, maxFinished: 5 });
	try {
		await reg.run("sleep 5", "/tmp", { name: "target-proc" });
		const manageTool = createManageBackgroundTaskTool({
			registry: reg,
			fgNice: 10,
		});

		const listRes = await (manageTool.execute as any)("call-m-1", { action: "list" });
		assert.equal(listRes.isError, false);
		assert.match(listRes.content[0].text, /task-1/);
		assert.match(listRes.content[0].text, /sleep 5/);

		const statusRes = await (manageTool.execute as any)("call-m-2", { action: "status", taskId: "task-1" });
		assert.equal(statusRes.isError, false);
		assert.match(statusRes.content[0].text, /task-1/);

		const killRes = await (manageTool.execute as any)("call-m-3", { action: "kill", taskId: "task-1" });
		assert.equal(killRes.isError, false);
		assert.match(killRes.content[0].text, /Killed task-1/);
		assert.equal(reg.get("task-1")?.status, "killed");
	} finally {
		await reg.disposeAll();
	}
});
