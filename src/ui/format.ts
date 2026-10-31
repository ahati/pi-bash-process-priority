/**
 * Pure formatting helpers for the background-task UI (PRD-003 §4, §7.8, §7.10).
 *
 * No side effects, no TUI state: every function is a pure string transform.
 * Colors are deliberately *not* embedded here — statuses are exposed through
 * `statusColorToken()` so components can apply `theme.fg(...)` themselves.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

import type { BgNotificationDetails, BgTask, BgTaskOrigin, BgTaskStatus } from "../types.ts";

export const BULLET = "●";
export const STILL_RUNNING_BULLET = "○";
export const RULE_CHAR = "─";
export const SEGMENT_SEPARATOR = " · ";

// ---------------------------------------------------------------------------
// Time & durations (§4.1, §4.2, §7.8)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local wall clock "HH:MM:SS" for the dock (§4.1). */
export function formatClock(epochMs: number): string {
	const d = new Date(epochMs);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local timestamp "YYYY-MM-DD HH:MM:SS" for Task Details (§4.2). */
export function formatTimestamp(epochMs: number): string {
	const d = new Date(epochMs);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(epochMs)}`;
}

/**
 * Compact duration: "45s", "2m 01s", "1h 04m", "1d 2h" (§7.8).
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

// ---------------------------------------------------------------------------
// Status vocabulary & colors
// ---------------------------------------------------------------------------

/** "running" | "completed" | "failed" | "killed" (§4.4). */
export function statusWord(status: BgTaskStatus): string {
	return status;
}

/** Theme color token the components should apply to the status dot/word. */
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

/**
 * Terminal outcome label used as a row/notification suffix:
 * "exit 0", "exit 1", "SIGKILL". Empty while running / unknown.
 */
export function terminalStatusLabel(task: BgTask): string {
	if (task.signal) return task.signal;
	if (task.exitCode !== null && task.exitCode !== undefined) return `exit ${task.exitCode}`;
	return "";
}

/** Human wording for the task origin (§7.10 expanded block). */
export function humanizeOrigin(origin: BgTaskOrigin): string {
	return origin === "foreground-adopted" ? "ctrl+b (foreground adopt)" : "bg_task";
}

// ---------------------------------------------------------------------------
// Dock (§4.1, §7.8)
// ---------------------------------------------------------------------------

/** Collapse a command to one display line (dock rows are single-line). */
function singleLine(text: string): string {
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

/**
 * One dock row: `"  ● [HH:MM:SS] cmd running"` or `"> ● …"` when selected.
 * The command is truncated to leave room for the status tail (width-24), then
 * the whole line passes through `truncateToWidth` (§7.8).
 */
export function dockRow(task: BgTask, selected: boolean, width: number): string {
	const lead = selected ? "> " : "  ";
	const prefix = `${lead}${BULLET} [${formatClock(task.startedAt)}] `;
	const commandWidth = Math.max(1, width - 24);
	const command = truncateToWidth(singleLine(task.command), commandWidth);
	const line = `${prefix}${command} ${statusWord(task.status)}${terminalSuffix(task)}`;
	return truncateToWidth(line, width);
}

/** Full-width "─" rules above and below the dock row block (§4.1). */
export function dockFrame(lines: string[], width: number): string[] {
	const rule = RULE_CHAR.repeat(Math.max(0, width));
	return [rule, ...lines, rule];
}

/** Footer segment: "N task(s) · /tasks", omitted (empty) when nothing runs. */
export function footerSegment(runningCount: number): string {
	if (runningCount <= 0) return "";
	return `${runningCount} task(s)${SEGMENT_SEPARATOR}/tasks`;
}

// ---------------------------------------------------------------------------
// Task Details (§4.2, §7.8)
// ---------------------------------------------------------------------------

/**
 * Task Details header block. The status line carries the bullet + word; the
 * component colors it with `statusColorToken`. `Type` is always "Agent" in v1.
 */
export function detailLines(task: BgTask, width: number): string[] {
	const status = `Status:  ${BULLET} ${statusWord(task.status)}`;
	const started = `Started: ${formatTimestamp(task.startedAt)}`;
	const rule = RULE_CHAR.repeat(Math.max(0, width));
	const lines = [
		"Task Details",
		"",
		`Command: ${singleLine(task.command)}`,
		status,
		"Type:    Agent",
		started,
		"",
		rule,
		"Output",
	];
	return lines.map((line) => truncateToWidth(line, width));
}

// ---------------------------------------------------------------------------
// Notification renderer lines (§7.10)
// ---------------------------------------------------------------------------

function notificationCommand(task: BgTask): string {
	return singleLine(task.command);
}

/** Collapsed terminal notification: "● task-2 completed · sleep 120 · exit 0 · 2m 01s". */
export function notificationCollapsedLine(details: BgNotificationDetails, width: number): string {
	const { task } = details;
	const segments: string[] = [notificationCommand(task)];

	if (task.status === "failed") {
		const label = terminalStatusLabel(task);
		if (label) segments.push(label);
	} else if (task.status === "killed") {
		const label = task.reason ?? terminalStatusLabel(task);
		if (label) segments.push(label);
	} else if (task.status === "completed") {
		const label = terminalStatusLabel(task);
		if (label) segments.push(label);
	}

	const duration =
		details.durationText ??
		(task.endedAt !== null ? formatDuration(task.endedAt - task.startedAt) : undefined);
	if (duration) segments.push(duration);

	return truncateToWidth(
		`${BULLET} ${task.id} ${statusWord(task.status)}${SEGMENT_SEPARATOR}${segments.join(SEGMENT_SEPARATOR)}`,
		width,
	);
}

/**
 * Expanded terminal notification block (§7.10): header, aligned metadata,
 * a rule, then the tail lines indented two spaces. Every line is truncated.
 */
export function notificationExpandedLines(
	details: BgNotificationDetails,
	tailLines: string[],
	width: number,
): string[] {
	const { task } = details;
	const startedClock = details.startedClock ?? formatClock(task.startedAt);
	const endedClock = task.endedAt !== null ? formatClock(task.endedAt) : "now";
	const duration =
		details.durationText ??
		(task.endedAt !== null ? formatDuration(task.endedAt - task.startedAt) : formatDuration(0));

	const lines = [
		`${BULLET} Background task ${statusWord(task.status)} — ${task.id}`,
		`  Command:  ${notificationCommand(task)}`,
		`  Ran:      ${duration} · started ${startedClock} · ended ${endedClock}`,
		`  Origin:   ${humanizeOrigin(task.origin)}`,
		`  Output:   ${task.logPath}`,
		`  ${RULE_CHAR.repeat(Math.max(0, width - 2))}`,
		...tailLines.map((line) => `  ${singleLine(line)}`),
	];
	return lines.map((line) => truncateToWidth(line, width));
}

/** Still-running notice: "○ task-2 still running after 30s · sleep 120". */
export function stillRunningLine(details: BgNotificationDetails, width: number): string {
	const { task } = details;
	const elapsed = details.elapsedSeconds ?? 0;
	const line = `${STILL_RUNNING_BULLET} ${task.id} still running after ${elapsed}s${SEGMENT_SEPARATOR}${notificationCommand(task)}`;
	return truncateToWidth(line, width);
}
