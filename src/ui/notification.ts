/**
 * Transcript renderer for `bg-task-notification` custom messages (PRD-003
 * §7.10). Registered via pi.registerMessageRenderer; renders from the
 * structured `details` payload only — `content` (the model-facing XML) is
 * never parsed here. Returning undefined falls back to pi's default raw
 * rendering, which is the graceful-degradation path for missing details.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { BgNotificationDetails } from "../types.ts";
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

export function notificationComponent(
	details: BgNotificationDetails,
	options: { expanded: boolean },
	theme: Theme,
): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	const build = (width: number): string[] => {
		if (details.kind === "still-running") {
			return [withBullet(stillRunningLine(details, width), "dim", theme)];
		}
		if (options.expanded) {
			// Output tail is not retained in details (transcript entries are
			// immutable); the expanded view points at the log instead.
			const lines = notificationExpandedLines(details, [], width);
			return lines.map((line, index) =>
				withBullet(index === 0 ? line : " " + line, index === 0 ? statusColorToken(details.task.status) : "dim", theme),
			);
		}
		return [withBullet(notificationCollapsedLine(details, width), statusColorToken(details.task.status), theme)];
	};

	return {
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
		render(width: number): string[] {
			if (cachedLines === undefined || cachedWidth !== width) {
				cachedWidth = width;
				cachedLines = build(width);
			}
			return cachedLines;
		},
	};
}

/** The MessageRenderer for "bg-task-notification" custom messages. */
export function renderBgNotification(
	message: { details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const details = message.details as BgNotificationDetails | undefined;
	if (!details || typeof details !== "object" || !details.task) return undefined;
	return notificationComponent(details, options, theme);
}
