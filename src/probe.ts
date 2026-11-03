/**
 * Session-start probe (PRD-001 §5.4).
 *
 * Runs `nice -n <level> true` exactly once per session, never through the
 * bash tool (FR-9), to verify that the platform's nice can apply the
 * increment. GNU/BSD/busybox nice fail open with a "cannot set niceness"
 * warning on stderr while still running the child — so exit code 0 alone
 * is not success; the warning must be absent too.
 */

import { execFile } from "node:child_process";

const PROBE_TIMEOUT_MS = 5000;

export function probeNice(level: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const child = execFile(
				"nice",
				["-n", String(level), "true"],
				{ timeout: PROBE_TIMEOUT_MS },
				(error, _stdout, stderr) => {
					if (error) return done(false);
					if (/cannot set niceness/i.test(String(stderr))) return done(false);
					done(true);
				},
			);
			// ENOENT (nice missing) and other spawn failures surface here.
			child.on("error", () => done(false));
		} catch {
			done(false);
		}
	});
}

/** `ionice -c <class> true` probe; class 0 (off) or missing ionice → false. */
export function probeIonice(ioniceClass: number): Promise<boolean> {
	if (!Number.isFinite(ioniceClass) || ioniceClass <= 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const child = execFile(
				"ionice",
				["-c", String(ioniceClass), "true"],
				{ timeout: PROBE_TIMEOUT_MS },
				(error) => done(!error),
			);
			child.on("error", () => done(false));
		} catch {
			done(false);
		}
	});
}
