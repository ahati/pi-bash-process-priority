import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { boundedRead, toOutputLines } from "../src/log-reader.ts";

test("boundedRead: non-existent file returns empty result safely", async () => {
	const res = await boundedRead("/tmp/non-existent-task-file.log", 1024, true);
	assert.equal(res.content, "");
	assert.equal(res.truncated, false);
	assert.equal(res.bytesRead, 0);
	assert.equal(res.totalBytes, 0);
});

test("boundedRead: reads tail of file within maxBytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "log-read-test-"));
	try {
		const filePath = join(dir, "task.log");
		const data = "line 1\nline 2\nline 3\nline 4\nline 5\n";
		await writeFile(filePath, data, "utf8");

		// Read whole file
		const full = await boundedRead(filePath, 1024, true);
		assert.equal(full.content, data);
		assert.equal(full.truncated, false);
		assert.equal(full.totalBytes, Buffer.byteLength(data));

		// Read tail slice (last 14 bytes)
		const tail = await boundedRead(filePath, 14, true);
		assert.equal(tail.truncated, true);
		assert.equal(tail.bytesRead, 14);
		assert.equal(tail.content, data.slice(-14));

		// Read head slice (first 14 bytes)
		const head = await boundedRead(filePath, 14, false);
		assert.equal(head.truncated, true);
		assert.equal(head.bytesRead, 14);
		assert.equal(head.content, data.slice(0, 14));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("toOutputLines: normalizes carriage returns and drops trailing empty newline", () => {
	const raw = "hello\r\nworld\r\nfoo\n";
	const lines = toOutputLines(raw);
	assert.deepEqual(lines, ["hello", "world", "foo"]);

	const singleLine = "single";
	assert.deepEqual(toOutputLines(singleLine), ["single"]);

	const empty = "";
	assert.deepEqual(toOutputLines(empty), []);
});
