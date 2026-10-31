import test from "node:test";
import assert from "node:assert/strict";
import { validateTimeout } from "../src/bash-override.ts";

const CAPS = { fg: 60, bg: 300 };

test("validateTimeout: within caps → no error", () => {
	assert.equal(validateTimeout(undefined, false, CAPS), undefined);
	assert.equal(validateTimeout(30, false, CAPS), undefined);
	assert.equal(validateTimeout(60, false, CAPS), undefined);
	assert.equal(validateTimeout(300, true, CAPS), undefined);
});

test("validateTimeout: over-cap foreground is rejected with the cap named", () => {
	const error = validateTimeout(999, false, CAPS);
	assert.match(error ?? "", /999s exceeds the foreground cap of 60s/);
	assert.match(error ?? "", /background=true/);
});

test("validateTimeout: over-cap background is rejected with the bg cap named", () => {
	const error = validateTimeout(999, true, CAPS);
	assert.match(error ?? "", /999s exceeds the background cap of 300s/);
	assert.match(error ?? "", /PI_BASH_TIMEOUT_BG_MAX/);
});

test("validateTimeout: sub-second timeouts rejected", () => {
	assert.match(validateTimeout(0, false, CAPS) ?? "", /at least 1 second/);
});
