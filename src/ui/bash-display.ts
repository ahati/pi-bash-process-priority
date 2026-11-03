/**
 * Background-task tool call renderer.
 *
 * Renders this extension's own `background_task` and `manage_background_task`
 * tools. The built-in `bash` tool is rendered by pi or pi-ui-enhancement; this
 * package no longer owns that renderer.
 */

import { Text } from "@earendil-works/pi-tui";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_STATE_KEY = "__piToolDisplayBashSpinner";
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__piToolDisplayBashSpinnerToolCallId";

export interface BackgroundTaskCallArgs {
	command?: string;
	taskName?: string;
	timeout?: number;
	cwd?: string;
}

export interface ManageBackgroundTaskCallArgs {
	action?: string;
	taskAction?: string;
	taskId?: string;
	input?: string;
	lines?: number;
}

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

function safeBashCallTheme(theme: BashCallRenderTheme): { fg: (color: string, text: string) => string; bold: (text: string) => string } {
	return {
		fg: (color: string, text: string) => (typeof theme?.fg === "function" ? theme.fg(color, text) : text),
		bold: (text: string) => (typeof theme?.bold === "function" ? theme.bold(text) : text),
	};
}

interface BashSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

interface BashSpinnerStateCarrier {
	[BASH_SPINNER_STATE_KEY]?: BashSpinnerState;
	[BASH_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

interface BashCallRenderContextLike {
	cwd?: string;
	executionStarted?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: unknown;
	toolCallId?: string;
}

const spinnerStatesByToolCallId = new Map<string, BashSpinnerState>();
let nextSyntheticToolCallId = 0;

function toStateCarrier(value: unknown): BashSpinnerStateCarrier | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as BashSpinnerStateCarrier;
}

function getSyntheticToolCallId(carrier: BashSpinnerStateCarrier | undefined): string | undefined {
	if (!carrier) return undefined;
	if (!carrier[BASH_SPINNER_TOOL_CALL_ID_KEY]) {
		carrier[BASH_SPINNER_TOOL_CALL_ID_KEY] = `state:${++nextSyntheticToolCallId}`;
	}
	return carrier[BASH_SPINNER_TOOL_CALL_ID_KEY];
}

function getToolCallId(context: BashCallRenderContextLike): string | undefined {
	if (typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0) {
		return context.toolCallId;
	}
	return getSyntheticToolCallId(toStateCarrier(context.state));
}

function getOrCreateSpinnerState(
	toolCallId: string | undefined,
	carrier: BashSpinnerStateCarrier | undefined,
): BashSpinnerState | undefined {
	if (!toolCallId) return undefined;
	let state = spinnerStatesByToolCallId.get(toolCallId);
	if (!state) {
		state = { frameIndex: 0 };
		spinnerStatesByToolCallId.set(toolCallId, state);
	}
	if (carrier) {
		carrier[BASH_SPINNER_STATE_KEY] = state;
	}
	return state;
}

function stopSpinner(toolCallId: string | undefined, state: BashSpinnerState | undefined): void {
	if (!state) return;
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	state.frameIndex = 0;
	state.startedAt = undefined;
	if (toolCallId) {
		spinnerStatesByToolCallId.delete(toolCallId);
	}
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${seconds}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function truncateCommand(command: string, maxChars: number): string {
	if (!Number.isFinite(maxChars) || maxChars <= 0) {
		return command;
	}
	const singleLine = command.replace(/\s*\r?\n\s*/g, " ; ");
	if (singleLine.length <= maxChars) {
		return singleLine;
	}
	const cutoff = Math.max(1, maxChars - 1);
	return `${singleLine.slice(0, cutoff)}…`;
}

/**
 * Drops a redundant leading `cd <dir> &&` for display when the command already
 * executes in that directory.
 */
function stripDisplayCd(command: string, dirs: (string | undefined)[]): string {
	const match = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))(\s*&\s*&\s*)/.exec(command);
	if (!match) return command;
	const raw = match[1] ?? match[2] ?? match[3] ?? "";
	if (raw.length === 0 || raw === "...") return command;
	const isDotOrPwd = raw === "." || raw === "$PWD" || raw === "\"$PWD\"" || raw === "'$PWD'";
	const normalized = raw.replace(/\/+$/, "");
	for (const dir of dirs) {
		if (!dir) continue;
		if (isDotOrPwd || dir.replace(/\/+$/, "") === normalized) {
			return command.slice(match.index + match[0].length).replace(/^\s*/, "") || command;
		}
	}
	return command;
}

function cleanOptionalText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	const lower = trimmed.toLowerCase();
	if (lower === "" || lower === "null" || lower === "undefined") return "";
	return value;
}

