/**
 * Background-task tool result renderer.
 *
 * Renders results for this extension's own `background_task` and
 * `manage_background_task` tools. Built-in bash results are rendered by pi or
 * pi-ui-enhancement.
 */

import { Text } from "@earendil-works/pi-tui";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.ts";

export interface BashRenderTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

function safeBashResultTheme(theme: BashRenderTheme): { fg: (color: string, text: string) => string; bold: (text: string) => string } {
	return {
		fg: (color: string, text: string) => (typeof theme?.fg === "function" ? theme.fg(color, text) : text),
		bold: (text: string) => (typeof theme?.bold === "function" ? theme.bold(text) : text),
	};
}

export interface BashResultRenderOptions {
	expanded: boolean;
}

interface BashToolDetails {
	exitCode?: number | null;
}

interface ToolRenderContextLike {
	args?: Record<string, unknown>;
	cwd?: string;
	isError?: boolean;
	lastComponent?: unknown;
	state?: unknown;
}

const BASH_RESULT_STATE_KEY = "__piToolDisplayBashResult";
const DEFAULT_PREVIEW_LINES = 8;

function extractTextOutput(result: Record<string, unknown>): string {
	const content = result.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n");
	}
	return "";
}

function splitLines(text: string): string[] {
	if (!text) return [];
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.replace(/\t/g, "    "));
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) {
		end--;
	}
	return lines.slice(0, end);
}

function collapseConsecutiveEmptyLines(lines: string[], maxConsecutive = 1): string[] {
	const out: string[] = [];
	let emptyCount = 0;
	for (const line of lines) {
		if (line.trim().length === 0) {
			emptyCount++;
			if (emptyCount <= maxConsecutive) {
				out.push(line);
			}
		} else {
			emptyCount = 0;
			out.push(line);
		}
	}
	return out;
}

function prepareOutputLines(rawText: string, expanded: boolean): string[] {
	const lines = splitLines(rawText);
	const trimmed = trimTrailingEmptyLines(lines);
	return expanded ? trimmed : collapseConsecutiveEmptyLines(trimmed, 1);
}

function previewLines(
	lines: string[],
	maxLines: number,
): { shown: string[]; remaining: number } {
	const limit = Math.max(0, maxLines);
	const shown = lines.slice(0, limit);
	const remaining = Math.max(0, lines.length - shown.length);
	return { shown, remaining };
}

function formatTruncationHint(remaining: number, expanded: boolean, theme: BashRenderTheme): string {
	if (remaining <= 0) return "";
	const hint = expanded ? "" : " • Ctrl+O to expand";
	const plural = remaining === 1 ? "line" : "lines";
	return `\n${theme.fg("muted", `... (${remaining} more ${plural}${hint})`)}`;
}

function buildPreviewText(
	lines: string[],
	maxLines: number,
	theme: BashRenderTheme,
	expanded: boolean,
): string {
	if (lines.length === 0) {
		return theme.fg("muted", "↳ (no output)");
	}

	const { shown, remaining } = previewLines(lines, maxLines);
	let text = shown
		.map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
		.join("\n");
	text += formatTruncationHint(remaining, expanded, theme);
	return text;
}

function reuseTextComponent(text: string, cached?: Text): Text {
	if (cached) {
		cached.setText(text);
		return cached;
	}
	return new Text(text, 0, 0);
}

function isToolError(result: Record<string, unknown>, context?: ToolRenderContextLike): boolean {
	if (result.isError === true || context?.isError === true) return true;
	const details = result.details as BashToolDetails | undefined;
	if (details?.exitCode !== null && details?.exitCode !== undefined && details.exitCode !== 0) {
		return true;
	}
	return false;
}

