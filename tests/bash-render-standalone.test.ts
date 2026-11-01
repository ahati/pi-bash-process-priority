import assert from "node:assert/strict";
import test from "node:test";
import { renderBashCall } from "../src/ui/bash-display.ts";
import { renderBashResult } from "../src/ui/bash-result.ts";
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
