import assert from "node:assert/strict";
import test from "node:test";
import { taskStatusIcon, dockRow, detailLines } from "../src/ui/format.ts";
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

test("taskStatusIcon: prefixes with sand-clock / green tick / red cross", () => {
	const theme = {
		fg: (c: string, text: string) => `[${c}]${text}[/${c}]`,
	};

	// 1. Running -> sand-clock ⏳
	const runningTask = makeTask({ status: "running" });
	assert.equal(taskStatusIcon(runningTask), "⏳");
	assert.equal(taskStatusIcon(runningTask, theme), "[warning]⏳[/warning]");

	// 2. Completed (success) -> green tick ✔
	const completedTask = makeTask({ status: "completed", exitCode: 0, endedAt: 1700000005000 });
	assert.equal(taskStatusIcon(completedTask), "✔");
	assert.equal(taskStatusIcon(completedTask, theme), "[success]✔[/success]");

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
	assert.ok(rowRunning.includes("⏳"));

	const completed = makeTask({ status: "completed", exitCode: 0 });
	const rowCompleted = dockRow(completed, false, 80);
	assert.ok(rowCompleted.includes("✔"));

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

test("detailLines: LHS labels in different colours and Status RHS red/green based on status", () => {
	const theme = {
		fg: (c: string, text: string) => `[${c}]${text}[/${c}]`,
		bold: (text: string) => `**${text}**`,
	};

	// 1. Running task:
	// - Command LHS: [accent]Command:[/accent]
	// - Status LHS: [warning]Status:[/warning]
	// - Type LHS: [toolTitle]Type:[/toolTitle]
	// - Started LHS: [muted]Started:[/muted]
	// - Status RHS: green [success]running · ...[/success]
	const running = makeTask({ status: "running" });
	const runningLines = detailLines(running, 200, running.startedAt + 5000, { theme });
	assert.ok(runningLines.some((l) => l.includes("[accent]Command:[/accent]")), "Command LHS is accent");
	assert.ok(runningLines.some((l) => l.includes("[warning]Status:[/warning]")), "Status LHS is warning");
	assert.ok(runningLines.some((l) => l.includes("[toolTitle]Type:[/toolTitle]")), "Type LHS is toolTitle");
	assert.ok(runningLines.some((l) => l.includes("[muted]Started:[/muted]")), "Started LHS is muted");
	assert.ok(runningLines.some((l) => l.includes("[success]running · 5s[/success]")), "Running status RHS is green (success)");

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
