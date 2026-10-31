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

/**
 * One dock row: `"  ● [HH:MM:SS] cmd running"` or `"> ● …"` when selected.
 * The command is truncated to leave room for the status tail (width-24), then
 * the whole line passes through `truncateToWidth` (§7.8).
 */
export function dockRow(task: BgTask, selected: boolean, width: number, nowMs?: number): string {
	const lead = selected ? "> " : "  ";
	const prefix = `${lead}${BULLET} [${formatClock(task.startedAt)}] `;
	const commandWidth = Math.max(1, width - 24);
	const command = truncateToWidth(singleLine(task.command), commandWidth);
	// Live elapsed time for running tasks (PRD-004 §4.1): the 1 s dock ticker
	// supplies nowMs so the duration ticks up on screen.
	const elapsed =
		task.status === "running" && nowMs !== undefined ? ` · ${formatDuration(Math.max(0, nowMs - task.startedAt))}` : "";
	const line = `${prefix}${command} ${statusWord(task.status)}${terminalSuffix(task)}${elapsed}`;
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
// Notification renderer lines (Pi style)
// ---------------------------------------------------------------------------

function notificationCommand(task: BgTask): string {
	return singleLine(task.command);
}

/** Formats the outcome metadata badge: "exit 0 · 35s" or "SIGKILL · 12s". */
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

/** Status glyph: "✓" for completed, "✗" for failed, "⏾" for killed/running. */
export function statusGlyph(status: BgTaskStatus): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	return "⏾";
}

/** Collapsed Pi-style notification line 1: "✓ task-1 completed (exit 0 · 35s)". */
export function notificationCollapsedLine(details: BgNotificationDetails, width: number): string {
	const { task } = details;
	const glyph = statusGlyph(task.status);
	const meta = notificationMeta(details);
	const metaText = meta ? ` (${meta})` : "";
	return truncateToWidth(`${glyph} ${task.id} ${statusWord(task.status)}${metaText}`, width);
}

/** Collapsed Pi-style notification line 2: "  ⎿ $ sleep 35". */
export function notificationBranchLine(details: BgNotificationDetails, width: number): string {
	return truncateToWidth(`  ⎿ $ ${notificationCommand(details.task)}`, width);
}

/** Collapsed Pi-style notification: returns [headerLine, branchLine]. */
export function notificationCollapsedLines(details: BgNotificationDetails, width: number): string[] {
	return [
		notificationCollapsedLine(details, width),
		notificationBranchLine(details, width),
	];
}

/**
 * Expanded terminal notification block (Pi style): header, aligned metadata,
 * a rule, then the tail lines indented two spaces.
 */
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
		`  Origin:   ${humanizeOrigin(task.origin)}`,
		`  Output:   ${task.logPath}`,
	];

	if (tailLines.length > 0) {
		lines.push(`  ${RULE_CHAR.repeat(Math.max(0, width - 2))}`);
		for (const line of tailLines) {
			lines.push(`  ${singleLine(line)}`);
		}
	}

	return lines.map((line) => truncateToWidth(line, width));
}

/** Still-running notice line 1: "⏾ task-2 still running after 30s". */
export function stillRunningLine(details: BgNotificationDetails, width: number): string {
	const { task } = details;
	const elapsed = details.elapsedSeconds ?? 0;
	return truncateToWidth(`⏾ ${task.id} still running after ${elapsed}s`, width);
}

/** Still-running notice: returns [headerLine, branchLine]. */
export function stillRunningLines(details: BgNotificationDetails, width: number): string[] {
	return [
		stillRunningLine(details, width),
		notificationBranchLine(details, width),
	];
}
