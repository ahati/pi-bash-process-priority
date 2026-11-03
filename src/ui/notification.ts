/**
 * Transcript renderer for `bg-task-notification` custom messages (PRD-003
 * §7.10 / PRD-004 v3.1). Registered via pi.registerMessageRenderer; prefers
 * the structured `details` payload and falls back to parsing the XML
 * `content` when details were lost in transport (e.g. through the agent
 * followUp queue). Field-test finding: wakes were delivered as injected
 * turns but the styled notice never rendered (0/6) — this fallback makes
 * the rendered line deterministic. Only returns undefined when the message
 * is not ours to render at all.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { BgNotificationDetails, BgTask, BgTaskStatus } from "../types.ts";
import {
	formatClock,
	formatDuration,
	notificationMeta,
	RULE_CHAR,
	singleLine,
	statusGlyph,
	statusWord,
	terminalStatusLabel,
} from "./format.ts";

interface ParsedNotice {
	taskId: string;
	taskName: string;
	status: BgTaskStatus;
	exitCode?: number;
	signal?: string;
	reason?: string;
}

/** Minimal extractor for our own §7.6 XML — tolerant of missing fields. */
export function parseNotificationXml(content: string): ParsedNotice | undefined {
	if (!content.includes("background-task-notification")) return undefined;
	const tag = (name: string): string | undefined => {
		const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content);
		return m?.[1]?.trim();
	};
	const taskId = tag("task-id");
	if (!taskId) return undefined;
	const status = (tag("status") ?? "completed") as BgTaskStatus;
	const exitCodeRaw = tag("exit-code");
	return {
		taskId,
		taskName: tag("task-name") ?? taskId,
		status,
		exitCode: exitCodeRaw !== undefined && exitCodeRaw !== "" ? Number(exitCodeRaw) : undefined,
		signal: tag("signal"),
		reason: tag("reason"),
	};
}

