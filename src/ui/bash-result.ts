/**
 * Full Bash tool result renderer ported from pi-ui-enhancement.
 * Handles live preview streaming, background task results, error formatting,
 * quiet command hints, and bounded line truncation.
 */

import { Text } from "@earendil-works/pi-tui";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.ts";

export interface BashRenderTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

export function safeBashResultTheme(theme: BashRenderTheme): { fg: (color: string, text: string) => string; bold: (text: string) => string } {
	return {
		fg: (color: string, text: string) => (typeof theme?.fg === "function" ? theme.fg(color, text) : text),
		bold: (text: string) => (typeof theme?.bold === "function" ? theme.bold(text) : text),
	};
}

export interface BashResultRenderOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface BashToolDetails {
	exitCode?: number | null;
	signal?: string | null;
	fullOutputPath?: string;
	truncation?: {
		truncated?: boolean;
		outputBytes?: number;
		totalBytes?: number;
	};
	[key: string]: unknown;
}

export interface ToolRenderContextLike {
	args?: Record<string, unknown>;
	cwd?: string;
	isError?: boolean;
	lastComponent?: unknown;
	state?: unknown;
}

const BASH_RESULT_STATE_KEY = "__piToolDisplayBashResult";
const DEFAULT_COLLAPSED_LINES = 5;
const DEFAULT_PREVIEW_LINES = 8;
const DEFAULT_EXPANDED_MAX_LINES = 500;

const QUIET_COMMAND_PREFIXES = [
	"cd",
	"mkdir",
	"rmdir",
	"rm",
	"mv",
	"cp",
	"touch",
	"chmod",
	"chown",
	"git add",
	"git checkout",
	"git switch",
	"git restore",
	"git reset",
	"git clean",
	"npm install",
	"pnpm install",
	"yarn install",
	"bun install",
	"pip install",
	"poetry install",
	"cargo fetch",
	"go mod tidy",
	"Set-Location",
	"New-Item",
];

function isLikelyQuietCommand(command: string | undefined): boolean {
	if (!command) return false;
	const normalized = command.trim().toLowerCase();
	if (!normalized) return false;

	const primarySegment = normalized
		.split(/&&|\|\||;/)
		.map((s) => s.trim())
		.find((s) => s.length > 0);

	if (!primarySegment) return false;

	for (const prefix of QUIET_COMMAND_PREFIXES) {
		const normPrefix = prefix.toLowerCase();
		if (primarySegment === normPrefix || primarySegment.startsWith(`${normPrefix} `)) {
			return true;
		}
	}
	return false;
}

export function extractTextOutput(result: Record<string, unknown>): string {
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

function formatBashTruncationHints(details: BashToolDetails | undefined, theme: BashRenderTheme): string {
	if (!details) return "";
	const hints: string[] = [];
	if (details.truncation?.truncated) {
		hints.push("output truncated");
	}
	if (details.fullOutputPath) {
		hints.push(`full output: ${details.fullOutputPath}`);
	}
	if (hints.length === 0) return "";
	return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function reuseTextComponent(text: string, cached?: Text): Text {
	if (cached) {
		cached.setText(text);
		return cached;
	}
	return new Text(text, 0, 0);
}

export function isBackgroundTaskResult(
	result: Record<string, unknown>,
	context?: ToolRenderContextLike,
): boolean {
	const args = context?.args;
	if (args?.background === true) return true;
	if (
		typeof args?.taskAction === "string" &&
		args.taskAction.trim() !== "" &&
		args.taskAction !== "null" &&
		args.taskAction !== "undefined"
	) {
		return true;
	}
	const details = result.details as Record<string, unknown> | undefined;
	if (
		details &&
		typeof details.id === "string" &&
		details.id.startsWith("task-") &&
		typeof details.status === "string"
	) {
		return true;
	}
	return false;
}

export function isToolError(result: Record<string, unknown>, context?: ToolRenderContextLike): boolean {
	if (result.isError === true || context?.isError === true) return true;
	const details = result.details as BashToolDetails | undefined;
	if (details?.exitCode !== null && details?.exitCode !== undefined && details.exitCode !== 0) {
		return true;
	}
	return false;
}

export function renderBashResult(
	result: Record<string, unknown>,
	options: BashResultRenderOptions,
	rawTheme: BashRenderTheme,
	context?: ToolRenderContextLike,
): Text {
	const theme = safeBashResultTheme(rawTheme);
	const details = result.details as BashToolDetails | undefined;
	const rawOutput = extractTextOutput(result);

	const stateCarrier = context?.state as Record<string, unknown> | undefined;
	const cachedComponent = stateCarrier?.[BASH_RESULT_STATE_KEY] as Text | undefined;
	let rendered: Text;

	if (options.isPartial) {
		const lines = prepareOutputLines(rawOutput, options.expanded);
		if (lines.length === 0) {
			rendered = reuseTextComponent("", cachedComponent);
		} else {
			const maxLines = options.expanded ? DEFAULT_EXPANDED_MAX_LINES : DEFAULT_PREVIEW_LINES;
			let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
			preview += formatBashTruncationHints(details, theme);
			rendered = reuseTextComponent(preview, cachedComponent);
		}
	} else if (isToolError(result, context)) {
		const lines = prepareOutputLines(rawOutput, options.expanded);
		let text = theme.fg("error", "↳ command failed");
		if (lines.length > 0) {
			const maxLines = options.expanded ? lines.length : DEFAULT_PREVIEW_LINES;
			const { shown, remaining } = previewLines(lines, maxLines);
			text += `\n${shown.map((l) => theme.fg("error", sanitizeAnsiForThemedOutput(l))).join("\n")}`;
			text += formatTruncationHint(remaining, options.expanded, theme);
		}
		text += formatBashTruncationHints(details, theme);
		rendered = reuseTextComponent(text, cachedComponent);
	} else if (isBackgroundTaskResult(result, context)) {
		const lines = prepareOutputLines(rawOutput, options.expanded);
		const text = lines.length === 0
			? theme.fg("muted", "↳ (no output)")
			: lines.map((l) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(l))).join("\n");
		rendered = reuseTextComponent(text, cachedComponent);
	} else {
		const lines = prepareOutputLines(rawOutput, options.expanded);
		if (lines.length === 0) {
			const command = typeof context?.args?.command === "string" ? context.args.command : undefined;
			let text = isLikelyQuietCommand(command)
				? theme.fg("muted", "↳ command completed (no output)")
				: theme.fg("muted", "↳ (no output)");
			text += formatBashTruncationHints(details, theme);
			rendered = reuseTextComponent(text, cachedComponent);
		} else {
			const maxLines = options.expanded ? lines.length : DEFAULT_COLLAPSED_LINES;
			let text = buildPreviewText(lines, maxLines, theme, options.expanded);
			text += formatBashTruncationHints(details, theme);
			rendered = reuseTextComponent(text, cachedComponent);
		}
	}

	if (stateCarrier) {
		stateCarrier[BASH_RESULT_STATE_KEY] = rendered;
	}
	return rendered;
}
