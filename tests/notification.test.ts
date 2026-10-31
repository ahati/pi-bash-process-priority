import test from "node:test";
import assert from "node:assert/strict";
import { parseNotificationXml, renderBgNotification } from "../src/ui/notification.ts";
import type { BgNotificationDetails } from "../src/types.ts";

const XML = `<background-task-notification>
  <task-id>task-1</task-id>
  <task-name>long wait</task-name>
  <origin>bg_task</origin>
  <status>completed</status>
  <exit-code>0</exit-code>
  <output-file>/tmp/task-1.log</output-file>
  <summary>Background task "long wait" completed (exit 0)</summary>
</background-task-notification>`;

const THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

test("parseNotificationXml extracts fields", () => {
	const parsed = parseNotificationXml(XML);
	assert.equal(parsed?.taskId, "task-1");
	assert.equal(parsed?.taskName, "long wait");
	assert.equal(parsed?.status, "completed");
	assert.equal(parsed?.exitCode, 0);
	assert.equal(parseNotificationXml("<other/>"), undefined);
});

test("renderer: styled collapsed line from details", () => {
	const details: BgNotificationDetails = {
		kind: "terminal",
		task: { id: "task-1", command: "sleep 120", origin: "bg_task", status: "completed", pid: 1, pgid: 1, startedAt: 0, endedAt: 120000, exitCode: 0, signal: null, logPath: "/tmp/t1.log" },
	};
	const component = renderBgNotification({ content: XML, details }, { expanded: false }, THEME as never);
	const lines = component!.render(200);
	assert.match(lines.join("\n"), /task-1 completed/);
	assert.match(lines.join("\n"), /sleep 120/);
});

test("renderer: styled expanded card from details", () => {
	const details: BgNotificationDetails = {
		kind: "terminal",
		task: { id: "task-1", command: "sleep 120", origin: "bg_task", status: "completed", pid: 1, pgid: 1, startedAt: 0, endedAt: 120000, exitCode: 0, signal: null, logPath: "/tmp/t1.log" },
	};
	const component = renderBgNotification({ content: XML, details }, { expanded: true }, THEME as never);
	const rendered = component!.render(200).join("\n");
	assert.match(rendered, /Background task completed — task-1/);
	assert.match(rendered, /Command:\s+\$\s+sleep 120/);
	assert.match(rendered, /Outcome:\s+exit 0/);
	assert.match(rendered, /Origin:\s+bg_task/);
	assert.match(rendered, /Output:\s+\/tmp\/t1\.log/);
});

test("renderer: XML fallback renders the notice when details are lost", () => {
	const component = renderBgNotification({ content: XML }, { expanded: false }, THEME as never);
	assert.notEqual(component, undefined);
	const lines = component!.render(200);
	assert.match(lines.join("\n"), /task-1 completed/);
	assert.match(lines.join("\n"), /long wait/);
	assert.match(lines.join("\n"), /exit 0/);
});

test("renderer: killed notice from XML fallback shows signal", () => {
	const killedXml = XML.replace("<status>completed</status>", "<status>killed</status>").replace(
		"<exit-code>0</exit-code>",
		"<signal>SIGTERM</signal>",
	);
	const component = renderBgNotification({ content: killedXml }, { expanded: false }, THEME as never);
	const lines = component!.render(200);
	assert.match(lines.join("\n"), /task-1 killed/);
	assert.match(lines.join("\n"), /SIGTERM/);
});

test("renderer: still-running kind renders the dim line", () => {
	const details: BgNotificationDetails = {
		kind: "still-running",
		task: { id: "task-2", command: "sleep 300", origin: "bg_task", status: "running", pid: 2, pgid: 2, startedAt: 0, endedAt: null, exitCode: null, signal: null, logPath: "/tmp/t2.log" },
		elapsedSeconds: 30,
	};
	const component = renderBgNotification({ content: "still running", details }, { expanded: false }, THEME as never);
	assert.match(component!.render(200).join("\n"), /still running after 30s/);
});

test("renderer: foreign content returns undefined (default rendering)", () => {
	assert.equal(renderBgNotification({ content: "unrelated" }, { expanded: false }, THEME as never), undefined);
});
