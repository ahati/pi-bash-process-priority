/**
 * Pure layout math for the expanded master-detail dock — PRD-007 Approach A
 * (fixed two-panel with resizable boundary).
 *
 * Every section of the expanded widget is pinned to a fixed vertical offset:
 * the widget's total line count is a pure function of
 * `(terminalHeight, requestedListRows)`, never of `(selection, task count,
 * output volume)`. This is what removes the selection-change flicker: pi-tui's
 * line-diff renderer only rewrites changed line *content* while the geometry
 * stays put.
 *
 * Row budget (top to bottom):
 *
 *   ── Background Tasks ────────── N tasks · 1–3 of 7   ┐ header
 *   current session branch                              │ (3 rows)
 *                                                       ┘
 *   > ✓ task-a                     12s task-1           ┐ master list
 *     ● task-b                      3s task-2           │ L rows
 *     ⋮ (blank pad rows)                                ┘
 *   ⇕ (drag or +/- to resize) ──────────────────────────   1 handle row
 *   Task Details                                          1
 *   Command: …                                        ┐
 *   Status:  …                                        │ metadata
 *   Type:    …                                        │ 6 rows
 *   Started: …                                        │ (padded)
 *   Cwd:     …                                        │
 *   Log:     …                                        ┘
 *   ─────────────────────────────────────────────────────   1 rule
 *   Output                                                1
 *                                                         1 blank
 *   [log tail lines]                                  ┐ output
 *   ⋮ (blank pad rows)                                │ O rows
 *                                                     ┘
 *   following tail 1.2KB · ↑/↓ select · …                 1 status
 *
 * Total: DOCK_FIXED_ROWS + listRows + outputRows = 15 + L + O, clamped so the
 * widget never exceeds `termHeight - DOCK_EDITOR_RESERVE_ROWS` unless the
 * terminal is too small to honor the minimum L + O budget (degraded mode).
 *
 * No side effects, no theme, no controller state — pure string/number math.
 */

/** Header rule + subtitle + blank separator. */
export const DOCK_HEADER_ROWS = 3;
/** The resizable boundary row between master list and details. */
export const DOCK_HANDLE_ROWS = 1;
/** "Task Details" title row. */
export const DOCK_DETAIL_TITLE_ROWS = 1;
/** Metadata group height: Command, Status, Type, Started, Cwd, Log (padded when absent). */
export const DOCK_META_ROWS = 6;
/** Divider rule between details and output. */
export const DOCK_RULE_ROWS = 1;
/** "Output" title + blank separator. */
export const DOCK_OUTPUT_HEADER_ROWS = 2;
/** Trailing status/hint line. */
export const DOCK_STATUS_ROWS = 1;

/** Everything in the widget except the list rows (L) and output rows (O). */
export const DOCK_FIXED_ROWS =
	DOCK_HEADER_ROWS +
	DOCK_HANDLE_ROWS +
	DOCK_DETAIL_TITLE_ROWS +
	DOCK_META_ROWS +
	DOCK_RULE_ROWS +
	DOCK_OUTPUT_HEADER_ROWS +
	DOCK_STATUS_ROWS; // 15

export const DOCK_MIN_LIST_ROWS = 3;
export const DOCK_MIN_OUTPUT_ROWS = 4;

/**
 * Rows reserved below the widget for the editor + footer so they stay visible.
 * The dock never grows past `termHeight - this` (unless degraded, see below).
 */
export const DOCK_EDITOR_RESERVE_ROWS = 6;

/** Share of the L+O budget the master list takes by default (before user resize). */
export const DOCK_DEFAULT_LIST_SHARE = 0.35;

/** Per-task tail cache size (PRD-007 G2): recent tails survive selection changes. */
export const DOCK_TAIL_CACHE_SIZE = 4;

