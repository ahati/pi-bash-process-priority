/**
 * Dock widget below the editor (§4.1, §7.7–§7.8).
 *
 * `installDock` owns the pi widget; `DockController` owns selection state and
 * is deliberately registry-agnostic (it takes a task-list provider) so the
 * state machine can be unit-tested with a fake list.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BgTask, TaskManagerApi } from "../types.ts";
import { dockRow, RULE_CHAR, statusColorToken } from "./format.ts";
import { debugLog } from "../debug.ts";

export const DOCK_WIDGET_KEY = "bg-tasks";

/** Color the status bullet per §7.8 (format.ts returns plain text). */
export function colorBullet(line: string, status: BgTask["status"], theme: Theme): string {
	const at = line.indexOf("\u25cf");
	if (at < 0) return line;
	return line.slice(0, at) + theme.fg(statusColorToken(status), "\u25cf") + line.slice(at + 1);
}
/** Only running tasks own a dock row in v1 (§4.1: "active" tasks). */
export function dockTasks(registry: TaskManagerApi): BgTask[] {
	return registry.list().filter((task) => task.status === "running");
}

export class DockController {
	private readonly getTasks: () => BgTask[];
	private index = 0;
	private active = false;

	constructor(getTasks: () => BgTask[]) {
		this.getTasks = getTasks;
	}

	/** Enter dock mode at the first row. False when there is nothing to show. */
	enterDock(): boolean {
		const rows = this.getTasks();
		if (rows.length === 0) {
			this.active = false;
			this.index = 0;
			return false;
		}
		this.active = true;
		this.index = 0;
		return true;
	}

	/** Move selection by `delta`, clamped to the current row count. */
	move(delta: number): void {
		const count = this.getTasks().length;
		if (count === 0) {
			this.exitDock();
			return;
		}
		if (!this.active) return;
		this.index = Math.max(0, Math.min(count - 1, this.index + delta));
	}

	/** Currently selected task; undefined when not in dock or rows vanished. */
	selected(): BgTask | undefined {
		if (!this.active) return undefined;
		const rows = this.getTasks();
		if (rows.length === 0) {
			this.exitDock();
			return undefined;
		}
		if (this.index > rows.length - 1) this.index = rows.length - 1;
		return rows[this.index];
	}

	exitDock(): void {
		this.active = false;
		this.index = 0;
	}

	inDock(): boolean {
		return this.active;
	}

	selectedIndex(): number {
		return this.index;
	}

	/** Drop out automatically when the registry drops to zero rows. */
	reconcile(): void {
		if (this.active && this.getTasks().length === 0) this.exitDock();
	}
}

interface DockWidget extends Component {
	dispose?(): void;
}

/**
 * Install the §4.1 dock widget below the editor. Returns a disposer that
 * clears the clock ticker and removes the widget.
 *
 * Note: TaskManagerApi (frozen) exposes no change subscription, so the ticker
 * also acts as the change detector. It runs only while at least one dock row
 * exists; the extra tick after the last task finishes hides the widget and then
 * stops.
 */
export interface DockOptions {
	/**
	 * Color function for the dock's bottom rule — wired to the live editor's
	 * `borderColor` so the bar visually matches the editor frame.
	 */
	borderColor?: (text: string) => string;
}

export function installDock(
	ctx: ExtensionContext,
	registry: TaskManagerApi,
	controller: DockController,
	options: DockOptions = {},
): { dispose(): void; refresh(): void; setBorderColor(fn: (text: string) => string): void } {
	let borderColor: ((text: string) => string) | undefined = options.borderColor;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let widget: DockWidget | undefined;
	let visible = false;
	let stale = true;
	let lastWidth = 0;
	let lastSignature = "";
	let lastRendered: string[] = [];

	const tasks = (): BgTask[] => dockTasks(registry);

	const signature = (): string => {
		const rows = tasks()
			.map((task) => `${task.id}:${task.status}:${task.startedAt}:${task.command}:${task.name ?? ""}`)
			.join("|");
		return `${controller.selectedIndex()}|${rows}`;
	};

	const stopTicker = (): void => {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	const hide = (): void => {
		if (!visible) return;
		visible = false;
		widget = undefined;
		ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
	};

	const refresh = (): void => {
		controller.reconcile();
		const count = tasks().length;
		debugLog("dock:refresh", { count, visible });
		if (count === 0) {
			stopTicker();
			hide();
			return;
		}
		ensureTicker();
		stale = true;
		lastSignature = signature();
		widget?.invalidate?.();
		ctx.ui.setWidget(DOCK_WIDGET_KEY, factory, { placement: "belowEditor" });
	};

	const ensureTicker = (): void => {
		if (ticker !== undefined) return;
		ticker = setInterval(() => {
			if (tasks().length === 0) {
				stopTicker();
				hide();
				controller.reconcile();
				return;
			}
			stale = true;
			lastSignature = signature();
			widget?.invalidate?.();
			ctx.ui.setWidget(DOCK_WIDGET_KEY, factory, { placement: "belowEditor" });
		}, 1000);
		// Never keep the process alive just for the clock column.
		(ticker as { unref?: () => void }).unref?.();
	};

	const factory = (tui: TUI, theme: Theme): DockWidget => {
		const component: DockWidget = {
			invalidate() {
				stale = true;
			},
			render(width: number): string[] {
				const sig = signature();
				if (!stale && width === lastWidth && sig === lastSignature) return lastRendered;
				lastWidth = width;
				lastSignature = sig;
				stale = false;
				const all = tasks();
				if (all.length === 0) {
					lastRendered = [];
					return lastRendered;
				}
				// pi caps extension widgets at 10 lines (MAX_WIDGET_LINES):
				// 2 rules + 1 count line + rows ≤ 7. Newest first is the
				// registry order already, so clamping drops the oldest.
				const rows = all.slice(0, 7);
				const selectedIndex = controller.inDock() ? controller.selectedIndex() : -1;
				const now = Date.now();
				const lines = rows.map((task, i) =>
					colorBullet(dockRow(task, i === selectedIndex, width, now), task.status, theme),
				);
				// No top rule (the editor frame already separates); the bottom rule
				// matches the editor border color so the block reads as one frame.
				const rule = borderColor ? borderColor(RULE_CHAR.repeat(width)) : theme.fg("dim", RULE_CHAR.repeat(width));
				lines.push(truncateToWidth(rule, width));
				lines.push(truncateToWidth(theme.fg("dim", `${all.length} task(s) · /tasks`), width));
				lastRendered = lines;
				return lastRendered;
			},
			dispose() {
				stopTicker();
			},
		};
		widget = component;
		visible = true;
		debugLog("dock:factory installed", { rows: tasks().length });
		return component;
	};

	// Registry transitions drive install/refresh (PRD-003 §7.8): without this
	// subscription the widget stays cleared forever — the empty-cache bug.
	const unsubscribe = registry.onChange(() => {
		debugLog("dock:registry change");
		refresh();
	});

	// Initial state: only show when tasks already exist.
	refresh();
	if (tasks().length === 0) ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });

	const dispose = (): void => {
		stopTicker();
		unsubscribe();
		widget?.dispose?.();
		widget = undefined;
		ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined, { placement: "belowEditor" });
	};

	return {
		dispose,
		refresh,
		setBorderColor(fn: (text: string) => string): void {
			borderColor = fn;
			widget?.invalidate?.();
		},
	};
}
