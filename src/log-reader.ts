/**
 * Bounded asynchronous log reading and output normalization.
 * Ported and adapted from pi-background-tasks.
 */

import { open, stat } from "node:fs/promises";

export const DETAIL_TAIL_BYTES = 128 * 1024; // 128 KiB tail reservoir for UI scrollback
export const MAX_LOG_BYTES = 50 * 1024; // 50 KiB cap for agent model tools
export const MAX_OUTPUT_BYTES = Number(process.env["PI_BG_MAX_OUTPUT_BYTES"] ?? 20 * 1024 * 1024); // 20 MiB safety cap

export interface BoundedReadResult {
	content: string;
	truncated: boolean;
	bytesRead: number;
	totalBytes: number;
}

/**
 * Asynchronously read bounded output from a log file.
 * If tail is true, seeks to the last maxBytes of the file.
 * If tail is false, reads the first maxBytes.
 */
export async function boundedRead(
	filePath: string,
	maxBytes: number,
	tail = true,
): Promise<BoundedReadResult> {
	let totalBytes = 0;
	try {
		const stats = await stat(filePath);
		totalBytes = stats.size;
	} catch {
		return { content: "", truncated: false, bytesRead: 0, totalBytes: 0 };
	}

	const bytesToRead = Math.min(totalBytes, Math.max(0, maxBytes));
	if (bytesToRead === 0) {
		return { content: "", truncated: false, bytesRead: 0, totalBytes };
	}

	const file = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
		const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
		return {
			content: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated: totalBytes > bytesRead,
			bytesRead,
			totalBytes,
		};
	} finally {
		await file.close();
	}
}

/**
 * Normalize raw output string into display lines,
 * stripping \r and dropping only the trailing empty line from a final newline.
 */
export function toOutputLines(content: string): string[] {
	return content
		.replace(/\r/g, "")
		.split("\n")
		.filter((line, index, array) => line.length > 0 || index < array.length - 1);
}
