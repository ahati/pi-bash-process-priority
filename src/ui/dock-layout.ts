/**
 * Pure layout math for the expanded dock — single-scroll subpage.
 *
 * The expanded view is one resizable panel: a sticky header row, one scroll
 * window over the whole document (task list → details → output tail), and a
 * fixed status row. There is no internal split any more: the list, metadata
 * and log scroll together, so a 50%-height dock spends its rows on content
 * instead of fixed chrome.
 *
 * Height model:
 *
 *   defaultTotalRows = floor(termHeight * DOCK_DEFAULT_HEIGHT_SHARE)   (50%)
 *   capTotalRows     = min(floor(termHeight * maxHeightShare),
 *                          termHeight - DOCK_SCREEN_RESERVE_ROWS)
 *   totalRows        = clamp(requested ?? defaultTotalRows,
 *                            DOCK_MIN_ROWS, capTotalRows)
 *
 * Dragging the block grip (▬▬▬▬) on the top rule or pressing `[` / `]` moves
 * the panel between its 3-row floor and the maximum the screen can give it
 * (full screen minus the transcript/editor/footer reserve). The default
 * opening height stays at half the screen; PI_BG_DOCK_MAX_HEIGHT_SHARE can
 * lower the drag ceiling (e.g. 0.5 to hard-cap it at half the screen).
 *
 * Row budget:
 *
 *   ── Background Tasks ▬▬▬▬▬▬▬▬▬▬ ────── 3 tasks · task-2 running   ← sticky header (1)
 *   > ● task-a                       12s task-1                       ┐
 *     ✓ task-b                        8s task-2                       │
 *                                                                     │
 *   Task Details                                                      │ one scroll window
 *   Command: …                                                        │ over the whole
 *   …                                                                 │ document
 *   ───────────────────────────────────────────────────────────       │
 *   Output                                                            │
 *   [log tail lines]                                                  ┘
 *   lines 1–18 of 240 · ↑/↓ select · …                               ← status (1)
 *
 * Total = 2 + viewportRows. The rendered line count is a pure function of
 * `(termHeight, requestedTotalRows)` — never of the selection, task count or
 * output volume — so pi-tui's line-diff renderer keeps stable geometry.
 *
 * No side effects, no theme, no controller state — pure string/number math.
 */

/** Sticky header rule (title, height grip, task/selection hint). */
export const DOCK_HEADER_ROWS = 1;
/** Trailing status/scroll/hint row. */
export const DOCK_STATUS_ROWS = 1;
/** Fixed chrome: header + status. */
export const DOCK_CHROME_ROWS = DOCK_HEADER_ROWS + DOCK_STATUS_ROWS; // 2
/** Smallest scroll window (one document row). */
export const DOCK_MIN_CONTENT_ROWS = 1;
/** Absolute floor for the panel: chrome + one content row. */
export const DOCK_MIN_ROWS = DOCK_CHROME_ROWS + DOCK_MIN_CONTENT_ROWS; // 3

/**
 * Screen rows the panel always leaves alone when maximized: the transcript's
 * one-row minimum, the editor's three-row frame (top border + one line +
 * bottom border), and the footer. This is what "100%" means for a
 * below-editor widget — the editor must stay usable, so the panel cannot
 * literally own every terminal row. A multi-line editor squeezes the panel's
 * bottom at the ceiling; drag the top grip down to make room.
 */
export const DOCK_SCREEN_RESERVE_ROWS = 5;

/** Opening height: the panel starts at half the screen. */
export const DOCK_DEFAULT_HEIGHT_SHARE = 0.5;
/** Default drag ceiling: the maximum usable height (100% minus the reserve). */
export const DOCK_DEFAULT_MAX_HEIGHT_SHARE = 1;
/** Lower bound accepted for PI_BG_DOCK_MAX_HEIGHT_SHARE. */
export const DOCK_MIN_MAX_HEIGHT_SHARE = 0.2;
/** Upper bound accepted for PI_BG_DOCK_MAX_HEIGHT_SHARE. */
export const DOCK_MAX_MAX_HEIGHT_SHARE = 1;

/** Per-task tail cache size: recent tails survive selection changes. */
export const DOCK_TAIL_CACHE_SIZE = 4;

