import assert from "node:assert/strict";
import test from "node:test";
import {
	renderBashCall,
	renderBackgroundTaskCall,
	renderManageBackgroundTaskCall,
} from "../src/ui/bash-display.ts";
import {
	renderBashResult,
	renderBackgroundTaskResult,
	renderManageBackgroundTaskResult,
} from "../src/ui/bash-result.ts";
import { extractProgramName, buildBashIntentSystemPrompt, BASH_INTENT_GUIDELINE_MARKER } from "../src/ui/bash-intent.ts";
import { sanitizeAnsiForThemedOutput } from "../src/ui/ansi-utils.ts";

function createPassThroughTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function renderedSingleLine(component: { render(width: number): string[] }, width = 120): string {
	return component.render(width).join("").replace(/\s+/g, " ").trim();
}

test("extractProgramName: strips wrappers and flags to extract true program", () => {
	assert.equal(extractProgramName("sudo apt update"), "apt");
	assert.equal(extractProgramName("sudo -u root systemctl restart service"), "systemctl");
	assert.equal(extractProgramName("nice -n 10 git fetch origin"), "git");
	assert.equal(extractProgramName("env FOO=1 BAR=2 pnpm test"), "pnpm");
	assert.equal(extractProgramName("git status | grep dirty"), "git");
	assert.equal(extractProgramName("nohup python worker.py &"), "python");
});

test("buildBashIntentSystemPrompt: appends guideline idempotently", () => {
	const base = "You are a helpful coding assistant.";
	const prompted = buildBashIntentSystemPrompt(base);
	assert.ok(prompted);
	assert.ok(prompted.includes(base));
	assert.ok(prompted.includes(BASH_INTENT_GUIDELINE_MARKER));

	// Idempotency check: should return undefined if marker already exists
	const duplicate = buildBashIntentSystemPrompt(prompted);
	assert.equal(duplicate, undefined);
});

test("renderBashCall: basic command rendering with prompt", () => {
	const theme = createPassThroughTheme();
	const comp = renderBashCall({ command: "ls -la" }, theme, { cwd: "/workspace" });
	const text = renderedSingleLine(comp);
	assert.ok(text.includes("$ ls -la"));
});

test("renderBashCall: leading intent and tool comments parsed into header", () => {
	const theme = createPassThroughTheme();
	const comp = renderBashCall(
		{
			command: "# tool: git status\n# intent: check dirty files\ngit status --short",
		},
		theme,
		{ cwd: "/workspace" },
		{ intentMode: "render" },
	);
	const text = renderedSingleLine(comp);
	assert.ok(text.includes("🔧"));
	assert.ok(text.includes("git status"));
	assert.ok(text.includes("check dirty files"));
});

test("renderBashCall: background badge and taskName", () => {
	const theme = createPassThroughTheme();
	const comp = renderBashCall(
		{
			command: "sleep 100",
			background: true,
			taskName: "my-bg-job",
		},
		theme,
		{ cwd: "/workspace" },
	);
	const text = renderedSingleLine(comp);
	assert.ok(text.includes("⏾ background · my-bg-job"));
});

test("renderBashCall: management calls render bash tasks header", () => {
	const theme = createPassThroughTheme();
	const compList = renderBashCall({ taskAction: "list" }, theme, { cwd: "/workspace" });
	assert.ok(renderedSingleLine(compList).includes("bash tasks · list"));

	const compKill = renderBashCall({ taskAction: "kill", taskId: "task-42" }, theme, { cwd: "/workspace" });
	assert.ok(renderedSingleLine(compKill).includes("bash tasks · kill task-42"));
});

test("renderBashCall: drops redundant cd prefix to cwd", () => {
	const theme = createPassThroughTheme();
	const comp = renderBashCall(
		{ command: "cd /workspace && npm test" },
		theme,
		{ cwd: "/workspace" },
	);
	const text = renderedSingleLine(comp);
	assert.ok(!text.includes("cd /workspace &&"));
	assert.ok(text.includes("npm test"));
});

test("renderBashCall: expanded view displays cwd line", () => {
	const theme = createPassThroughTheme();
	const comp = renderBashCall(
		{ command: "npm test", cwd: "/workspace/subproject" },
		theme,
		{ expanded: true, cwd: "/workspace" },
	);
	const lines = comp.render(100);
	assert.ok(lines.some((l) => l.includes("cwd: /workspace/subproject")));
});

test("renderBashResult: background task result renders clean output", () => {
	const theme = createPassThroughTheme();
	const compNoOutput = renderBashResult(
		{ content: "" },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { background: true } },
	);
	assert.ok(renderedSingleLine(compNoOutput).includes("↳ (no output)"));

	const compWithOutput = renderBashResult(
		{ content: "Tool is running as a background task with task id: task-1" },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { background: true } },
	);
	assert.ok(renderedSingleLine(compWithOutput).includes("task id: task-1"));
});

test("renderBashResult: quiet command completed indication", () => {
	const theme = createPassThroughTheme();
	const comp = renderBashResult(
		{ content: "" },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { command: "mkdir -p src/foo" } },
	);
	assert.ok(renderedSingleLine(comp).includes("↳ command completed (no output)"));
});

test("renderBashResult: error result formats error line", () => {
	const theme = createPassThroughTheme();
	const comp = renderBashResult(
		{
			content: "cat: nonexistent.txt: No such file or directory",
			isError: true,
			details: { exitCode: 1 },
		},
		{ expanded: false, isPartial: false },
		theme,
		{ isError: true },
	);
	const text = renderedSingleLine(comp);
	assert.ok(text.includes("↳ command failed"));
	assert.ok(text.includes("nonexistent.txt"));
});

