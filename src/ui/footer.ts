/**
 * Footer status segment (§4.1, §7.8).
 *
 * Composition note: the exported `FooterComponent` constructor requires an
 * `AgentSession` (`new FooterComponent(session, footerData)`), but the public
 * `setFooter` factory only receives `(tui, theme, footerData)` — no session.
 * Composing with the built-in footer is therefore not feasible from the
 * extension API, so this falls back to rendering only our segment on a single
 * line (pi renders it in place of the built-in footer). Deviations are noted
 * in the implementation report.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskManagerApi } from "../types.ts";
import { footerSegment } from "./format.ts";

export const FOOTER_STATUS_KEY = "bg-tasks-footer";

function runningCount(registry: TaskManagerApi): number {
	return registry.list().filter((task) => task.status === "running").length;
}

export function installFooter(
	ctx: ExtensionContext,
	registry: TaskManagerApi,
): { dispose(): void; refresh(): void } {
	let ticker: ReturnType<typeof setInterval> | undefined;
	let widget: (Component & { dispose?(): void }) | undefined;
	let requestRender: (() => void) | undefined;
	let lastText = "";

	const stopTicker = (): void => {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	const refresh = (): void => {
		const segment = footerSegment(runningCount(registry));
		if (segment !== lastText) {
			lastText = segment;
			widget?.invalidate?.();
		}
		if (runningCount(registry) > 0) ensureTicker();
		else stopTicker();
		requestRender?.();
	};

	const ensureTicker = (): void => {
		if (ticker !== undefined) return;
		ticker = setInterval(refresh, 1000);
		(ticker as { unref?: () => void }).unref?.();
	};

	ctx.ui.setFooter((tui: TUI, theme: Theme): Component & { dispose?(): void } => {
		requestRender = () => tui.requestRender();
		const component: Component & { dispose?(): void } = {
			invalidate() {
				requestRender?.();
			},
			render(width: number): string[] {
				const segment = footerSegment(runningCount(registry));
				lastText = segment;
				if (!segment) return [""];
				const style = theme.fg("muted", segment);
				const pad = Math.max(0, width - segment.length);
				return [truncateToWidth(" ".repeat(pad) + style, width)];
			},
			dispose() {
				stopTicker();
			},
		};
		widget = component;
		return component;
	});

	if (runningCount(registry) > 0) ensureTicker();

	const dispose = (): void => {
		stopTicker();
		widget?.dispose?.();
		widget = undefined;
		requestRender = undefined;
		ctx.ui.setFooter(undefined);
	};

	return { dispose, refresh };
}