function renderWithSpinner(
	context: BashCallRenderContextLike,
	renderText: (spinnerFrame?: string, elapsedMs?: number) => string,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const carrier = toStateCarrier(context.state);
	const toolCallId = getToolCallId(context);
	const spinnerState = getOrCreateSpinnerState(toolCallId, carrier);
	const shouldSpin = (context.executionStarted ?? false) && (context.isPartial ?? false);

	if (!shouldSpin) {
		stopSpinner(toolCallId, spinnerState);
		text.setText(renderText(undefined, undefined));
		return text;
	}

	if (spinnerState) {
		spinnerState.startedAt ??= Date.now();
		if (!spinnerState.timer && typeof context.invalidate === "function") {
			const timer = setInterval(() => {
				spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
				text.setText(
					renderText(
						BASH_SPINNER_FRAMES[spinnerState.frameIndex],
						Date.now() - (spinnerState.startedAt ?? Date.now()),
					),
				);
				context.invalidate?.();
			}, BASH_SPINNER_INTERVAL_MS);
			spinnerState.timer = timer;
		}
	}

	const spinnerFrame = spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
	const elapsedMs = spinnerState?.startedAt !== undefined
		? Date.now() - spinnerState.startedAt
		: undefined;
	text.setText(renderText(spinnerFrame, elapsedMs));
	return text;
}

function buildBackgroundTaskCallText(
	args: BackgroundTaskCallArgs,
	rawTheme: BashCallRenderTheme,
	expanded?: boolean,
	spinnerFrame?: string,
	elapsedMs?: number,
	displayCommand?: string,
): string {
	const theme = safeBashCallTheme(rawTheme);
	const command = displayCommand ?? (typeof args.command === "string" ? args.command : "");
	const commandDisplay = command.trim() || "...";
	const taskNameDisplay = cleanOptionalText(args.taskName);
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";
	const timeoutSuffix = args.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";

	const badge = `${theme.fg("toolTitle", theme.bold("BackgroundTask"))}`;
	const dot = ` ${theme.fg("muted", "·")} `;

	let header: string;
	if (taskNameDisplay) {
		header = `${badge}${dot}${theme.fg("accent", taskNameDisplay)}${dot}${theme.fg("accent", `$ ${commandDisplay}`)}`;
	} else {
		header = `${badge}${dot}${theme.fg("accent", `$ ${commandDisplay}`)}`;
	}

	const cwdDisplay = cleanOptionalText(args.cwd);
	const cwdLine = expanded && cwdDisplay ? `\n${theme.fg("muted", `cwd: ${cwdDisplay.trim()}`)}` : "";
	return `${spinnerPrefix}${header}${timeoutSuffix}${elapsedSuffix}${cwdLine}`;
}

export function renderBackgroundTaskCall(
	args: BackgroundTaskCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
): Text {
	const displayDirs = [context.cwd, cleanOptionalText(args.cwd)];
	const displayCommand = stripDisplayCd(typeof args.command === "string" ? args.command : "", displayDirs);
	return renderWithSpinner(context, (spinnerFrame, elapsedMs) =>
		buildBackgroundTaskCallText(args, theme, context.expanded === true, spinnerFrame, elapsedMs, displayCommand),
	);
}

function buildManageBackgroundTaskCallText(
	args: ManageBackgroundTaskCallArgs,
	rawTheme: BashCallRenderTheme,
	expanded?: boolean,
	spinnerFrame?: string,
	elapsedMs?: number,
): string {
	const theme = safeBashCallTheme(rawTheme);
	const action = cleanOptionalText(args.action || args.taskAction) || "list";
	const taskId = cleanOptionalText(args.taskId);
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";
	const title = `🔧 ${theme.fg("toolTitle", theme.bold("task manager"))}`;
	const dot = ` ${theme.fg("muted", "·")} `;

	const detail = taskId ? `${action} ${taskId}` : action;
	let line = `${spinnerPrefix}${title}${dot}${theme.fg("accent", detail)}${elapsedSuffix}`;

	if (expanded) {
		if (args.input) {
			line += `\n${theme.fg("muted", `input: ${truncateCommand(args.input, 40)}`)}`;
		}
		if (args.lines) {
			line += `\n${theme.fg("muted", `lines: ${args.lines}`)}`;
		}
	}
	return line;
}

export function renderManageBackgroundTaskCall(
	args: ManageBackgroundTaskCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
): Text {
	return renderWithSpinner(context, (spinnerFrame, elapsedMs) =>
		buildManageBackgroundTaskCallText(args, theme, context.expanded === true, spinnerFrame, elapsedMs),
	);
}
