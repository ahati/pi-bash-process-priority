/**
 * Pure layout math for the expanded master-detail dock — PRD-007 Approach A
 * (fixed two-panel) plus the terminal-height cap and the two-axis resize.
 *
 * Two user knobs, both clamped to a deterministic range:
 *
 *   - `totalRows` — the whole widget's height. Dragged via the block grip
 *     (▬▬▬▬) on the top rule, or `[` / `]`. Capped at 50% of the screen.
 *   - `listRows`  — the master-list pane. Dragged via the `⇕` row, or `+`/`-`.
 *     The output pane absorbs the difference.
 *
 * Height cap (DOCK_DEFAULT_MAX_HEIGHT_SHARE = 0.5):
 *
 *   capTotalRows = min(floor(termHeight * share), termHeight - reserve)
 *
 * so the expanded dock never covers more than half the vertical screen. The
 * metadata group flexes (6 → 0 rows) before the cap is violated; below the
 * absolute floor (chrome + one row per pane) the layout is `degraded` and the
 * floor wins over the cap.
 *
 * Row budget (top to bottom, every section fixed for a given height):
 *
 *   ── Background Tasks ▬▬▬▬▬▬▬▬▬▬ ─────── N tasks · 1–3 of 7   ┐ header (3)
 *   current session branch                                        │
 *                                                               ┘
 *   > ✓ task-a                     12s task-1           ┐ master list
 *     ● task-b                      3s task-2           │ L rows
 *     ⋮ (blank pad rows)                                ┘
 *   ⇕ (drag or +/- to resize) ──────────────────────────   1 split handle
 *   Task Details                                          0–1 (hidden with meta)
 *   Command: …                                        ┐
 *   Status:  …                                        │ metadata
 *   Type:    …                                        │ 0–6 rows
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
 * Total = DOCK_CHROME_NO_META_ROWS(8) + titleRows + metaRows + L + O. It is a
 * pure function of `(termHeight, requested sizes)` — never of the selection,
 * task count, or output volume — so pi-tui's line-diff renderer stays on
 * stable geometry.
 *
 * No side effects, no theme, no controller state — pure string/number math.
 */

/** Header rule + subtitle + blank separator. */
export const DOCK_HEADER_ROWS = 3;
/** The resizable boundary row between master list and details. */
export const DOCK_HANDLE_ROWS = 1;
/** "Task Details" title row (hidden when the metadata group collapses). */
export const DOCK_DETAIL_TITLE_ROWS = 1;
/** Metadata group height: Command, Status, Type, Started, Cwd, Log (padded when absent). */
export const DOCK_META_ROWS = 6;
/** Divider rule between details and output. */
export const DOCK_RULE_ROWS = 1;
/** "Output" title + blank separator. */
export const DOCK_OUTPUT_HEADER_ROWS = 2;
/** Trailing status/hint line. */
export const DOCK_STATUS_ROWS = 1;

/** Maximum chrome: every section visible (full metadata group + title). */
export const DOCK_FIXED_ROWS =
	DOCK_HEADER_ROWS +
	DOCK_HANDLE_ROWS +
	DOCK_DETAIL_TITLE_ROWS +
	DOCK_META_ROWS +
	DOCK_RULE_ROWS +
	DOCK_OUTPUT_HEADER_ROWS +
	DOCK_STATUS_ROWS; // 15

/** Chrome that never flexes — everything except the details title + metadata. */
export const DOCK_CHROME_NO_META_ROWS =
	DOCK_HEADER_ROWS +
	DOCK_HANDLE_ROWS +
	DOCK_RULE_ROWS +
	DOCK_OUTPUT_HEADER_ROWS +
	DOCK_STATUS_ROWS; // 8

/** Default master-list pane size (used for the default split when it fits). */
export const DOCK_MIN_LIST_ROWS = 3;
/** Default output pane size (used for the default split when it fits). */
export const DOCK_MIN_OUTPUT_ROWS = 4;

/** Absolute pane floor when the user drags the split under a tight height cap. */
export const DOCK_MIN_PANE_ROWS = 1;

/**
 * Rows per pane the cap protects before the metadata group is sacrificed.
 * Keeps the metadata visible on normal terminals (e.g. 40 rows) while leaving
 * at least 2 list + 2 output rows inside the cap.
 */
export const DOCK_CAP_PANE_ROWS = 2;

/**
 * Rows reserved below the widget for the editor + footer so they stay visible.
 * The dock never grows past `min(termHeight - this, height cap)` unless the
 * layout is degraded (terminal too small for the pane floor).
 */
export const DOCK_EDITOR_RESERVE_ROWS = 6;

/** Share of the L+O budget the master list takes by default (before user resize). */
export const DOCK_DEFAULT_LIST_SHARE = 0.35;

/** Default cap: the expanded dock may use at most this share of the terminal. */
export const DOCK_DEFAULT_MAX_HEIGHT_SHARE = 0.5;
/** Lower bound accepted for PI_BG_DOCK_MAX_HEIGHT_SHARE. */
export const DOCK_MIN_MAX_HEIGHT_SHARE = 0.2;
/** Upper bound accepted for PI_BG_DOCK_MAX_HEIGHT_SHARE. */
export const DOCK_MAX_MAX_HEIGHT_SHARE = 0.9;

/** Per-task tail cache size (PRD-007 G2): recent tails survive selection changes. */
export const DOCK_TAIL_CACHE_SIZE = 4;