test("renderBashResult: partial preview streaming with truncation hint", () => {
	const theme = createPassThroughTheme();
	const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const comp = renderBashResult(
		{ content: output },
		{ expanded: false, isPartial: true },
		theme,
	);
	const lines = comp.render(80);
	assert.ok(lines.some((l) => l.includes("line 1")));
	assert.ok(lines.some((l) => l.includes("more lines")));
});

test("sanitizeAnsiForThemedOutput: removes problematic ANSI background escapes", () => {
	const input = "\x1b[41mRedBackground\x1b[0mNormal";
	const sanitized = sanitizeAnsiForThemedOutput(input);
	assert.ok(!sanitized.includes("\x1b[41m"));
	assert.ok(sanitized.includes("RedBackground"));
});

// ─── Dedicated Tool Renderers ────────────────────────────────────────────────

test("renderBackgroundTaskCall: renders background task with moon badge and taskName", () => {
	const theme = createPassThroughTheme();
	const compNamed = renderBackgroundTaskCall(
		{ command: "npm run build:watch", taskName: "compiler" },
		theme,
		{ cwd: "/workspace" },
	);
	const textNamed = renderedSingleLine(compNamed);
	assert.ok(textNamed.includes("⏾ background task"));
	assert.ok(textNamed.includes("compiler"));
	assert.ok(textNamed.includes("$ npm run build:watch"));

	const compAnon = renderBackgroundTaskCall(
		{ command: "python server.py" },
		theme,
		{ cwd: "/workspace" },
	);
	const textAnon = renderedSingleLine(compAnon);
	assert.ok(textAnon.includes("⏾ background task"));
	assert.ok(textAnon.includes("$ python server.py"));
});

test("renderBackgroundTaskCall: expanded view shows cwd", () => {
	const theme = createPassThroughTheme();
	const comp = renderBackgroundTaskCall(
		{ command: "cargo watch", cwd: "/workspace/backend" },
		theme,
		{ expanded: true, cwd: "/workspace" },
	);
	const lines = comp.render(100);
	assert.ok(lines.some((l) => l.includes("cwd: /workspace/backend")));
});

test("renderBackgroundTaskResult: renders confirmation card with task ID and log path", () => {
	const theme = createPassThroughTheme();
	const comp = renderBackgroundTaskResult(
		{
			content: "Tool is running as a background task with task id: task-3\nOutput: /tmp/task-3.log",
			details: { id: "task-3", name: "test-runner", logPath: "/tmp/task-3.log" },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	const text = renderedSingleLine(comp);
	assert.ok(text.includes("⏾ Background task started"));
	assert.ok(text.includes("task-3"));
	assert.ok(text.includes("test-runner"));
	assert.ok(text.includes("↳ Log: /tmp/task-3.log"));
	assert.ok(text.includes("Do not poll"));
});

test("renderBackgroundTaskResult: formats error", () => {
	const theme = createPassThroughTheme();
	const comp = renderBackgroundTaskResult(
		{ content: "Timeout 999s exceeds background cap", isError: true },
		{ expanded: false, isPartial: false },
		theme,
		{ isError: true },
	);
	const text = renderedSingleLine(comp);
	assert.ok(text.includes("↳ failed to start background task"));
	assert.ok(text.includes("Timeout 999s"));
});

test("renderManageBackgroundTaskCall: renders action and target with wrench icon", () => {
	const theme = createPassThroughTheme();
	const compList = renderManageBackgroundTaskCall({ action: "list" }, theme, { cwd: "/workspace" });
	assert.ok(renderedSingleLine(compList).includes("🔧 task manager · list"));

	const compStatus = renderManageBackgroundTaskCall({ action: "status", taskId: "task-2" }, theme, { cwd: "/workspace" });
	assert.ok(renderedSingleLine(compStatus).includes("🔧 task manager · status task-2"));

	const compKill = renderManageBackgroundTaskCall({ action: "kill", taskId: "task-1" }, theme, { cwd: "/workspace" });
	assert.ok(renderedSingleLine(compKill).includes("🔧 task manager · kill task-1"));

	const compAdopt = renderManageBackgroundTaskCall({ action: "adopt" }, theme, { cwd: "/workspace" });
	assert.ok(renderedSingleLine(compAdopt).includes("🔧 task manager · adopt"));
});

test("renderManageBackgroundTaskResult: formats kill and adopt with checkmark", () => {
	const theme = createPassThroughTheme();
	const compKill = renderManageBackgroundTaskResult(
		{ content: "Killed task-1 (sleep 100)" },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "kill" } },
	);
	assert.ok(renderedSingleLine(compKill).includes("✓ Killed task-1 (sleep 100)"));

	const compAdopt = renderManageBackgroundTaskResult(
		{ content: "Moved to background: task-1 (sleep 100)\nOutput: /tmp/task-1.log" },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "adopt" } },
	);
	assert.ok(renderedSingleLine(compAdopt).includes("✓ Moved to background"));
});

test("renderManageBackgroundTaskResult: formats list and error", () => {
	const theme = createPassThroughTheme();
	const compEmpty = renderManageBackgroundTaskResult(
		{ content: "No background tasks." },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "list" } },
	);
	assert.ok(renderedSingleLine(compEmpty).includes("↳ No background tasks."));

	const compError = renderManageBackgroundTaskResult(
		{ content: "Unknown task: task-99", isError: true },
		{ expanded: false, isPartial: false },
		theme,
		{ isError: true },
	);
	assert.ok(renderedSingleLine(compError).includes("↳ error: Unknown task: task-99"));
});
