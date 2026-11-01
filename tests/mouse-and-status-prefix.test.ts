import assert from "node:assert/strict";
import test from "node:test";
import {
	taskStatusIcon,
	dockRow,
	detailLines,
	formatHeaderLine,
	formatCleanTaskRow,
	formatCwdAndLog,
} from "../src/ui/format.ts";
import { DockController, MAX_DOCK_VISIBLE, installDock } from "../src/ui/dock.ts";
import { parseMouseInput } from "../src/ui/terminal-mouse.ts";
import type { BgTask } from "../src/types.ts";

function makeTask(overrides: Partial<BgTask> = {}): BgTask {
	return {
		id: "task-1",
		command: "sleep 10",
		status: "running",
		pid: 123,
		pgid: 123,
		startedAt: 1700000000000,
		endedAt: null,
		exitCode: null,
		signal: null,
		logPath: "/tmp/test.log",
		origin: "bg_task",
		...overrides,
	};
}

test("taskStatusIcon: prefixes with green dot / green tick / red cross", () => {
	const theme = {
		fg: (c: string, text: string) => `[${c}]${text}[/${c}]`,
	};

	// 1. Running -> green dot ●
	const runningTask = makeTask({ status: "running" });
	assert.equal(taskStatusIcon(runningTask), "●");
	assert.equal(taskStatusIcon(runningTask, theme), "[success]●[/success]");

	// 2. Completed (success) -> green tick ✓
	const completedTask = makeTask({ status: "completed", exitCode: 0, endedAt: 1700000005000 });
	assert.equal(taskStatusIcon(completedTask), "✓");
	assert.equal(taskStatusIcon(completedTask, theme), "[success]✓[/success]");

	// 3. Failed -> red cross ✗
	const failedTask = makeTask({ status: "failed", exitCode: 1, endedAt: 1700000005000 });
	assert.equal(taskStatusIcon(failedTask), "✗");
	assert.equal(taskStatusIcon(failedTask, theme), "[error]✗[/error]");

	// 4. Killed -> red cross ✗
	const killedTask = makeTask({ status: "killed", signal: "SIGTERM", endedAt: 1700000005000 });
	assert.equal(taskStatusIcon(killedTask), "✗");
	assert.equal(taskStatusIcon(killedTask, theme), "[error]✗[/error]");
});

test("dockRow: includes status icon prefix", () => {
	const running = makeTask({ status: "running" });
	const rowRunning = dockRow(running, false, 80);
	assert.ok(rowRunning.includes("●"));

	const completed = makeTask({ status: "completed", exitCode: 0 });
	const rowCompleted = dockRow(completed, false, 80);
	assert.ok(rowCompleted.includes("✓"));

	const failed = makeTask({ status: "failed", exitCode: 2 });
	const rowFailed = dockRow(failed, false, 80);
	assert.ok(rowFailed.includes("✗"));
});

test("DockController: clamps to at most 3 visible rows and is scrollable", () => {
	assert.equal(MAX_DOCK_VISIBLE, 3);

	const tasks: BgTask[] = [
		makeTask({ id: "t1", command: "cmd 1" }),
		makeTask({ id: "t2", command: "cmd 2" }),
		makeTask({ id: "t3", command: "cmd 3" }),
		makeTask({ id: "t4", command: "cmd 4" }),
		makeTask({ id: "t5", command: "cmd 5" }),
	];

	const controller = new DockController(() => tasks);
	controller.enterDock();

	assert.equal(controller.getListOffset(), 0);

	// Mouse wheel down (+1) scrolls the window
	controller.scrollList(1);
	assert.equal(controller.getListOffset(), 1);

	controller.scrollList(1);
	assert.equal(controller.getListOffset(), 2);

	// Clamps at maxOffset (5 - 3 = 2)
	controller.scrollList(1);
	assert.equal(controller.getListOffset(), 2);

	// Mouse wheel up (-1) scrolls back
	controller.scrollList(-1);
	assert.equal(controller.getListOffset(), 1);

	controller.scrollList(-5);
	assert.equal(controller.getListOffset(), 0);
});

