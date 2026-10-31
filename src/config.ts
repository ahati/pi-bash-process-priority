/**
 * Config resolution for PRD-003 background tasks (§8 of
 * docs/background-task-design-and-ui.md).
 *
 * Pure module: env in → BgConfig out, clamped and defaulted. No pi imports,
 * no I/O — safe on import paths and unit-testable without a host.
 */

import type { BgConfig } from "./types.ts";

export const DEFAULT_FG_NICE = 10; // PRD-001 contract
export const DEFAULT_BG_NICE = 19; // unprivileged floor; strictly below fg
export const DEFAULT_IONICE_CLASS = 3; // idle; 0 disables ionice
export const DEFAULT_TASKS_MAX = 100;
export const DEFAULT_KILL_GRACE_MS = 3_000;
export const DEFAULT_LOG_BYTES = 50_000;
export const DEFAULT_FG_TIMEOUT_MAX = 60; // seconds (PRD-004 §4.1)
export const DEFAULT_BG_TIMEOUT_MAX = 300; // seconds (PRD-004 §4.1)

export type EnvLike = Record<string, string | undefined>;

function parseIntEnv(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Parse and clamp the full background-task config from the environment. */
export function resolveBgConfig(env: EnvLike, platform: NodeJS.Platform): BgConfig {
	const fgNice = clamp(parseIntEnv(env.PI_BASH_NICE_LEVEL, DEFAULT_FG_NICE), 1, 19);
	// bg must be strictly lower priority than fg: clamp up to fgNice minimum.
	const bgNice = clamp(parseIntEnv(env.PI_BG_NICE_LEVEL, DEFAULT_BG_NICE), fgNice, 19);
	const ioniceClass = clamp(parseIntEnv(env.PI_BG_IONICE_CLASS, DEFAULT_IONICE_CLASS), 0, 3);
	return {
		fgNice,
		bgNice,
		ioniceClass,
		supportedPlatform: platform !== "win32",
		logDir: env.PI_BG_TASK_LOG_DIR?.trim() || undefined,
		tasksMax: Math.max(1, parseIntEnv(env.PI_BG_TASKS_MAX, DEFAULT_TASKS_MAX)),
		killGraceMs: Math.max(0, parseIntEnv(env.PI_BG_KILL_GRACE_MS, DEFAULT_KILL_GRACE_MS)),
		logBytes: Math.max(1024, parseIntEnv(env.PI_BG_LOG_BYTES, DEFAULT_LOG_BYTES)),
		fgTimeoutMax: Math.max(1, parseIntEnv(env.PI_BASH_FG_TIMEOUT_MAX, DEFAULT_FG_TIMEOUT_MAX)),
		bgTimeoutMax: Math.max(1, parseIntEnv(env.PI_BASH_TIMEOUT_BG_MAX, DEFAULT_BG_TIMEOUT_MAX)),
	};
}

/** Resolve the effective log directory (§8): explicit or <cwd>/.pi/bg-tasks. */
export function resolveLogDir(config: BgConfig, cwd: string): string {
	return config.logDir ?? `${cwd}/.pi/bg-tasks`;
}
