import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	detailLines,
	dockFrame,
	dockRow,
	footerSegment,
	formatClock,
	formatDuration,
	formatTimestamp,
	humanizeOrigin,
	notificationCollapsedLine,
	notificationExpandedLines,
	statusColorToken,
	statusWord,
	stillRunningLine,
	terminalStatusLabel,
} from "../src/ui/format.ts";
import type { BgNotificationDetails, BgTask } from "../src/types.ts";

function task(overrides: Partial<BgTask> = {}): BgTask {
	return {
		id: "task-2",
		command: "sleep 120",
		origin: "bg_task",
		status: "running",
		pid: 123,
		pgid: 123,
		startedAt: new Date(2026, 9, 31, 10, 56, 52).getTime(),
		endedAt: null,
		exitCode: null,
		signal: null,
		logPath: "/tmp/.pi/bg-tasks/task-2.log",
		...overrides,
	};
}

function details(overrides: Partial<BgNotificationDetails> = {}): BgNotificationDetails {
	return { kind: "terminal", task: task(), ...overrides };
}

test("formatClock / formatTimestamp are local, zero-padded strings", () => {
	const ts = new Date(2026, 0, 5, 4, 3, 2).getTime();
	assert.equal(formatClock(ts), "04:03:02");
	assert.equal(formatTimestamp(ts), "2026-01-05 04:03:02");
});

test("formatDuration compact forms", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(60_000), "1m 00s");
	assert.equal(formatDuration(121_000), "2m 01s");
	assert.equal(formatDuration(5 * 60_000 + 12_000), "5m 12s");
	assert.equal(formatDuration(3_600_000), "1h 00m");
	assert.equal(formatDuration(3_600_000 + 4 * 60_000), "1h 04m");
	assert.equal(formatDuration(86_400_000 + 2 * 3_600_000), "1d 2h");
	assert.equal(formatDuration(-5), "0s");
});

test("status vocabulary and color tokens", () => {
	assert.equal(statusWord("running"), "running");
	assert.equal(statusWord("killed"), "killed");
	assert.equal(statusColorToken("running"), "accent");
	assert.equal(statusColorToken("completed"), "success");
	assert.equal(statusColorToken("failed"), "error");
	assert.equal(statusColorToken("killed"), "dim");
});

test("terminalStatusLabel", () => {
	assert.equal(terminalStatusLabel(task({ status: "completed", exitCode: 0 })), "exit 0");
	assert.equal(terminalStatusLabel(task({ status: "failed", exitCode: 1 })), "exit 1");
	assert.equal(terminalStatusLabel(task({ status: "killed", signal: "SIGKILL", exitCode: 137 })), "SIGKILL");
	assert.equal(terminalStatusLabel(task()), "");
});

test("dockRow matches §4.1, selection and terminal suffixes", () => {
	assert.equal(dockRow(task(), false, 80), "  ● [10:56:52] sleep 120 running");
	assert.equal(dockRow(task(), true, 80), "> ● [10:56:52] sleep 120 running");
	assert.equal(
		dockRow(task({ status: "failed", exitCode: 1 }), false, 80),
		"  ✗ [10:56:52] sleep 120 failed (exit 1)",
	);
	assert.equal(
		dockRow(task({ status: "killed", signal: "SIGKILL", reason: "user kill" }), false, 80),
		"  ✗ [10:56:52] sleep 120 killed (user kill)",
	);
	assert.equal(
		dockRow(task({ status: "killed", signal: "SIGKILL" }), false, 80),
		"  ✗ [10:56:52] sleep 120 killed (SIGKILL)",
	);
	assert.equal(dockRow(task({ status: "completed", exitCode: 0 }), false, 80).startsWith("  ✔ [10:56:52]"), true);
	assert.equal(dockRow(task({ status: "completed", exitCode: 0 }), false, 80).endsWith("completed"), true);
});

test("dockRow collapses commands to one line and never exceeds width", () => {
	const row = dockRow(task({ command: "echo one\necho two\t  end" }), false, 80);
	assert.equal(row, "  ● [10:56:52] echo one echo two end running");
	for (const width of [10, 24, 30, 40]) {
		assert.ok(visibleWidth(dockRow(task({ command: "x".repeat(200) }), false, width)) <= width);
	}
});

