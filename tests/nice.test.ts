import test from "node:test";
import assert from "node:assert/strict";

import {
	buildNiceCommand,
	escapeSingleQuotes,
	isAlreadyWrapped,
	parseLevel,
	resolveConfig,
} from "../src/nice.ts";

test("escapeSingleQuotes escapes single quotes POSIX-style", () => {
	assert.equal(escapeSingleQuotes(`don't`), `don'\\''t`);
	assert.equal(escapeSingleQuotes(`a'b'c`), `a'\\''b'\\''c`);
	assert.equal(escapeSingleQuotes(`plain`), `plain`);
});

test("buildNiceCommand wraps with the configured level", () => {
	assert.equal(buildNiceCommand(`ls -la`, 10), `nice -n 10 bash -c 'ls -la'`);
	assert.equal(buildNiceCommand(`ls`, 19), `nice -n 19 bash -c 'ls'`);
});

test("buildNiceCommand preserves dollar expansion, newlines and quotes literally", () => {
	const wrapped = buildNiceCommand(`echo $(whoami) && echo "a'b"`, 10);
	assert.ok(wrapped);
	// The payload must round-trip: everything after "bash -c '" is the
	// single-quote-escaped original.
	const inner = wrapped.slice(`nice -n 10 bash -c '`.length, -1);
	assert.equal(inner.replace(/'\\''/g, `'`), `echo $(whoami) && echo "a'b"`);
});

test("buildNiceCommand preserves multi-line commands", () => {
	const multi = `echo one\necho two`;
	const wrapped = buildNiceCommand(multi, 10);
	assert.ok(wrapped?.includes(`bash -c 'echo one\necho two'`));
});

test("buildNiceCommand skip rules", () => {
	assert.equal(buildNiceCommand(``, 10), null, "empty");
	assert.equal(buildNiceCommand(`   `, 10), null, "whitespace only");
	assert.equal(buildNiceCommand(`nice -n 19 heavy-task`, 10), null, "already niced");
	assert.equal(buildNiceCommand(`nice`, 10), null, "bare nice");
	assert.equal(buildNiceCommand(42 as unknown as string, 10), null, "non-string");
});

test("buildNiceCommand does not skip when nice is not the first token", () => {
	assert.equal(buildNiceCommand(`echo nice`, 10), `nice -n 10 bash -c 'echo nice'`);
});

test("parseLevel: default, valid, clamped, unparsable", () => {
	assert.equal(parseLevel(undefined), 2, "product default: two levels below normal");
	assert.equal(parseLevel(``), 2);
	assert.equal(parseLevel(`15`), 15);
	assert.equal(parseLevel(`0`), 1, "clamped to min");
	assert.equal(parseLevel(`-5`), 1);
	assert.equal(parseLevel(`25`), 19, "clamped to max");
	assert.equal(parseLevel(`abc`), 2);
});

test("resolveConfig: env overrides and platform pre-filter", () => {
	assert.deepEqual(resolveConfig({}, "linux"), {
		level: 2,
		disabled: false,
		supportedPlatform: true,
	});
	assert.equal(resolveConfig({ PI_BASH_NICE_LEVEL: "15" }, "darwin").level, 15);
	assert.equal(resolveConfig({ PI_BASH_NICE_DISABLE: "1" }, "linux").disabled, true);
	assert.equal(resolveConfig({ PI_BASH_NICE_DISABLE: "true" }, "linux").disabled, true);
	assert.equal(resolveConfig({}, "win32").supportedPlatform, false, "native Windows inert (W1)");
	assert.equal(resolveConfig({}, "linux").supportedPlatform, true);
});
