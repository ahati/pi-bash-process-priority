/**
 * Single-scroll document builder for the expanded dock.
 *
 * The whole expanded body is one document — task list, selected-task details,
 * and the output tail — rendered with no internal boundaries. The dock shows
 * a window over these rows; scrolling moves the window, so the two former
 * panes are read as one continuous page (Approach B).
 *
 * Pure: no TUI state, no async — the caller supplies the cached tail lines.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

import type { BgTask } from "../types.ts";
import { formatCleanTaskRow, RULE_CHAR, taskMetadataLines } from "./format.ts";

export interface DockDocumentTheme {
	fg: (color: any, text: string) => string;
	bold?: (text: string) => string;
}

export interface DockDocumentOptions {
	tasks: BgTask[];
	selectedIndex: number;
	width: number;
	nowMs?: number;
	theme?: DockDocumentTheme;
	borderColorFn?: (text: string) => string;
	/** Cached tail lines for the selected task (oldest → newest). */
	outputLines: string[];
}

export interface DockDocument {
	lines: string[];
	/** Document rows occupied by the task list (always starts at 0). */
	listCount: number;
	/** Row of the "Task Details" section title. */
	detailsStart: number;
	/** Row of the first output line (after the "Output" title). */
	outputStart: number;
}

/** Build the single scrollable document for the expanded dock. */
export function buildDockDocument(options: DockDocumentOptions): DockDocument {
	const { tasks, selectedIndex, width, nowMs, theme, borderColorFn, outputLines } = options;
	const lines: string[] = [];

	// 1. Master list — one document row per task, in registry order.
	for (let index = 0; index < tasks.length; index++) {
		lines.push(formatCleanTaskRow(tasks[index], index === selectedIndex, width, nowMs, theme));
	}
	const listCount = lines.length;

	// 2. Selected task details.
	lines.push("");
	const detailsStart = lines.length;
	lines.push(theme?.bold ? theme.bold("Task Details") : "Task Details");
	const selected = tasks[selectedIndex];
	const meta = selected ? taskMetadataLines(selected, width, nowMs, { theme, showMetadata: false }) : [];
	lines.push(...meta);

	// 3. Output tail, read as the last part of the same page.
	lines.push("");
	const dimFn = borderColorFn ?? ((text: string) => (theme ? theme.fg("dim", text) : text));
	lines.push(dimFn(RULE_CHAR.repeat(Math.max(1, width))));
	lines.push("Output");
	const outputStart = lines.length;
	for (const line of outputLines) {
		lines.push(truncateToWidth(line, width));
	}

	return { lines, listCount, detailsStart, outputStart };
}
