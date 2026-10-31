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

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { BgNotificationDetails, BgTask, BgTaskStatus } from "../types.ts";
import {
	notificationCollapsedLine,
	notificationExpandedLines,
	statusColorToken,
	stillRunningLine,
} from "./format.ts";

/** Colorize the leading bullet of a rendered line; rest stays default. */
function withBullet(line: string, colorToken: string, theme: Theme): string {
	const bullet = line.slice(0, 1);
	const rest = line.slice(1);
	return theme.fg(colorToken as ThemeColor, bullet) + rest;
}

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

/** Collapse a details payload (or XML fallback) into the styled line. */
export function noticeLineFromDetails(
	details: BgNotificationDetails | undefined,
	content: string,
	theme: Theme,
	width: number,
	expanded: boolean,
): string[] {
	if (details && details.task) {
		if (details.kind === "still-running") {
			return [withBullet(stillRunningLine(details, width), "dim", theme)];
		}
		if (expanded) {
			return notificationExpandedLines(details, [], width).map((line, index) =>
				withBullet(index === 0 ? line : ` ${line}`, index === 0 ? statusColorToken(details.task.status) : "dim", theme),
			);
		}
		return [withBullet(notificationCollapsedLine(details, width), statusColorToken(details.task.status), theme)];
	}

	// XML fallback — details were lost in transport; parse what we shipped.
	const parsed = parseNotificationXml(content);
	if (!parsed) return [];
	if (parsed.status === "killed") {
		return [withBullet(`● ${parsed.taskId} killed · ${parsed.taskName}${parsed.signal ? ` (${parsed.signal})` : ""}`, "dim", theme)];
	}
	const token = parsed.status === "failed" ? "error" : "success";
	return [
		withBullet(
			`● ${parsed.taskId} ${parsed.status} · ${parsed.taskName}${parsed.exitCode !== undefined ? ` · exit ${parsed.exitCode}` : ""}`,
			token as ThemeColor,
			theme,
		),
	];
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