test("parseMouseInput: parses SGR and legacy mouse wheel events", () => {
	// 1. SGR Wheel Up: button 64 -> wheelDelta: -1
	const wheelUpSgr = "\x1b[<64;15;20M";
	const parsedUp = parseMouseInput(wheelUpSgr);
	assert.equal(parsedUp.sawMouse, true);
	assert.equal(parsedUp.wheelDelta, -1);

	// 2. SGR Wheel Down: button 65 -> wheelDelta: 1
	const wheelDownSgr = "\x1b[<65;15;20M";
	const parsedDown = parseMouseInput(wheelDownSgr);
	assert.equal(parsedDown.sawMouse, true);
	assert.equal(parsedDown.wheelDelta, 1);

	// 3. Normal text input -> sawMouse false, wheelDelta 0
	const normalInput = "hello world\n";
	const parsedNormal = parseMouseInput(normalInput);
	assert.equal(parsedNormal.sawMouse, false);
	assert.equal(parsedNormal.wheelDelta, 0);

	// 4. Legacy Wheel Up (\x1b[M`...) -> wheelDelta: -1
	const legacyUp = "\x1b[M\x60\x20\x20";
	const parsedLegacyUp = parseMouseInput(legacyUp);
	assert.equal(parsedLegacyUp.sawMouse, true);
	assert.equal(parsedLegacyUp.wheelDelta, -1);

	// 5. Legacy Wheel Down (\x1b[Ma...) -> wheelDelta: 1
	const legacyDown = "\x1b[M\x61\x20\x20";
	const parsedLegacyDown = parseMouseInput(legacyDown);
	assert.equal(parsedLegacyDown.sawMouse, true);
	assert.equal(parsedLegacyDown.wheelDelta, 1);
});

test("detailLines: all LHS labels in same colour (blue/mdLink) and Status RHS red/green based on status", () => {
	const theme = {
		fg: (c: string, text: string) => `[${c}]${text}[/${c}]`,
		bold: (text: string) => `**${text}**`,
	};

	// 1. Running task:
	// - All LHS labels in same colour (mdLink / blue)
	// - Status RHS: green [success]running · ...[/success]
	const running = makeTask({ status: "running" });
	const runningLines = detailLines(running, 200, running.startedAt + 5000, { theme });
	assert.ok(runningLines.some((l) => l.includes("[mdLink]Command:[/mdLink]")), "Command LHS is mdLink");
	assert.ok(runningLines.some((l) => l.includes("[mdLink]Status:[/mdLink]")), "Status LHS is mdLink");
	assert.ok(runningLines.some((l) => l.includes("[mdLink]Type:[/mdLink]")), "Type LHS is mdLink");
	assert.ok(runningLines.some((l) => l.includes("[mdLink]Started:[/mdLink]")), "Started LHS is mdLink");
	assert.ok(runningLines.some((l) => l.includes("[success]●[/success] [success]running · 5s[/success]")), "Running status RHS has green dot and green running text");

	// Metadata LHS labels also in same colour (mdLink)
	const metaLines = detailLines(running, 200, undefined, { showMetadata: true, theme });
	assert.ok(metaLines.some((l) => l.includes("[mdLink]PID:[/mdLink]")), "PID LHS is mdLink");
	assert.ok(metaLines.some((l) => l.includes("[mdLink]Output:[/mdLink]")), "Output LHS is mdLink");

	// 2. Completed task:
	// - Status RHS: green [success]completed · 10s[/success]
	const completed = makeTask({ status: "completed", exitCode: 0, endedAt: running.startedAt + 10000 });
	const completedLines = detailLines(completed, 200, undefined, { theme });
	assert.ok(completedLines.some((l) => l.includes("[success]completed · 10s[/success]")), "Completed status RHS is green (success)");

	// 3. Failed task:
	// - Status RHS: red [error]failed (exit 1) · 1s[/error]
	const failed = makeTask({ status: "failed", exitCode: 1, endedAt: running.startedAt + 1000 });
	const failedLines = detailLines(failed, 200, undefined, { theme });
	assert.ok(failedLines.some((l) => l.includes("[error]failed (exit 1) · 1s[/error]")), "Failed status RHS is red (error)");

	// 4. Killed task:
	// - Status RHS: red [error]killed (SIGKILL) · 1s[/error]
	const killed = makeTask({ status: "killed", signal: "SIGKILL", reason: "SIGKILL", endedAt: running.startedAt + 1000 });
	const killedLines = detailLines(killed, 200, undefined, { theme });
	assert.ok(killedLines.some((l) => l.includes("[error]killed (SIGKILL) · 1s[/error]")), "Killed status RHS is red (error)");
});

