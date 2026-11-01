/**
 * Full Bash tool call renderer ported from pi-ui-enhancement.
 * Includes animated spinner, elapsed timer, intent headers, background badges,
 * redundant cd stripping, and expanded cwd display.
 */

import { Text } from "@earendil-works/pi-tui";
import { extractProgramName } from "./bash-intent.ts";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_STATE_KEY = "__piToolDisplayBashSpinner";
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__piToolDisplayBashSpinnerToolCallId";

export interface BashCallArgs {
	command?: string;
	commandPrefix?: string;
	description?: string;
	/** Explicit intent text — overrides a leading `# intent:` comment. */
	intent?: string;
	/** Explicit header label — overrides a leading `# tool:` comment. */
	tool?: string;
	/** Background-task marker: renders a `⏾ background` badge in the header. */
	background?: boolean;
	/** Optional task label shown next to the background badge. */
	taskName?: string;
	/** Working directory — shown as a `cwd:` line in the expanded view. */
	cwd?: string;
	/** Management mode: renders a `bash tasks <action>` header instead of a command. */
	taskAction?: string;
	/** Task id for management calls. */
	taskId?: string;
	shellPath?: string;
	timeout?: number;
}

export interface BackgroundTaskCallArgs {
	command?: string;
	taskName?: string;
	timeout?: number;
	cwd?: string;
	intent?: string;
	tool?: string;
	commandPrefix?: string;
	description?: string;
}

export interface ManageBackgroundTaskCallArgs {
	action?: string;
	taskAction?: string;
	taskId?: string;
	input?: string;
	lines?: number;
}

export interface BashCallRenderOptions {
	intentMode?: "off" | "render" | "render-and-instruct";
	showCommand?: boolean;
	maxCommandChars?: number;
}

export interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

export function safeBashCallTheme(theme: BashCallRenderTheme): { fg: (color: string, text: string) => string; bold: (text: string) => string } {
	return {
		fg: (color: string, text: string) => (typeof theme?.fg === "function" ? theme.fg(color, text) : text),
		bold: (text: string) => (typeof theme?.bold === "function" ? theme.bold(text) : text),
	};
}

export interface BashSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

