import assert from "node:assert/strict";
import test from "node:test";

import { TasksPanel } from "../src/ui/panel.ts";
import type { BgTask, TaskManagerApi } from "../src/types.ts";

function createMockTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		underline: (text: string) => text,
		italic: (text: string) => text,
	};
}

function createMockUi() {
	return {
		confirm: async (_title: string, _message: string) => true,
		input: async (_prompt: string) => "test input",
	} as any;
}

test("TasksPanel: renders list with active counts and history toggle", () => {
	const tasks: BgTask[] = [
		{
			id: "task-1",
			command: "sleep 10",
			origin: "bg_task",
			status: "running",
			pid: 100,
			pgid: 100,
			startedAt: 1000,
			endedAt: null,
			exitCode: null,
			signal: null,
			logPath: "/tmp/task-1.log",
			bytesWritten: 1024,
		},
		{
			id: "task-2",
			command: "echo done",
			origin: "bg_task",
			status: "completed",
			pid: 101,
			pgid: 101,
			startedAt: 500,
			endedAt: 600,
			exitCode: 0,
			signal: null,
			logPath: "/tmp/task-2.log",
			bytesWritten: 200,
		},
	];

	const registry: Partial<TaskManagerApi> = {
		list: () => tasks,
		get: (id: string) => tasks.find((t) => t.id === id),
		logs: async () => "sample output\nline 2",
		onChange: () => () => {},
	};

	let closed = false;
	const panel = new TasksPanel(
		createMockTheme() as any,
		registry as TaskManagerApi,
		createMockUi(),
		() => { closed = true; },
	);

	// Initially running task is visible; history is hidden by default when running tasks exist
	let rendered = panel.render(80);
	assert.ok(rendered.some((l) => l.includes("1 active")));
	assert.ok(rendered.some((l) => l.includes("sleep 10")));

	// Toggle history with 'h'
	panel.handleInput("h");
	rendered = panel.render(80);
	assert.ok(rendered.some((l) => l.includes("1 active · 1 history")));
	assert.ok(rendered.some((l) => l.includes("echo done")));

	// Action 'c' on selected row shows output path
	panel.handleInput("c");
	rendered = panel.render(80);
	assert.ok(rendered.some((l) => l.includes("Log path: /tmp/task-1.log")));

	// Close with 'q'
	panel.handleInput("q");
	assert.equal(closed, true);
	panel.dispose();
});

test("TasksPanel: two-step confirmation for stop all", async () => {
	const tasks: BgTask[] = [
		{
			id: "task-1",
			command: "sleep 10",
			origin: "bg_task",
			status: "running",
			pid: 100,
			pgid: 100,
			startedAt: 1000,
			endedAt: null,
			exitCode: null,
			signal: null,
			logPath: "/tmp/task-1.log",
		},
	];

	let stoppedCalled = false;
	const registry: Partial<TaskManagerApi> = {
		list: () => tasks,
		stopAllRunning: async () => {
			stoppedCalled = true;
			return { stopped: 1, failures: [] };
		},
		onChange: () => () => {},
	};

	const panel = new TasksPanel(
		createMockTheme() as any,
		registry as TaskManagerApi,
		createMockUi(),
		() => {},
	);

	// First press of 'a' arms confirmation
	panel.handleInput("a");
	let rendered = panel.render(80);
	assert.ok(rendered.some((l) => l.includes("Press a/K again to stop all 1 running task(s).")));
	assert.equal(stoppedCalled, false);

	// Second press executes stop
	panel.handleInput("a");
	assert.equal(stoppedCalled, true);
	panel.dispose();
});