test("dockRow: RHS status is red/green based on status when theme is provided", () => {
	const theme = {
		fg: (c: string, text: string) => `[${c}]${text}[/${c}]`,
	};

	const running = makeTask({ status: "running" });
	const runningRow = dockRow(running, false, 200, undefined, theme);
	assert.ok(runningRow.includes("[success]running[/success]"), "running dock row status is green");

	const failed = makeTask({ status: "failed", exitCode: 1 });
	const failedRow = dockRow(failed, false, 200, undefined, theme);
	assert.ok(failedRow.includes("[error]failed (exit 1)[/error]"), "failed dock row status is red");
});

test("DockController: /tasks expanded mode brings all tasks and expands up to 40% vertical screen", () => {
	const running = makeTask({ id: "task-1", status: "running" });
	const completed = makeTask({ id: "task-2", status: "completed", exitCode: 0 });
	const failed = makeTask({ id: "task-3", status: "failed", exitCode: 1 });
	const allTasks = [running, completed, failed];

	const controller = new DockController(
		() => allTasks.filter((t) => t.status === "running"),
		() => allTasks,
	);

	// 1. Normal mode: only running tasks, max visible = 3
	assert.equal(controller.isExpanded(), false);
	assert.equal(controller.getTasks().length, 1);
	assert.equal(controller.getMaxVisible(30), 3);

	// 2. /tasks expanded mode: all tasks (running, completed, failed)
	assert.equal(controller.expandTasks(), true);
	assert.equal(controller.isExpanded(), true);
	assert.equal(controller.getTasks().length, 3);
	// On a 30-row screen, 40% is Math.floor(30 * 0.4) = 12
	assert.equal(controller.getMaxVisible(30), 12);
	// On a 24-row screen, 40% is Math.floor(24 * 0.4) = 9
	assert.equal(controller.getMaxVisible(24), 9);

	// 3. ESC / collapseTasks returns to normal reduced-list view
	controller.collapseTasks();
	assert.equal(controller.isExpanded(), false);
	assert.equal(controller.getTasks().length, 1);
	assert.equal(controller.getMaxVisible(30), 3);
});

test("formatHeaderLine: formats full-width header with title and rules", () => {
	const header = formatHeaderLine("Background Tasks", 60);
	assert.ok(header.startsWith("── Background Tasks ──"));
	assert.equal(header.length, 60);
});

test("formatCleanTaskRow: formats row with status, command, duration, and id", () => {
	const task = makeTask({
		id: "task-2",
		name: "test-heartbeat",
		status: "completed",
		startedAt: 1700000000000,
		endedAt: 1700000012000,
		exitCode: 0,
	});
	const row = formatCleanTaskRow(task, true, 80);
	assert.ok(row.startsWith("> ✓ test-heartbeat"));
	assert.ok(row.endsWith("12s task-2"));
	assert.equal(row.length, 80);

	const unselected = formatCleanTaskRow(task, false, 80);
	assert.ok(unselected.startsWith("  ✓ test-heartbeat"));
});

test("formatCwdAndLog: renders Cwd and Log lines", () => {
	const task = makeTask({
		cwd: "/home/hati/workspace",
		logPath: "/home/hati/workspace/.pi/bg-tasks/task-2.log",
	});
	const lines = formatCwdAndLog(task);
	assert.equal(lines[0], "Cwd: /home/hati/workspace");
	assert.equal(lines[1], "Log: /home/hati/workspace/.pi/bg-tasks/task-2.log");
});