interface BashSpinnerStateCarrier {
	[BASH_SPINNER_STATE_KEY]?: BashSpinnerState;
	[BASH_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

export interface BashCallRenderContextLike {
	cwd?: string;
	executionStarted?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: unknown;
	toolCallId?: string;
}

const activeSpinnerTimers = new Set<ReturnType<typeof setInterval>>();
const spinnerStatesByToolCallId = new Map<string, BashSpinnerState>();
let nextSyntheticToolCallId = 0;

export function stopAllBashSpinners(): void {
	for (const timer of activeSpinnerTimers) {
		clearInterval(timer);
	}
	activeSpinnerTimers.clear();
	spinnerStatesByToolCallId.clear();
}

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
		activeSpinnerTimers.delete(state.timer);
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

function isDefaultShellPath(shellPath: string): boolean {
	const normalized = shellPath.trim().replace(/\\/g, "/").toLowerCase();
	const basename = normalized.split("/").pop() || normalized;
	return basename === "bash" || basename === "cmd.exe";
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
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "null" || trimmed === "undefined") return "";
	return value;
}

const INTENT_COMMENT_PATTERN = /^\s*#\s*intent\s*:\s*(.+?)\s*$/i;
const TOOL_COMMENT_PATTERN = /^\s*#\s*tool\s*:\s*(.+?)\s*$/i;

function parseLeadingComments(command: string): { intent?: string; tool?: string; stripped: string } {
	const lines = command.split("\n");
	const intentLines: string[] = [];
	let tool: string | undefined;
	let consumed = 0;

	for (const line of lines) {
		if (line.trim().length === 0 && consumed === 0) {
			consumed += 1;
			continue;
		}

		const toolMatch = TOOL_COMMENT_PATTERN.exec(line);
		if (toolMatch) {
			tool ??= toolMatch[1];
			consumed += 1;
			continue;
		}

		const intentMatch = INTENT_COMMENT_PATTERN.exec(line);
		if (!intentMatch) {
			break;
		}

		intentLines.push(intentMatch[1]);
		consumed += 1;
	}

	return {
		intent: intentLines.length > 0 ? intentLines.join(" ") : undefined,
		tool,
		stripped: lines.slice(consumed).join("\n").trim(),
	};
}

function resolveIntentDisplay(
	args: BashCallArgs,
	options: BashCallRenderOptions | undefined,
): { intent: string; tool?: string; strippedCommand?: string } | undefined {
	const alwaysIntent = cleanOptionalText(args.intent);
	const alwaysTool = cleanOptionalText(args.tool);
	if (!options || options.intentMode === undefined || options.intentMode === "off") {
		if (alwaysIntent.length > 0 || alwaysTool.length > 0) {
			return { intent: alwaysIntent, tool: alwaysTool.length > 0 ? alwaysTool : undefined };
		}
		return undefined;
	}

	const command = typeof args.command === "string" ? args.command : "";
	const parsed = parseLeadingComments(command);

	const explicitIntent = cleanOptionalText(args.intent) || cleanOptionalText(args.description);
	const explicitTool = cleanOptionalText(args.tool);
	const intent = explicitIntent.length > 0 ? explicitIntent : parsed.intent;
	const tool = explicitTool.length > 0 ? explicitTool : parsed.tool;

	if (intent === undefined && explicitTool === "") {
		return undefined;
	}

	return { intent: intent ?? "", tool, strippedCommand: parsed.stripped };
}

function buildCommandDisplay(args: BashCallArgs, maxCommandChars?: number): string {
	const command =
		typeof args.command === "string" && args.command.trim().length > 0
			? truncateCommand(args.command, maxCommandChars ?? 0)
			: "...";
	const prefix =
		typeof args.commandPrefix === "string" && args.commandPrefix.trim().length > 0
			? args.commandPrefix.trim()
			: "";
	return prefix ? `${prefix} ${command}` : command;
}

function toolIcon(): string {
	return "🔧";
}

function buildIntentHeader(
	args: BashCallArgs,
	rawTheme: BashCallRenderTheme,
	options: BashCallRenderOptions | undefined,
	expanded?: boolean,
): string | undefined {
	const theme = safeBashCallTheme(rawTheme);
	const intent = resolveIntentDisplay(args, options);
	if (!intent) return undefined;

	const stripped = (intent.strippedCommand ?? "").trim();
	const label = intent.tool ?? extractProgramName(stripped || args.command || "");
	const separator = ` ${theme.fg("muted", "·")} `;
	const intentTrimmed = (intent.intent ?? "").trim();
	const intentText = intentTrimmed.length > 0 ? theme.fg("accent", intentTrimmed) : "";

	const head =
		label.length > 0 && intentText.length > 0
			? `${toolIcon()} ${theme.fg("toolTitle", theme.bold(label))}${separator}${intentText}`
			: label.length > 0
				? `${toolIcon()} ${theme.fg("toolTitle", theme.bold(label))}`
				: intentText.length > 0
					? `${toolIcon()} ${intentText}`
					: toolIcon();

	if (expanded) {
		return stripped.length > 0 ? `${head}\n${theme.fg("muted", stripped)}` : head;
	}

	if (options?.showCommand && stripped.length > 0) {
		return `${head}${separator}${theme.fg("muted", stripped.replace(/\s+/g, " "))}`;
	}

	return head;
}

export function buildBashCallText(
	args: BashCallArgs,
	rawTheme: BashCallRenderTheme,
	options?: BashCallRenderOptions,
	expanded?: boolean,
	spinnerFrame?: string,
	elapsedMs?: number,
	displayCommand?: string,
): string {
	const theme = safeBashCallTheme(rawTheme);
	const KNOWN_TASK_ACTIONS = new Set(["list", "status", "kill", "input", "adopt"]);
	if (typeof args.taskAction === "string" && KNOWN_TASK_ACTIONS.has(args.taskAction.trim())) {
		const taskId = cleanOptionalText(args.taskId);
		const detail = theme.fg("accent", `${args.taskAction.trim()}${taskId ? ` ${taskId}` : ""}`);
		const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
		const elapsedSuffix =
			spinnerFrame && elapsedMs !== undefined
				? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
				: "";
		return `${spinnerPrefix}${toolIcon()} ${theme.fg("toolTitle", theme.bold("bash tasks"))} ${theme.fg("muted", "·")} ${detail}${elapsedSuffix}`;
	}

	const commandArgs = displayCommand !== undefined ? { ...args, command: displayCommand } : args;
	const commandDisplay = buildCommandDisplay(commandArgs, options?.maxCommandChars);
	const intentHeader = buildIntentHeader(commandArgs, theme, options, expanded);
	const shellSuffix =
		typeof args.shellPath === "string" &&
		args.shellPath.trim().length > 0 &&
		!isDefaultShellPath(args.shellPath)
			? theme.fg("muted", ` [shell: ${args.shellPath}]`)
			: "";
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	const taskNameDisplay = cleanOptionalText(args.taskName);
	const backgroundSuffix = args.background
		? theme.fg("muted", ` ⏾ background${taskNameDisplay ? ` · ${taskNameDisplay}` : ""}`)
		: "";
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";

	const prompt = intentHeader ?? `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", commandDisplay)}`;
	const [head, ...rest] = prompt.split("\n");
	const tail = rest.length > 0 ? `\n${rest.join("\n")}` : "";
	const cwdDisplay = cleanOptionalText(args.cwd);
	const cwdLine = expanded && cwdDisplay ? `\n${theme.fg("muted", `cwd: ${cwdDisplay.trim()}`)}` : "";
	return `${spinnerPrefix}${head}${shellSuffix}${timeoutSuffix}${backgroundSuffix}${elapsedSuffix}${tail}${cwdLine}`;
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
			activeSpinnerTimers.add(timer);
		}
	}

	const spinnerFrame = spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
	const elapsedMs = spinnerState?.startedAt !== undefined
		? Date.now() - spinnerState.startedAt
		: undefined;
	text.setText(renderText(spinnerFrame, elapsedMs));
	return text;
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	options?: BashCallRenderOptions,
): Text {
	const displayDirs = [context.cwd, cleanOptionalText(args.cwd)];
	const displayCommand = stripDisplayCd(typeof args.command === "string" ? args.command : "", displayDirs);
	return renderWithSpinner(context, (spinnerFrame, elapsedMs) =>
		buildBashCallText(args, theme, options, context.expanded === true, spinnerFrame, elapsedMs, displayCommand),
	);
}