/** Row boundaries of the rendered widget, 0-based. `end` indices are exclusive. */
export interface DockLayoutMetrics {
	/** Effective master-list rows (L). */
	listRows: number;
	/** Effective output tail rows (O). */
	outputRows: number;
	/** Total widget height: DOCK_FIXED_ROWS + listRows + outputRows. */
	totalRows: number;
	/** Largest listRows the current terminal height admits. */
	maxListRows: number;
	/** Default listRows when the user has not resized (already clamped). */
	defaultListRows: number;
	/** True when the terminal is too small to honor the minimum L + O budget. */
	degraded: boolean;
	headerRows: number;
	/** First list row (= headerRows). */
	listStart: number;
	/** One past the last list row. */
	listEnd: number;
	/** The resize-handle row. */
	handleIndex: number;
	detailTitleIndex: number;
	metaStart: number;
	ruleIndex: number;
	outputTitleIndex: number;
	outputStart: number;
	/** The trailing status/hint row (= totalRows - 1). */
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

function metricsWithBoundaries(
	listRows: number,
	outputRows: number,
	maxListRows: number,
	defaultListRows: number,
	degraded: boolean,
): DockLayoutMetrics {
	const listStart = DOCK_HEADER_ROWS;
	const listEnd = listStart + listRows;
	const handleIndex = listEnd;
	const detailTitleIndex = handleIndex + DOCK_HANDLE_ROWS;
	const metaStart = detailTitleIndex + DOCK_DETAIL_TITLE_ROWS;
	const ruleIndex = metaStart + DOCK_META_ROWS;
	const outputTitleIndex = ruleIndex + DOCK_RULE_ROWS;
	const outputStart = outputTitleIndex + DOCK_OUTPUT_HEADER_ROWS;
	const statusIndex = outputStart + outputRows;
	return {
		listRows,
		outputRows,
		totalRows: statusIndex + DOCK_STATUS_ROWS,
		maxListRows,
		defaultListRows,
		degraded,
		headerRows: DOCK_HEADER_ROWS,
		listStart,
		listEnd,
		handleIndex,
		detailTitleIndex,
		metaStart,
		ruleIndex,
		outputTitleIndex,
		outputStart,
		statusIndex,
	};
}

/**
 * Compute the fixed two-panel layout for a terminal height.
 *
 * The user-resizable knob is the master-list pane (`requestedListRows`);
 * the output pane absorbs the remainder of the budget. `undefined` means
 * "user has not resized" → the default split is derived from the height.
 */
export function computeLayout(
	termHeight?: number,
	requestedListRows?: number,
): DockLayoutMetrics {
	const rows = resolveTermHeight(termHeight);
	const available = rows - DOCK_EDITOR_RESERVE_ROWS;
	const minBudget = DOCK_MIN_LIST_ROWS + DOCK_MIN_OUTPUT_ROWS;
	const minTotal = DOCK_FIXED_ROWS + minBudget;

	// Degenerate small terminal: honor the minimums and let the widget exceed
	// the reserve — the main screen scrolls the overflow into scrollback.
	if (available < minTotal) {
		return metricsWithBoundaries(DOCK_MIN_LIST_ROWS, DOCK_MIN_OUTPUT_ROWS, DOCK_MIN_LIST_ROWS, DOCK_MIN_LIST_ROWS, true);
	}

	const budget = available - DOCK_FIXED_ROWS; // rows for L + O, >= minBudget
	const maxListRows = budget - DOCK_MIN_OUTPUT_ROWS;
	const defaultListRows = clampToRange(
		Math.ceil(budget * DOCK_DEFAULT_LIST_SHARE),
		DOCK_MIN_LIST_ROWS,
		maxListRows,
	);
	const listRows = clampToRange(
		requestedListRows ?? defaultListRows,
		DOCK_MIN_LIST_ROWS,
		maxListRows,
	);
	const outputRows = budget - listRows;
	return metricsWithBoundaries(listRows, outputRows, maxListRows, defaultListRows, false);
}
