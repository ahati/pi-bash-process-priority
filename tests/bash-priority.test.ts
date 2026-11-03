import test from "node:test";
import assert from "node:assert/strict";

import { buildBgCommandAbs } from "../src/registry.ts";

// ─── buildBgCommandAbs (registry spawn wrapper) ─────────────────────────────

test("buildBgCommandAbs: no nice bin → plain quoted wrapper (fail-open)", () => {
	assert.equal(
		buildBgCommandAbs("sleep 10", { bgNice: 19, ioniceClass: 3 }),
		`bash -c 'sleep 10'`,
	);
});

test("buildBgCommandAbs: absolute bins produce nice → ionice → bash chain", () => {
	assert.equal(
		buildBgCommandAbs("sleep 10", {
			niceBin: "/usr/bin/nice",
			bgNice: 19,
			ioniceBin: "/usr/bin/ionice",
			ioniceClass: 3,
		}),
		`/usr/bin/nice -n 19 /usr/bin/ionice -c 3 bash -c 'sleep 10'`,
	);
});

test("buildBgCommandAbs: ioniceClass 0 omits ionice", () => {
	assert.equal(
		buildBgCommandAbs("sleep 10", { niceBin: "/usr/bin/nice", bgNice: 19, ioniceClass: 0 }),
		`/usr/bin/nice -n 19 bash -c 'sleep 10'`,
	);
});

test("buildBgCommandAbs: single quotes in the command are POSIX-escaped", () => {
	assert.equal(
		buildBgCommandAbs(`echo it's`, { niceBin: "/usr/bin/nice", bgNice: 19, ioniceClass: 0 }),
		`/usr/bin/nice -n 19 bash -c 'echo it'\\''s'`,
	);
});