export function buildBackgroundTaskCallText(
	args: BackgroundTaskCallArgs,
	rawTheme: BashCallRenderTheme,
	options?: BashCallRenderOptions,
	expanded?: boolean,
	spinnerFrame?: string,
	elapsedMs?: number,
	displayCommand?: string,
): string {
	const theme = safeBashCallTheme(rawTheme);
	const command = displayCommand ?? (typeof args.command === "string" ? args.command : "");
	const commandDisplay = truncateCommand(command.trim() || "...", options?.maxCommandChars ?? 0);
	const taskNameDisplay = cleanOptionalText(args.taskName);
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";
	const timeoutSuffix = args.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";

	const badge = `${theme.fg("toolTitle", theme.bold("⏾ background task"))}`;
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
	options?: BashCallRenderOptions,
): Text {
	const displayDirs = [context.cwd, cleanOptionalText(args.cwd)];
	const displayCommand = stripDisplayCd(typeof args.command === "string" ? args.command : "", displayDirs);
	return renderWithSpinner(context, (spinnerFrame, elapsedMs) =>
		buildBackgroundTaskCallText(args, theme, options, context.expanded === true, spinnerFrame, elapsedMs, displayCommand),
	);
}

export function buildManageBackgroundTaskCallText(
	args: ManageBackgroundTaskCallArgs,
	rawTheme: BashCallRenderTheme,
	_options?: BashCallRenderOptions,
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
	options?: BashCallRenderOptions,
): Text {
	return renderWithSpinner(context, (spinnerFrame, elapsedMs) =>
		buildManageBackgroundTaskCallText(args, theme, options, context.expanded === true, spinnerFrame, elapsedMs),
	);
}