export function renderBackgroundTaskResult(
	result: Record<string, unknown>,
	options: BashResultRenderOptions,
	rawTheme: BashRenderTheme,
	context?: ToolRenderContextLike,
): Text {
	const theme = safeBashResultTheme(rawTheme);
	const stateCarrier = context?.state as Record<string, unknown> | undefined;
	const cachedComponent = stateCarrier?.[BASH_RESULT_STATE_KEY] as Text | undefined;
	const rawOutput = extractTextOutput(result);

	if (isToolError(result, context)) {
		const lines = prepareOutputLines(rawOutput, options.expanded);
		let text = theme.fg("error", "↳ failed to start background task");
		if (lines.length > 0) {
			text += `\n${lines.map((l) => theme.fg("error", sanitizeAnsiForThemedOutput(l))).join("\n")}`;
		}
		const rendered = reuseTextComponent(text, cachedComponent);
		if (stateCarrier) stateCarrier[BASH_RESULT_STATE_KEY] = rendered;
		return rendered;
	}

	const details = result.details as Record<string, unknown> | undefined;
	const taskId =
		typeof details?.id === "string"
			? details.id
			: (rawOutput.match(/task id:\s*(task-\d+)/i)?.[1] || "task");
	const taskName = typeof details?.name === "string" ? details.name : undefined;
	const logPath =
		typeof details?.logPath === "string"
			? details.logPath
			: (rawOutput.match(/Output:\s*(\S+)/i)?.[1] || "");

	const header = `${theme.fg("toolTitle", theme.bold("BackgroundTask started"))} ${theme.fg("muted", "·")} ${theme.fg("accent", taskId)}${taskName ? ` ${theme.fg("muted", `(${taskName})`)}` : ""}`;
	const logLine = logPath
		? `\n${theme.fg("muted", "↳ Log: ")}${theme.fg("toolOutput", sanitizeAnsiForThemedOutput(logPath))}`
		: "";
	const hintLine = `\n${theme.fg("muted", "↳ Do not poll. You will be notified when it finishes.")}`;

	const rendered = reuseTextComponent(`${header}${logLine}${hintLine}`, cachedComponent);
	if (stateCarrier) stateCarrier[BASH_RESULT_STATE_KEY] = rendered;
	return rendered;
}

export function renderManageBackgroundTaskResult(
	result: Record<string, unknown>,
	options: BashResultRenderOptions,
	rawTheme: BashRenderTheme,
	context?: ToolRenderContextLike,
): Text {
	const theme = safeBashResultTheme(rawTheme);
	const stateCarrier = context?.state as Record<string, unknown> | undefined;
	const cachedComponent = stateCarrier?.[BASH_RESULT_STATE_KEY] as Text | undefined;
	const rawOutput = extractTextOutput(result);

	if (isToolError(result, context)) {
		const lines = prepareOutputLines(rawOutput, options.expanded);
		let text = theme.fg("error", "↳ error");
		if (lines.length > 0) {
			text += `: ${lines.map((l) => theme.fg("error", sanitizeAnsiForThemedOutput(l))).join("\n")}`;
		}
		const rendered = reuseTextComponent(text, cachedComponent);
		if (stateCarrier) stateCarrier[BASH_RESULT_STATE_KEY] = rendered;
		return rendered;
	}

	const args = context?.args as Record<string, unknown> | undefined;
	const action = (
		typeof args?.action === "string"
			? args.action
			: typeof args?.taskAction === "string"
				? args.taskAction
				: ""
	).trim();

	const lines = prepareOutputLines(rawOutput, options.expanded);
	let renderedText: string;

	if (action === "kill") {
		renderedText = `${theme.fg("accent", "✓")} ${lines.map((l) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(l))).join("\n")}`;
	} else if (action === "list") {
		if (rawOutput.includes("No background tasks")) {
			renderedText = theme.fg("muted", "↳ No background tasks.");
		} else {
			renderedText = lines.map((l) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(l))).join("\n");
		}
	} else if (action === "input") {
		renderedText = theme.fg("toolOutput", `↳ ${rawOutput.trim() || "Input sent."}`);
	} else {
		// status, logs, or default preview
		if (lines.length === 0) {
			renderedText = theme.fg("muted", "↳ (no output)");
		} else {
			const maxLines = options.expanded ? lines.length : DEFAULT_PREVIEW_LINES;
			renderedText = buildPreviewText(lines, maxLines, theme, options.expanded);
		}
	}

	const rendered = reuseTextComponent(renderedText, cachedComponent);
	if (stateCarrier) stateCarrier[BASH_RESULT_STATE_KEY] = rendered;
	return rendered;
}