test("dockFrame wraps rows in full-width rules", () => {
	const rows = ["a", "b"];
	assert.deepEqual(dockFrame(rows, 5), ["─────", "a", "b", "─────"]);
	assert.deepEqual(dockFrame([], 3), ["───", "───"]);
});

test("footerSegment", () => {
	assert.equal(footerSegment(0), "");
	assert.equal(footerSegment(-1), "");
	assert.equal(footerSegment(3), "3 task(s) · /tasks");
});

test("detailLines matches the §4.2 header block", () => {
	const lines = detailLines(task(), 40);
	assert.deepEqual(lines, [
		"Task Details",
		"",
		"Command: sleep 120",
		"Status:  ● running",
		"Type:    Agent",
		"Started: 2026-10-31 10:56:52",
		"",
		"─".repeat(40),
		"Output",
	]);

	const linesWithNow = detailLines(task(), 40, task().startedAt + 15_000);
	assert.equal(linesWithNow[3], "Status:  ● running · 15s");

	const subagentTask = detailLines(task({ callerType: "subagent" }), 40);
	assert.equal(subagentTask[4], "Type:    Subagent");

	const subagentNamedTask = detailLines(task({ callerType: "subagent", subagentName: "researcher#a1b2c3d4" }), 40);
	assert.equal(subagentNamedTask[4], "Type:    Subagent (researcher#a1b2c3d4)");
});

test("notificationCollapsedLine matches Pi style", () => {
	const d = details({
		task: task({ status: "completed", exitCode: 0, endedAt: task().startedAt + 121_000 }),
		durationText: "2m 01s",
	});
	assert.equal(notificationCollapsedLine(d, 120), "✓ task-2 completed (exit 0 · 2m 01s)");
});

test("notificationCollapsedLine adds failure/kill outcomes and truncates", () => {
	assert.equal(
		notificationCollapsedLine(
			details({ task: task({ status: "failed", exitCode: 1, endedAt: task().startedAt + 45_000 }) }),
			120,
		),
		"✗ task-2 failed (exit 1 · 45s)",
	);
	assert.equal(
		notificationCollapsedLine(
			details({ task: task({ status: "killed", signal: "SIGKILL", reason: "user kill" }) }),
			120,
		),
		"⏾ task-2 killed (user kill)",
	);
	const wide = details({
		task: task({ status: "completed", exitCode: 0, endedAt: task().startedAt + 121_000 }),
		durationText: "2m 01s",
	});
	assert.ok(visibleWidth(notificationCollapsedLine(wide, 30)) <= 30);
});

test("notificationExpandedLines matches Pi style expanded block", () => {
	const started = new Date(2026, 9, 31, 10, 56, 52).getTime();
	const d = details({
		task: task({ status: "completed", exitCode: 0, startedAt: started, endedAt: started + 121_000 }),
		durationText: "2m 01s",
		startedClock: "10:56:52",
	});
	const lines = notificationExpandedLines(d, ["line one", "line two"], 60);
	assert.deepEqual(lines, [
		"✓ Background task completed — task-2",
		"  Command:  $ sleep 120",
		"  Ran:      2m 01s · started 10:56:52 · ended 10:58:53",
		"  Outcome:  exit 0",
		"  Origin:   bg_task",
		"  Output:   /tmp/.pi/bg-tasks/task-2.log",
		`  ${"─".repeat(58)}`,
		"  line one",
		"  line two",
	]);
	for (const line of lines) assert.ok(visibleWidth(line) <= 60);
});

test("humanizeOrigin and stillRunningLine", () => {
	assert.equal(humanizeOrigin("bg_task"), "bg_task");
	assert.equal(humanizeOrigin("foreground-adopted"), "ctrl+b (foreground adopt)");
	assert.equal(
		stillRunningLine(details({ kind: "still-running", elapsedSeconds: 30 }), 120),
		"⏾ task-2 still running after 30s",
	);
	assert.ok(visibleWidth(stillRunningLine(details({ kind: "still-running", elapsedSeconds: 30 }), 20)) <= 20);
});
