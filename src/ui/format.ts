/**
 * Pure formatting helpers for the background-task UI.
 *
 * No side effects, no TUI state: every function is a pure string transform.
 * Colors are applied through theme tokens (e.g. mdLink for LHS labels,
 * success/error for status indicators).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BgNotificationDetails, BgTask, BgTaskStatus } from "../types.ts";

export const BULLET = "●";
export const STILL_RUNNING_BULLET = "○";
export const RULE_CHAR = "─";
export const SEGMENT_SEPARATOR = " · ";

/**
 * Draggable height grip on the dock's top rule (U+25AC BLACK RECTANGLE).
 * A run of blocks reads as a physical grab bar, unlike the light rule char.
 */
export const GRIP_CHAR = "▬";
export const HEIGHT_GRIP_BLOCKS = 10;
export const HEIGHT_GRIP_MIN_BLOCKS = 3;

// ---------------------------------------------------------------------------
// Time & durations
// ---------------------------------------------------------------------------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local wall clock "HH:MM:SS" for dock rows and timestamps. */
export function formatClock(epochMs: number): string {
	const d = new Date(epochMs);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local timestamp "YYYY-MM-DD HH:MM:SS" for Task Details. */
export function formatTimestamp(epochMs: number): string {
	const d = new Date(epochMs);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(epochMs)}`;
}

/**
 * Compact duration: "45s", "2m 01s", "1h 04m", "1d 2h".
 * Seconds are floored; negative input clamps to zero.
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
	if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
	return `${seconds}s`;
}

/** Human-readable byte size formatted as B, KB, or MB. */
export function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Runtime duration of a task. */
export function taskAge(task: BgTask, nowMs = Date.now()): string {
	return formatDuration((task.endedAt ?? nowMs) - task.startedAt);
}

/** Dynamic output status line below the tail viewer. */
export function formatOutputStatusLine(options: {
	follow: boolean;
	totalLines: number;
	scrollTop: number;
	visibleLines: number;
	bytesRead: number;
	totalBytes: number;
	truncated: boolean;
}): string {
	const { follow, totalLines, scrollTop, visibleLines, bytesRead, totalBytes, truncated } = options;
	if (!follow && totalLines > 0) {
		const maxTop = Math.max(0, totalLines - visibleLines);
		const start = Math.min(scrollTop, maxTop);
		const end = Math.min(totalLines, start + visibleLines);
		// Scrolled-mode hints stay terse: the widget appends the global key
		// suffix (↑/↓ select · +/- resize · PgUp/PgDn scroll · k kill · esc
		// close), so a long base truncates on narrow terminals (e2e finding).
		return `lines ${start + 1}–${end} of ${totalLines} · ↓ end follows`;
	}
	const suffix = truncated ? ` of ${formatSize(totalBytes)}` : "";
	return `following tail ${formatSize(bytesRead)}${suffix} · ↑ scroll`;
}

// ---------------------------------------------------------------------------
// Status vocabulary & icons
// ---------------------------------------------------------------------------

/**
 * Status prefix icon:
 * - running: green dot ●
 * - completed (exit 0): green tick ✓
 * - failed/killed: red cross ✗
 */
export function taskStatusIcon(
	task: BgTask,
	theme?: { fg: (color: any, text: string) => string },
): string {
	if (task.status === "running") {
		const icon = "●";
		return theme ? theme.fg("success", icon) : icon;
	}
	if (task.status === "completed" && (task.exitCode === null || task.exitCode === undefined || task.exitCode === 0)) {
		const icon = "✓";
		return theme ? theme.fg("success", icon) : icon;
	}
	const icon = "✗";
	return theme ? theme.fg("error", icon) : icon;
}

export function statusWord(status: BgTaskStatus): string {
	return status;
}

export function statusColorToken(status: BgTaskStatus): "accent" | "success" | "error" | "dim" {
	switch (status) {
		case "running":
			return "accent";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "killed":
			return "dim";
	}
}

export function terminalStatusLabel(task: BgTask): string {
	if (task.signal) return task.signal;
	if (task.exitCode !== null && task.exitCode !== undefined) return `exit ${task.exitCode}`;
	return "";
}

export function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function terminalSuffix(task: BgTask): string {
	if (task.status === "failed") {
		const label = terminalStatusLabel(task);
		return label ? ` (${label})` : "";
	}
	if (task.status === "killed") {
		const label = task.reason ?? terminalStatusLabel(task);
		return label ? ` (${label})` : "";
	}
	return "";
}

// ---------------------------------------------------------------------------
// Dock & List Rows
// ---------------------------------------------------------------------------

/** Compact dock row for running tasks in collapsed dock mode. */
export function dockRow(
	task: BgTask,
	selected: boolean,
	width: number,
	nowMs?: number,
	theme?: { fg: (color: any, text: string) => string },
): string {
	const lead = selected ? "> " : "  ";
	const icon = taskStatusIcon(task, theme);
	const prefix = `${lead}${icon} [${formatClock(task.startedAt)}] `;
	const commandWidth = Math.max(1, width - 24);
	const command = truncateToWidth(singleLine(task.command), commandWidth);
	const elapsed =
		task.status === "running" && nowMs !== undefined
			? ` · ${formatDuration(Math.max(0, nowMs - task.startedAt))}`
			: "";
	const isErr =
		task.status === "failed" ||
		task.status === "killed" ||
		(task.exitCode !== null && task.exitCode !== undefined && task.exitCode !== 0);
	const statusColor = isErr ? "error" : "success";
	const rawStatus = `${statusWord(task.status)}${terminalSuffix(task)}`;
	const statusPart = theme ? theme.fg(statusColor, rawStatus) : rawStatus;
	const line = `${prefix}${command} ${statusPart}${elapsed}`;
	return truncateToWidth(line, width);
}

export function dockFrame(lines: string[], width: number): string[] {
	const rule = RULE_CHAR.repeat(Math.max(0, width));
	return [rule, ...lines, rule];
}

export function footerSegment(runningCount: number): string {
	if (runningCount <= 0) return "";
	return `${runningCount} task(s)${SEGMENT_SEPARATOR}/tasks`;
}

/**
 * Draw the draggable height grip (a block bar, U+25AC) on the rule. The bar
 * shrinks with the terminal width and disappears when even the minimum run
 * cannot fit; the whole top rule remains the mouse drag target.
 */
export interface HeaderLineOptions {
	grip?: boolean;
}

/** Candidate grip segments, widest first: a space, then a run of blocks. */
const HEIGHT_GRIP_CHOICES: readonly string[] = Array.from(
	{ length: HEIGHT_GRIP_BLOCKS - HEIGHT_GRIP_MIN_BLOCKS + 1 },
	(_, index) => ` ${GRIP_CHAR.repeat(HEIGHT_GRIP_BLOCKS - index)}`,
);

/** Full-width header line: "── Background Tasks ──────────────────────────" */
export function formatHeaderLine(
	title: string,
	width: number,
	theme?: { fg: (color: any, text: string) => string },
	hint?: string,
	borderColorFn?: (text: string) => string,
	options?: HeaderLineOptions,
): string {
	const prefix = "── ";
	const suffix = " ";
	const dimFn = borderColorFn ?? ((t: string) => (theme ? theme.fg("dim", t) : t));
	const titleStr = theme ? theme.fg("toolTitle", title) : title;
	const hintText = hint && width > 40 ? ` ${hint} ` : "";
	const baseWidth = visibleWidth(prefix) + visibleWidth(title) + visibleWidth(suffix);

	// Prefer the widest grip; only drop the hint when the grip cannot fit with
	// it, and shrink the grip before giving it up entirely.
	const gripChoices = options?.grip ? [...HEIGHT_GRIP_CHOICES, ""] : [""];
	const hintChoices = hintText ? [hintText, ""] : [""];
	for (const grip of gripChoices) {
		for (const hintChoice of hintChoices) {
			const fixed = baseWidth + visibleWidth(grip) + visibleWidth(hintChoice);
			if (fixed + 1 > width) continue;
			const fill = RULE_CHAR.repeat(width - fixed);
			const gripStr = grip ? (theme ? theme.fg("mdLink", grip) : grip) : "";
			const hintStr = hintChoice ? (theme ? theme.fg("dim", hintChoice) : hintChoice) : "";
			return truncateToWidth(
				`${dimFn(prefix)}${titleStr}${gripStr}${dimFn(suffix + fill)}${hintStr}`,
				width,
			);
		}
	}

	// Absurdly narrow terminal: render the title alone and let the caller clip.
	return truncateToWidth(`${dimFn(prefix)}${titleStr}`, width);
}

/**
 * Clean task row for the master task list:
 *   "  ✓ test-slow                                                               8s task-1"
 *   "> ✓ test-heartbeat                                                         12s task-2"
 */
export function formatCleanTaskRow(
	task: BgTask,
	selected: boolean,
	width: number,
	nowMs?: number,
	theme?: { fg: (color: any, text: string) => string },
): string {
	const lead = selected ? "> " : "  ";
	const icon = taskStatusIcon(task, theme);
	const name = task.name || singleLine(task.command);
	const age =
		task.status === "running"
			? formatDuration(Math.max(0, (nowMs ?? Date.now()) - task.startedAt))
			: formatDuration(Math.max(0, (task.endedAt ?? task.startedAt) - task.startedAt));
	const rightText = `${age} ${task.id}`;
	const rightWidth = visibleWidth(rightText);

	const leftPrefix = `${lead}${icon} `;
	const leftPrefixWidth = visibleWidth(leftPrefix);
	const maxNameWidth = Math.max(10, width - leftPrefixWidth - rightWidth - 4);
	const truncatedName = truncateToWidth(name, maxNameWidth);
	const currentLeftWidth = leftPrefixWidth + visibleWidth(truncatedName);
	const padding = Math.max(2, width - currentLeftWidth - rightWidth);
	const styledRight = theme ? theme.fg("dim", rightText) : rightText;

	return truncateToWidth(`${leftPrefix}${truncatedName}${" ".repeat(padding)}${styledRight}`, width);
}

/**
 * Resize handle row between the master list and the details pane
 * (PRD-007 Approach A): `⇕ (drag or +/- to resize) ──────────…`
 * Always exactly one row; the whole row is the drag/click target.
 */
export function formatResizeHandle(
	width: number,
	theme?: { fg: (color: any, text: string) => string },
): string {
	const label = "⇕ (drag or +/- to resize) ";
	const dimFn = theme ? (t: string) => theme.fg("dim", t) : (t: string) => t;
	const ruleLen = Math.max(0, width - visibleWidth(label));
	return truncateToWidth(dimFn(label + RULE_CHAR.repeat(ruleLen)), width);
}

/**
 * Format standalone Cwd and Log lines:
 *   "Cwd: /home/hati/workspace"
 *   "Log: /home/hati/workspace/.pi/bg-tasks/task-2.log"
 */
export function formatCwdAndLog(
	task: BgTask,
	theme?: { fg: (color: any, text: string) => string },
): string[] {
	const cwdLabel = theme ? theme.fg("mdLink", "Cwd:") : "Cwd:";
	const logLabel = theme ? theme.fg("mdLink", "Log:") : "Log:";
	const cwd = task.cwd ?? "";
	const cwdPath = theme ? theme.fg("dim", cwd) : cwd;
	const logPath = theme ? theme.fg("dim", task.logPath) : task.logPath;
	return [`${cwdLabel} ${cwdPath}`, `${logLabel} ${logPath}`];
}

// ---------------------------------------------------------------------------
// Task Details Group (Command, Status, Type, Started, Cwd, Log)
// ---------------------------------------------------------------------------

export interface DetailLinesOptions {
	showMetadata?: boolean;
	theme?: {
		fg: (color: any, text: string) => string;
		bold?: (text: string) => string;
	};
}

/**
 * Key hints shed first when the dock status row is wider than the terminal.
 * `esc close` is never in this list: it is the way out of dock mode.
 */
const DOCK_HINT_DROP_ORDER = ["↑/↓ select", "k kill", "[/] height", "+/- resize"];

/**
 * Compose the dock's trailing status/hint row. Optional key hints are dropped
 * (in priority order) on narrow terminals so the line always fits the width,
 * and the escape hint survives until the very end.
 */
export function formatDockStatusLine(
	statusText: string,
	hints: string[],
	width: number,
): string {
	const remaining = [...hints];
	const render = (): string => (remaining.length > 0 ? `${statusText} · ${remaining.join(" · ")}` : statusText);
	if (visibleWidth(render()) <= width) return render();

	for (const drop of DOCK_HINT_DROP_ORDER) {
		const index = remaining.indexOf(drop);
		if (index >= 0) remaining.splice(index, 1);
		if (visibleWidth(render()) <= width) return render();
	}

	while (remaining.length > 1 && visibleWidth(render()) > width) {
		const index = remaining.findIndex((hint) => hint !== "esc close");
		if (index < 0) break;
		remaining.splice(index, 1);
	}
	return truncateToWidth(render(), width);
}

/**
 * Format the metadata lines for a specific task.
 * Includes Command, Status, Type, Started, Cwd, Log with uniform blue LHS labels (theme mdLink).
 */
export function taskMetadataLines(
	task: BgTask,
	width: number,
	nowMs?: number,
	options?: DetailLinesOptions,
): string[] {
	const theme = options?.theme;
	const colorLhs = (label: string) => (theme ? theme.fg("mdLink", label) : label);

	const elapsed =
		task.status === "running" && nowMs !== undefined
			? ` · ${formatDuration(Math.max(0, nowMs - task.startedAt))}`
			: task.endedAt !== null
				? ` · ${formatDuration(Math.max(0, task.endedAt - task.startedAt))}`
				: "";

	const isErr =
		task.status === "failed" ||
		task.status === "killed" ||
		(task.exitCode !== null && task.exitCode !== undefined && task.exitCode !== 0);
	const statusColor = isErr ? "error" : "success";

	const icon = taskStatusIcon(task, theme);
	const statusWordText = statusWord(task.status);
	const statusSuffix = terminalSuffix(task);
	const statusRhsContent = `${statusWordText}${statusSuffix}${elapsed}`;
	const statusRhs = theme ? `${icon} ${theme.fg(statusColor, statusRhsContent)}` : `${icon} ${statusRhsContent}`;

	const cmdLabel = colorLhs("Command:");
	const statusLabel = colorLhs("Status:");
	const typeLabel = colorLhs("Type:");
	const startedLabel = colorLhs("Started:");
	const cwdLabel = colorLhs("Cwd:");
	const logLabel = colorLhs("Log:");

	const typeVal =
		task.callerType === "subagent"
			? `Subagent${task.subagentName ? ` (${task.subagentName})` : ""}`
			: "Agent";

	const lines = [
		`${cmdLabel} ${singleLine(task.command)}`,
		`${statusLabel}  ${statusRhs}`,
		`${typeLabel}    ${typeVal}`,
		`${startedLabel} ${formatTimestamp(task.startedAt)}`,
	];

	if (task.cwd !== undefined && task.cwd !== "") {
		const cwdVal = theme ? theme.fg("dim", task.cwd) : task.cwd;
		lines.push(`${cwdLabel}     ${cwdVal}`);
	}
	if (task.logPath) {
		const logVal = theme ? theme.fg("dim", task.logPath) : task.logPath;
		lines.push(`${logLabel}     ${logVal}`);
	}

	if (options?.showMetadata) {
		const pidLabel = colorLhs("PID:");
		const exitLabel = colorLhs("Exit:");
		const outputLabel = colorLhs("Output:");
		const sizeLabel = colorLhs("Size:");
		if (task.pid) lines.push(`${pidLabel}     ${task.pid}`);
		if (task.exitCode !== null && task.exitCode !== undefined) lines.push(`${exitLabel}    ${task.exitCode}`);
		if (task.logPath) lines.push(`${outputLabel}  ${task.logPath}`);
		if (task.bytesWritten) lines.push(`${sizeLabel}    ${formatSize(task.bytesWritten)}`);
	}

	return lines.map((line) => truncateToWidth(line, width));
}

/**
 * Task Details section header block + metadata + divider + Output header.
 */
export function detailLines(
	task: BgTask,
	width: number,
	nowMs?: number,
	options?: DetailLinesOptions,
): string[] {
	const theme = options?.theme;
	const title = theme?.bold ? theme.bold("Task Details") : "Task Details";
	const meta = taskMetadataLines(task, width, nowMs, options);
	const rule = RULE_CHAR.repeat(Math.max(0, width));

	return [title, "", ...meta, "", rule, "Output"].map((line) => truncateToWidth(line, width));
}

// ---------------------------------------------------------------------------
// Notification Renderers (Pi style)
// ---------------------------------------------------------------------------

function notificationCommand(task: BgTask): string {
	return singleLine(task.command);
}

export function notificationMeta(details: BgNotificationDetails): string {
	const { task } = details;
	const parts: string[] = [];

	if (task.status === "failed") {
		const label = terminalStatusLabel(task);
		if (label) parts.push(label);
	} else if (task.status === "killed") {
		const label = task.reason ?? terminalStatusLabel(task);
		if (label) parts.push(label);
	} else if (task.status === "completed") {
		const label = terminalStatusLabel(task);
		if (label) parts.push(label);
	}

	const duration =
		details.durationText ??
		(task.endedAt !== null ? formatDuration(task.endedAt - task.startedAt) : undefined);
	if (duration) parts.push(duration);

	return parts.join(" · ");
}

export function statusGlyph(status: BgTaskStatus): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	return "⏾";
}

export function notificationCollapsedLine(details: BgNotificationDetails, width: number): string {
	const { task } = details;
	const glyph = statusGlyph(task.status);
	const meta = notificationMeta(details);
	const metaText = meta ? ` (${meta})` : "";
	return truncateToWidth(`${glyph} ${task.id} ${statusWord(task.status)}${metaText}`, width);
}

export function notificationBranchLine(details: BgNotificationDetails, width: number): string {
	return truncateToWidth(`  ⎿ $ ${notificationCommand(details.task)}`, width);
}

export function notificationCollapsedLines(details: BgNotificationDetails, width: number): string[] {
	return [notificationCollapsedLine(details, width), notificationBranchLine(details, width)];
}

export function notificationExpandedLines(
	details: BgNotificationDetails,
	tailLines: string[],
	width: number,
): string[] {
	const { task } = details;
	const glyph = statusGlyph(task.status);
	const startedClock = details.startedClock ?? formatClock(task.startedAt);
	const endedClock = task.endedAt !== null ? formatClock(task.endedAt) : "now";
	const duration =
		details.durationText ??
		(task.endedAt !== null ? formatDuration(task.endedAt - task.startedAt) : formatDuration(0));
	const outcome =
		task.status === "failed"
			? terminalStatusLabel(task) || "failed"
			: task.status === "killed"
				? task.reason ?? terminalStatusLabel(task) ?? "killed"
				: terminalStatusLabel(task) || "completed";

	const lines = [
		`${glyph} Background task ${statusWord(task.status)} — ${task.id}`,
		`  Command:  $ ${notificationCommand(task)}`,
		`  Ran:      ${duration} · started ${startedClock} · ended ${endedClock}`,
		`  Outcome:  ${outcome}`,
		`  Origin:   ${task.origin}`,
	];
	if (task.callerType === "subagent") {
		lines.push(`  Caller:   Subagent${task.subagentName ? ` (${task.subagentName})` : ""}`);
	}
	lines.push(`  Output:   ${task.logPath}`);

	if (tailLines.length > 0) {
		lines.push(`  ${RULE_CHAR.repeat(Math.max(0, width - 2))}`);
		for (const line of tailLines) {
			lines.push(`  ${singleLine(line)}`);
		}
	}

	return lines.map((line) => truncateToWidth(line, width));
}

export function stillRunningLine(details: BgNotificationDetails, width: number): string {
	const { task } = details;
	const elapsed = details.elapsedSeconds ?? 0;
	return truncateToWidth(`⏾ ${task.id} still running after ${elapsed}s`, width);
}

export function stillRunningLines(details: BgNotificationDetails, width: number): string[] {
	return [stillRunningLine(details, width), notificationBranchLine(details, width)];
}