/** Row boundaries of the rendered widget, 0-based. `end` indices are exclusive. */
export interface DockLayoutMetrics {
	/** Effective master-list rows (L). */
	listRows: number;
	/** Effective output tail rows (O). */
	outputRows: number;
	/** Total widget height: chromeRows + listRows + outputRows. */
	totalRows: number;
	/** Largest listRows a user drag may request (output keeps one row). */
	maxListRows: number;
	/** Default listRows when the user has not resized (already clamped). */
	defaultListRows: number;
	/** Effective metadata group height: 0…DOCK_META_ROWS. */
	metaRows: number;
	/** "Task Details" title rows: 1 with metadata, 0 when it collapses. */
	detailTitleRows: number;
	/** Effective chrome for this layout: 8 + detailTitleRows + metaRows. */
	chromeRows: number;
	/** Smallest total the user may drag to (chrome + one row per pane). */
	minTotalRows: number;
	/** Largest total the user may drag to (the height cap, or minTotal when degraded). */
	maxTotalRows: number;
	/** Raw cap before the feasibility floor: min(floor(rows*share), rows - reserve). */
	capTotalRows: number;
	/** Height share applied to the terminal (0.2–0.9). */
	maxHeightShare: number;
	/** True when the terminal is too small to honor the cap with the pane floor. */
	degraded: boolean;
	headerRows: number;
	/** First list row (= headerRows). */
	listStart: number;
	/** One past the last list row. */
	listEnd: number;
	/** The split-handle row. */
	handleIndex: number;
	/** The details title row (also the first metadata row when the title is hidden). */
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

/**
 * Parse the height cap from a number, a decimal string ("0.5"), or a
 * percentage string ("50%"). Invalid input falls back; valid input is clamped
 * to [0.2, 0.9] so a typo can never hide the dock or reclaim the whole screen.
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

/** Options for {@link computeLayout}: the user-resized total, and the cap. */
export interface DockLayoutOptions {
	/** User-dragged total widget height in rows. Defaults to the height cap. */
	totalRows?: number;
	/** Max share of terminal rows the widget may occupy (0.2–0.9, default 0.5). */
	maxHeightShare?: number;
}

/**
 * Compute the fixed two-panel layout for a terminal height.
 *
 * `requestedListRows`/`options.totalRows` are the user-resized knobs;
 * `undefined` means "user has not resized" → the defaults are derived from the
 * terminal height and the height cap. `options.maxHeightShare` overrides the
 * cap (PI_BG_DOCK_MAX_HEIGHT_SHARE).
 */
export function computeLayout(
	termHeight?: number,
	requestedListRows?: number,
	options: DockLayoutOptions = {},
): DockLayoutMetrics {
	const rows = resolveTermHeight(termHeight);
	const maxHeightShare = resolveDockMaxHeightShare(options.maxHeightShare);

	// Hard height cap: never more than `share` of the screen, and always leave
	// the editor/footer reserve intact.
	const capTotalRows = Math.max(
		1,
		Math.min(Math.floor(rows * maxHeightShare), rows - DOCK_EDITOR_RESERVE_ROWS),
	);

	// Metadata is the flex section: reserve DOCK_CAP_PANE_ROWS per pane inside
	// the cap, then give the remainder to the details group up to six rows.
	const metaBudget =
		capTotalRows -
		DOCK_CHROME_NO_META_ROWS -
		DOCK_DETAIL_TITLE_ROWS -
		DOCK_CAP_PANE_ROWS * 2;
	const metaRows = clampToRange(metaBudget, 0, DOCK_META_ROWS);
	const detailTitleRows = metaRows > 0 ? DOCK_DETAIL_TITLE_ROWS : 0;
	const chromeRows = DOCK_CHROME_NO_META_ROWS + detailTitleRows + metaRows;

	const minTotalRows = chromeRows + DOCK_MIN_PANE_ROWS * 2;
	const degraded = capTotalRows < minTotalRows;
	const maxTotalRows = Math.max(minTotalRows, capTotalRows);
	const totalRows = clampToRange(
		options.totalRows ?? maxTotalRows,
		minTotalRows,
		maxTotalRows,
	);
	const budget = totalRows - chromeRows; // >= 2

	// Pane defaults: the classic 3/4 minimums apply when they fit; on a tight
	// cap both panes fall back to one row so the user can still trade rows.
	const comfortable = budget >= DOCK_MIN_LIST_ROWS + DOCK_MIN_OUTPUT_ROWS;
	const comfortableListRows = comfortable ? DOCK_MIN_LIST_ROWS : DOCK_MIN_PANE_ROWS;
	const comfortableOutputRows = comfortable ? DOCK_MIN_OUTPUT_ROWS : DOCK_MIN_PANE_ROWS;
	const maxListRows = budget - DOCK_MIN_PANE_ROWS;
	const defaultListRows = clampToRange(
		Math.ceil(budget * DOCK_DEFAULT_LIST_SHARE),
		comfortableListRows,
		budget - comfortableOutputRows,
	);
	const listRows = clampToRange(
		requestedListRows ?? defaultListRows,
		DOCK_MIN_PANE_ROWS,
		maxListRows,
	);
	const outputRows = budget - listRows;

	const listStart = DOCK_HEADER_ROWS;
	const listEnd = listStart + listRows;
	const handleIndex = listEnd;
	const detailTitleIndex = handleIndex + DOCK_HANDLE_ROWS;
	const metaStart = detailTitleIndex + detailTitleRows;
	const ruleIndex = metaStart + metaRows;
	const outputTitleIndex = ruleIndex + DOCK_RULE_ROWS;
	const outputStart = outputTitleIndex + DOCK_OUTPUT_HEADER_ROWS;
	const statusIndex = outputStart + outputRows;

	return {
		listRows,
		outputRows,
		totalRows,
		maxListRows,
		defaultListRows,
		metaRows,
		detailTitleRows,
		chromeRows,
		minTotalRows,
		maxTotalRows,
		capTotalRows,
		maxHeightShare,
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
