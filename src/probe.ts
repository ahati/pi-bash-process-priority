/**
 * Session-start probe (PRD-001 §5.4).
 *
 * Runs `nice -n <level> true` exactly once per session, never through the
 * bash tool (FR-9), to verify that the platform's nice can apply the
 * increment. GNU/BSD/busybox nice fail open with a "cannot set niceness"
 * warning on stderr while still running the child — so exit code 0 alone
 * is not success; the warning must be absent too.
 */

import { execFile, spawn } from "node:child_process";

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

/**
 * `renice -n <level> -g <pgid>` must work for ctrl+b adoption (§7.4).
 * A detached throwaway child owns its own group; it is killed afterwards.
 */
export function probeRenice(level: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let child: ReturnType<typeof spawn> | undefined;
		const cleanup = () => {
			const pid = child?.pid;
			if (!pid) return;
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// ESRCH: already gone
			}
		};
		try {
			// A nonzero sleep keeps the group alive long enough for renice to run.
			child = spawn("sleep", ["5"], { detached: true, stdio: "ignore" });
			child.on("error", () => {
				cleanup();
				done(false);
			});
			child.once("spawn", () => {
				const pgid = child?.pid;
				if (!pgid) {
					cleanup();
					done(false);
					return;
				}
				try {
					execFile(
						"renice",
						["-n", String(level), "-g", String(pgid)],
						{ timeout: PROBE_TIMEOUT_MS },
						(error) => {
							cleanup();
							done(!error);
						},
					).on("error", () => {
						cleanup();
						done(false);
					});
				} catch {
					cleanup();
					done(false);
				}
			});
		} catch {
			cleanup();
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

/** Resolve a binary's absolute path via `which`; undefined when not found. */
export function resolveBinPath(name: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile("which", [name], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				const p = stdout.trim().split("\n")[0]?.trim();
				resolve(p && p.startsWith("/") ? p : undefined);
			});
		} catch {
			resolve(undefined);
		}
	});
}
