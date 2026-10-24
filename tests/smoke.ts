/**
 * Manual smoke test: mimics pi's execution path exactly —
 * spawn("/bin/bash", ["-c", command]) with argv transport.
 *
 * Verifies PRD-001 AC-2 (identical output/exit with and without the wrap)
 * and the core niceness guarantee (AC-1). Run: npx tsx tests/smoke.ts
 */
import { execFile } from "node:child_process";
import { buildNiceCommand } from "../src/nice.ts";

function run(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		execFile("/bin/bash", ["-c", command], (error, stdout, stderr) => {
			const code = error && typeof (error as any).code === "number" ? (error as any).code : 0;
			resolve({ stdout, stderr, code });
		});
	});
}

// A valid command with a balanced single quote inside double quotes,
// arithmetic expansion, a niceness self-report, and a non-zero exit.
const orig = `echo "can't stop" $((1+1))
ps -o ni= -p $$
exit 3`;
const wrapped = buildNiceCommand(orig, 10);
console.log("original :", JSON.stringify(orig));
console.log("wrapped  :", JSON.stringify(wrapped));
if (!wrapped) process.exit(1);

const [plain, niced] = await Promise.all([run(orig), run(wrapped)]);
const nicedOut = niced.stdout.trim().split("\n");
// Output must match modulo the niceness self-report line, which is the
// intended difference (0 unwrapped vs 10 wrapped).
const plainOut = plain.stdout.trim().split("\n").filter((l) => l.trim() !== "0");
const nicedComparable = nicedOut.filter((l) => l.trim() !== "10").join("\n");
const pass =
	plainOut.join("\n") === nicedComparable &&
	plain.stderr === niced.stderr &&
	plain.code === niced.code &&
	nicedOut[0] === "can't stop 2" &&
	nicedOut[1]?.trim() === "10" &&
	niced.code === 3;

console.log("--- unwrapped :", JSON.stringify(plain));
console.log("--- wrapped   :", JSON.stringify(niced));
console.log(
	"PASS:",
	pass,
	"(behavior identical modulo niceness line:", plainOut.join("\n") === nicedComparable,
	"| niceness:", nicedOut[1]?.trim(),
	"| exit propagated:", niced.code === 3,
	")",
);
if (!pass) process.exit(1);