/** Row boundaries of the rendered panel, 0-based. */
export interface DockLayoutMetrics {
	/** Total panel height: DOCK_CHROME_ROWS + viewportRows. */
	totalRows: number;
	/** Number of document rows visible at once (the scroll window). */
	viewportRows: number;
	/** Smallest total the user may drag to. */
	minTotalRows: number;
	/** Largest total the user may drag to (the drag ceiling). */
	maxTotalRows: number;
	/** Share-based ceiling before the screen reserve: floor(rows * share). */
	capTotalRows: number;
	/** Opening height (50% of the terminal, clamped). */
	defaultTotalRows: number;
	/** Height share applied to the terminal (0.2–1). */
	maxHeightShare: number;
	/** True when the terminal cannot fit the 3-row floor (cap below it). */
	degraded: boolean;
	/** Sticky header row (0). */
	headerRows: number;
	/** First scroll-window row (= headerRows). */
	viewportStart: number;
	/** One past the last scroll-window row. */
	viewportEnd: number;
	/** Status row (= totalRows - 1). */
	statusIndex: number;
}

/** Terminal height with the codebase's usual fallbacks (arg → stdout.rows → 24). */
export function resolveTermHeight(termHeight?: number): number {
	if (typeof termHeight === "number" && Number.isFinite(termHeight) && termHeight > 0) {
		return Math.floor(termHeight);
	}
	if (typeof process !== "undefined" && process.stdout?.rows) {
		return process.stdout.rows;
	}
	return 24;
}

export function clampToRange(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Parse the drag ceiling from a number, a decimal string ("0.5"), or a
 * percentage string ("50%"). Invalid input falls back; valid input is clamped
 * to [0.2, 1] so a typo can never hide the dock.
 */
export function resolveDockMaxHeightShare(
	value?: string | number,
	fallback: number = DOCK_DEFAULT_MAX_HEIGHT_SHARE,
): number {
	let parsed: number;
	if (typeof value === "number") {
		parsed = value;
	} else if (typeof value === "string" && value.trim() !== "") {
		const trimmed = value.trim();
		parsed = trimmed.endsWith("%")
			? Number.parseFloat(trimmed.slice(0, -1)) / 100
			: Number.parseFloat(trimmed);
	} else {
		parsed = fallback;
	}
	if (!Number.isFinite(parsed) || parsed <= 0) {
		const fallbackClamped = Number.isFinite(fallback) && fallback > 0 ? fallback : DOCK_DEFAULT_MAX_HEIGHT_SHARE;
		return Math.min(DOCK_MAX_MAX_HEIGHT_SHARE, Math.max(DOCK_MIN_MAX_HEIGHT_SHARE, fallbackClamped));
	}
	return Math.min(DOCK_MAX_MAX_HEIGHT_SHARE, Math.max(DOCK_MIN_MAX_HEIGHT_SHARE, parsed));
}

/** Options for {@link computeLayout}: the user-resized height, and the cap. */
export interface DockLayoutOptions {
	/** User-dragged total panel height in rows. Defaults to the 50% opening. */
	totalRows?: number;
	/** Drag ceiling as a share of terminal rows (0.2–1, default 1). */
	maxHeightShare?: number;
}

/**
 * Compute the single-scroll layout for a terminal height.
 *
 * `options.totalRows` is the user-resized knob; `undefined` means "user has
 * not resized" → the panel opens at half the terminal. Geometry re-clamps on
 * every call, so terminal resizes and stored drags always stay in range.
 */
export function computeLayout(
	termHeight?: number,
	options: DockLayoutOptions = {},
): DockLayoutMetrics {
	const rows = resolveTermHeight(termHeight);
	const maxHeightShare = resolveDockMaxHeightShare(options.maxHeightShare);

	// Hard ceiling: the share limit, and never the rows the transcript,
	// editor and footer need.
	const capTotalRows = Math.max(
		DOCK_MIN_ROWS,
		Math.min(Math.floor(rows * maxHeightShare), rows - DOCK_SCREEN_RESERVE_ROWS),
	);
	const degraded = rows - DOCK_SCREEN_RESERVE_ROWS < DOCK_MIN_ROWS;
	const maxTotalRows = Math.max(DOCK_MIN_ROWS, capTotalRows);
	const defaultTotalRows = clampToRange(
		Math.floor(rows * DOCK_DEFAULT_HEIGHT_SHARE),
		DOCK_MIN_ROWS,
		maxTotalRows,
	);
	const totalRows = clampToRange(options.totalRows ?? defaultTotalRows, DOCK_MIN_ROWS, maxTotalRows);
	const viewportRows = totalRows - DOCK_CHROME_ROWS;
	const viewportStart = DOCK_HEADER_ROWS;
	const viewportEnd = viewportStart + viewportRows;

	return {
		totalRows,
		viewportRows,
		minTotalRows: DOCK_MIN_ROWS,
		maxTotalRows,
		capTotalRows,
		defaultTotalRows,
		maxHeightShare,
		degraded,
		headerRows: DOCK_HEADER_ROWS,
		viewportStart,
		viewportEnd,
		statusIndex: viewportEnd,
	};
}
