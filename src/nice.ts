/**
 * Pure rewrite logic for pi-bash-process-priority.
 *
 * No pi imports: this module is unit-testable without the host and performs
 * no I/O, so it is safe to call on the tool_call hot path (PRD-001 NFR-1/NFR-3).
 */

/**
 * Default nice increment: 2 — two levels below normal, enough to keep agent
 * workloads from interfering with interactive foreground work while staying
 * clearly above batch-job territory (GNU nice's own default is 10).
 */
export const DEFAULT_NICE_LEVEL = 2;

/** Unprivileged nice increments are only meaningful (and permitted) in 1..19. */
export const MIN_NICE_LEVEL = 1;
export const MAX_NICE_LEVEL = 19;

export interface NiceConfig {
	/** Nice increment applied to every wrapped command (PRD-001 FR-2). */
	level: number;
	/** PI_BASH_NICE_DISABLE=1 disables all rewriting (PRD-001 FR-3). */
	disabled: boolean;
	/** Platform pre-filter; the probe is the real gate (PRD-001 FR-6/FR-7). */
	supportedPlatform: boolean;
}

export type EnvLike = Record<string, string | undefined>;

/** Parse PI_BASH_NICE_LEVEL: default 2, clamp into 1..19, unparsable → default. */
export function parseLevel(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_NICE_LEVEL;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_NICE_LEVEL;
	return Math.min(MAX_NICE_LEVEL, Math.max(MIN_NICE_LEVEL, parsed));
}

/** Resolve the session config from environment + platform (PRD-001 §5.1). */
export function resolveConfig(env: EnvLike, platform: NodeJS.Platform): NiceConfig {
	const disabled = env.PI_BASH_NICE_DISABLE === "1" || env.PI_BASH_NICE_DISABLE === "true";
	return {
		level: parseLevel(env.PI_BASH_NICE_LEVEL),
		disabled,
		supportedPlatform: platform !== "win32",
	};
}

/**
 * POSIX single-quote escaping: every `'` becomes `'\''`
 * (close quote, backslash-escaped quote, reopen quote).
 * Everything else — `$`, backticks, `"`, newlines, globs — stays literal,
 * and non-interactive bash performs no history expansion (PRD-001 §5.2).
 */
export function escapeSingleQuotes(command: string): string {
	return command.replace(/'/g, `'\\''`);
}

/**
 * Skip rule FR-4: don't double-wrap commands the model already niced.
 * True when the first whitespace-delimited token is `nice` itself.
 */
export function isAlreadyWrapped(trimmedCommand: string): boolean {
	return /^nice(?:\s|$)/.test(trimmedCommand);
}

/**
 * Build the wrapped command, or null when it must be passed through unchanged.
 *
 * `ls -la` (level 10) → `nice -n 10 bash -c 'ls -la'`
 *
 * The original command (not the trimmed one) is embedded so whitespace
 * semantics are preserved exactly (PRD-001 §5.2, §5.3).
 */
export function buildNiceCommand(command: string, level: number): string | null {
	if (typeof command !== "string") return null;
	const trimmed = command.trim();
	if (trimmed === "") return null;
	if (isAlreadyWrapped(trimmed)) return null;
	return `nice -n ${level} bash -c '${escapeSingleQuotes(command)}'`;
}
