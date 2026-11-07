import assert from "node:assert/strict";
import test from "node:test";

import {
	detailLines,
	formatOutputStatusLine,
	formatSize,
	taskAge,
} from "../src/ui/format.ts";
import type { BgTask } from "../src/types.ts";

function sampleTask(overrides: Partial<BgTask> = {}): BgTask {
	return {
		id: "task-5",
		command: "npm test",
		origin: "bg_task",
		status: "running",
		pid: 12345,
		pgid: 12345,
		startedAt: 1730000000000,
		endedAt: null,
		exitCode: null,
		signal: null,
		logPath: "/tmp/logs/task-5.log",
		bytesWritten: 45000,
		...overrides,
	};
}

test("formatSize: formats B, KB, MB cleanly", () => {
	assert.equal(formatSize(0), "0B");
	assert.equal(formatSize(512), "512B");
	assert.equal(formatSize(2048), "2.0KB");
	assert.equal(formatSize(10 * 1024 * 1024), "10.0MB");
});

test("taskAge: computes duration from startedAt to endedAt or now", () => {
	const running = sampleTask({ startedAt: 1000, endedAt: null });
	assert.equal(taskAge(running, 16000), "15s");

	const ended = sampleTask({ startedAt: 1000, endedAt: 65000 });
	assert.equal(taskAge(ended), "1m 04s");
});

test("formatOutputStatusLine: handles following tail vs scrolled-up state", () => {
	const following = formatOutputStatusLine({
		follow: true,
		totalLines: 150,
		scrollTop: 140,
		visibleLines: 10,
		bytesRead: 2048,
		totalBytes: 2048,
		truncated: false,
	});
	assert.equal(following, "following tail 2.0KB · ↑ scroll");

	const followingTruncated = formatOutputStatusLine({
		follow: true,
		totalLines: 150,
		scrollTop: 140,
		visibleLines: 10,
		bytesRead: 51200,
		totalBytes: 1048576,
		truncated: true,
	});
	assert.equal(followingTruncated, "following tail 50.0KB of 1.0MB · ↑ scroll");

	const scrolledUp = formatOutputStatusLine({
		follow: false,
		totalLines: 100,
		scrollTop: 20,
		visibleLines: 10,
		bytesRead: 51200,
		totalBytes: 51200,
		truncated: false,
	});
	assert.equal(scrolledUp, "lines 21–30 of 100 · ↓ end follows");
});

test("detailLines: showMetadata includes PID, Output, and Size when requested", () => {
	const task = sampleTask({ exitCode: 0, status: "completed", endedAt: 1730000060000 });
	const lines = detailLines(task, 80, undefined, { showMetadata: true });

	assert.ok(lines.some((l) => l.includes("PID:     12345")));
	assert.ok(lines.some((l) => l.includes("Exit:    0")));
	assert.ok(lines.some((l) => l.includes("Output:  /tmp/logs/task-5.log")));
	assert.ok(lines.some((l) => l.includes("Size:    43.9KB")));
});