/** Collapse a details payload (or XML fallback) into Pi-styled transcript lines. */
export function noticeLineFromDetails(
	details: BgNotificationDetails | undefined,
	content: string,
	theme: Theme,
	width: number,
	expanded: boolean,
): string[] {
	if (details && details.task) {
		const { task } = details;

		if (details.kind === "still-running") {
			const elapsed = details.elapsedSeconds ?? 0;
			const icon = theme.fg("warning", "⏾");
			const id = theme.bold(task.id);
			const status = theme.fg("warning", "still running");
			const meta = theme.fg("muted", `after ${elapsed}s`);
			const line1 = truncateToWidth(`${icon} ${id} ${status} ${meta}`, width);

			const branch = theme.fg("dim", "⎿ ");
			const prompt = theme.fg("toolTitle", theme.bold("$"));
			const cmd = theme.fg("accent", truncateToWidth(singleLine(task.command), width - 6));
			const line2 = truncateToWidth(`  ${branch}${prompt} ${cmd}`, width);
			return [line1, line2];
		}

		const isSuccess = task.status === "completed";
		const isError = task.status === "failed";
		const glyph = statusGlyph(task.status);
		const color = isSuccess ? "success" : isError ? "error" : "dim";

		if (expanded) {
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

			const icon = theme.fg(color as ThemeColor, glyph);
			const headerTitle = theme.fg("toolTitle", theme.bold("Background task"));
			const status = theme.fg(color as ThemeColor, statusWord(task.status));
			const id = theme.bold(task.id);

			const label = (text: string) => theme.fg("dim", text);
			const prompt = theme.fg("toolTitle", theme.bold("$"));
			const cmd = theme.fg("accent", singleLine(task.command));
			const muted = (text: string) => theme.fg("muted", text);
			const dim = (text: string) => theme.fg("dim", text);

			const lines = [
				`${icon} ${headerTitle} ${status} — ${id}`,
				`  ${label("Command: ")}${prompt} ${cmd}`,
				`  ${label("Ran:      ")}${muted(`${duration} · started ${startedClock} · ended ${endedClock}`)}`,
				`  ${label("Outcome:  ")}${muted(outcome)}`,
				`  ${label("Origin:   ")}${dim(task.origin)}`,
				`  ${label("Output:   ")}${dim(task.logPath)}`,
			];

			let tailLines: string[] = [];
			try {
				if (task.logPath && existsSync(task.logPath)) {
					const raw = readFileSync(task.logPath, "utf8");
					const all = raw.trimEnd().split("\n");
					tailLines = all.filter((l) => l.trim().length > 0).slice(-8);
				}
			} catch {
				// best effort
			}

			if (tailLines.length > 0) {
				const rule = theme.fg("dim", RULE_CHAR.repeat(Math.max(1, width - 2)));
				lines.push(`  ${rule}`);
				for (const line of tailLines) {
					lines.push(`  ${theme.fg("toolOutput", truncateToWidth(singleLine(line), width - 4))}`);
				}
			}

			return lines.map((line) => truncateToWidth(line, width));
		}

		// Collapsed view (PRD-004 Pi style)
		const icon = theme.fg(color as ThemeColor, glyph);
		const id = theme.bold(task.id);
		const status = theme.fg(color as ThemeColor, statusWord(task.status));
		const meta = notificationMeta(details);
		const metaText = meta ? ` ${theme.fg("muted", `(${meta})`)}` : "";

		const line1 = truncateToWidth(`${icon} ${id} ${status}${metaText}`, width);

		const branch = theme.fg("dim", "⎿ ");
		const prompt = theme.fg("toolTitle", theme.bold("$"));
		const cmd = theme.fg("accent", truncateToWidth(singleLine(task.command), width - 6));
		const line2 = truncateToWidth(`  ${branch}${prompt} ${cmd}`, width);

		return [line1, line2];
	}

	// XML fallback — details were lost in transport; parse what we shipped.
	const parsed = parseNotificationXml(content);
	if (!parsed) return [];
	const isSuccess = parsed.status === "completed";
	const isError = parsed.status === "failed";
	const glyph = statusGlyph(parsed.status);
	const color = isSuccess ? "success" : isError ? "error" : "dim";

	const icon = theme.fg(color as ThemeColor, glyph);
	const id = theme.bold(parsed.taskId);
	const status = theme.fg(color as ThemeColor, parsed.status);

	const metaParts: string[] = [];
	if (parsed.exitCode !== undefined) metaParts.push(`exit ${parsed.exitCode}`);
	if (parsed.signal) metaParts.push(parsed.signal);
	if (parsed.reason) metaParts.push(parsed.reason);
	const metaText = metaParts.length > 0 ? ` ${theme.fg("muted", `(${metaParts.join(" · ")})`)}` : "";

	const line1 = truncateToWidth(`${icon} ${id} ${status}${metaText}`, width);
	const branch = theme.fg("dim", "⎿ ");
	const prompt = theme.fg("toolTitle", theme.bold("$"));
	const cmd = theme.fg("accent", truncateToWidth(singleLine(parsed.taskName), width - 6));
	const line2 = truncateToWidth(`  ${branch}${prompt} ${cmd}`, width);
	return [line1, line2];
}

export function notificationComponent(
	details: BgNotificationDetails | undefined,
	content: string,
	options: { expanded: boolean },
	theme: Theme,
): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	return {
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
		render(width: number): string[] {
			if (cachedLines === undefined || cachedWidth !== width) {
				cachedWidth = width;
				cachedLines = noticeLineFromDetails(details, content, theme, width, options.expanded === true);
			}
			return cachedLines;
		},
	};
}

/** The MessageRenderer for "bg-task-notification" custom messages. */
export function renderBgNotification(
	message: { content?: unknown; details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const content = typeof message.content === "string" ? message.content : "";
	const details = (message.details ?? undefined) as BgNotificationDetails | undefined;
	if (!content.includes("background-task-notification") && (!details || typeof details !== "object" || !details.task)) {
		return undefined;
	}
	return notificationComponent(details, content, options, theme);
}
