/**
 * Optional debug tracing for the background-task chain (PRD-003/004 field
 * diagnostics). Enabled with PI_BG_DEBUG=1; appends timestamped lines to
 * <logDir>/debug.log. Never throws — tracing must not affect behavior.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

let logPath: string | undefined;

export function initDebugLog(logDir: string): void {
	if (process.env.PI_BG_DEBUG !== "1") {
		logPath = undefined;
		return;
	}
	logPath = join(logDir, "debug.log");
	void mkdir(dirname(logPath), { recursive: true }).catch(() => {});
	void appendFile(logPath, `\n===== session ${new Date().toISOString()} (pid ${process.pid}) =====\n`).catch(() => {});
}

export function debugLog(event: string, data?: unknown): void {
	if (!logPath) return;
	let line = `${new Date().toISOString()} ${event}`;
	if (data !== undefined) {
		try {
			line += ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
		} catch {
			line += " [unserializable]";
		}
	}
	line += "\n";
	void appendFile(logPath, line).catch(() => {});
}

export function debugLogError(event: string, error: unknown): void {
	debugLog(`ERROR ${event}`, error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
}