test("merged Master-Detail screen renders master list, details (with Cwd and Log) and Output together", () => {
	const task1 = makeTask({
		id: "task-1",
		name: "test-alpha",
		command: "sleep 10",
		status: "completed",
		exitCode: 0,
		cwd: "/workspace/alpha",
		logPath: "/tmp/task-1.log",
	});
	const task2 = makeTask({
		id: "task-2",
		name: "test-beta",
		command: "sleep 20",
		status: "running",
		cwd: "/workspace/beta",
		logPath: "/tmp/task-2.log",
	});
	const all = [task1, task2];
	const controller = new DockController(
		() => all.filter((t) => t.status === "running"),
		() => all,
	);
	controller.expandTasks("task-1");

	const calls: any[] = [];
	const fakeCtx = {
		ui: {
			setWidget(_key: string, fn: any) {
				calls.push(fn);
			},
		},
	};
	const fakeRegistry = {
		list: () => all,
		onChange: () => () => {},
	};

	installDock(fakeCtx as any, fakeRegistry as any, controller);
	const widgetFactory = calls[calls.length - 1];
	const theme = {
		fg: (_c: string, t: string) => `\x1b[34m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	};
	const widget = widgetFactory({ terminal: { rows: 30 }, requestRender() {} }, theme);
	const lines = widget.render(140);

	// 1. Header & subtitle
	assert.ok(lines.some((l: string) => l.includes("Background Tasks")));
	assert.ok(lines.some((l: string) => l.includes("2 tasks  current session branch")));

	// 2. Both tasks in master list
	assert.ok(lines.some((l: string) => l.includes("test-alpha") && l.includes("task-1")));
	assert.ok(lines.some((l: string) => l.includes("test-beta") && l.includes("task-2")));

	// 3. Task Details section with Cwd and Log
	assert.ok(lines.some((l: string) => l.includes("Task Details")));
	assert.ok(lines.some((l: string) => l.includes("Command:") && l.includes("sleep 10")));
	assert.ok(lines.some((l: string) => l.includes("Cwd:") && l.includes("/workspace/alpha")));
	assert.ok(lines.some((l: string) => l.includes("Log:") && l.includes("/tmp/task-1.log")));

	// 4. Output section
	assert.ok(lines.some((l: string) => l === "Output"));
});

test("reactive selection change: moving index updates Command, Cwd, Log, and Output reactively", () => {
	const task1 = makeTask({
		id: "task-1",
		name: "test-alpha",
		command: "sleep 10",
		status: "completed",
		exitCode: 0,
		cwd: "/workspace/alpha",
		logPath: "/tmp/task-1.log",
	});
	const task2 = makeTask({
		id: "task-2",
		name: "test-beta",
		command: "sleep 20",
		status: "running",
		cwd: "/workspace/beta",
		logPath: "/tmp/task-2.log",
	});
	const all = [task1, task2];
	const controller = new DockController(
		() => all.filter((t) => t.status === "running"),
		() => all,
	);
	controller.expandTasks("task-1");

	const calls: any[] = [];
	const fakeCtx = {
		ui: {
			setWidget(_key: string, fn: any) {
				calls.push(fn);
			},
		},
	};
	const fakeRegistry = {
		list: () => all,
		onChange: () => () => {},
	};

	installDock(fakeCtx as any, fakeRegistry as any, controller);
	const widgetFactory = calls[calls.length - 1];
	const theme = {
		fg: (_c: string, t: string) => `\x1b[34m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	};
	const widget = widgetFactory({ terminal: { rows: 30 }, requestRender() {} }, theme);

	// Initially task 1 selected
	let lines = widget.render(100);
	assert.ok(lines.some((l: string) => l.includes(">") && l.includes("test-alpha")));
	assert.ok(lines.some((l: string) => l.includes("Cwd:") && l.includes("/workspace/alpha")));
	assert.ok(lines.some((l: string) => l.includes("Log:") && l.includes("/tmp/task-1.log")));

	// Move selection down to task 2
	controller.move(1);
	lines = widget.render(100);
	assert.ok(lines.some((l: string) => l.includes(">") && l.includes("test-beta")));
	assert.ok(lines.some((l: string) => l.includes("Command:") && l.includes("sleep 20")));
	assert.ok(lines.some((l: string) => l.includes("Cwd:") && l.includes("/workspace/beta")));
	assert.ok(lines.some((l: string) => l.includes("Log:") && l.includes("/tmp/task-2.log")));

	// Move selection back up to task 1
	controller.move(-1);
	lines = widget.render(100);
	assert.ok(lines.some((l: string) => l.includes(">") && l.includes("test-alpha")));
	assert.ok(lines.some((l: string) => l.includes("Command:") && l.includes("sleep 10")));
	assert.ok(lines.some((l: string) => l.includes("Cwd:") && l.includes("/workspace/alpha")));
	assert.ok(lines.some((l: string) => l.includes("Log:") && l.includes("/tmp/task-1.log")));
});
