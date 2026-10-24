/**
 * pi-bash-process-priority
 *
 * Runs every model-issued bash command at a lower CPU priority by rewriting
 * the command through a `tool_call` handler before execution:
 *
 *   <command>  →  nice -n <LEVEL> bash -c '<command>'
 *
 * No tool is re-registered, so the extension composes with any other
 * bash-owning extension (PRD-001 G3). See docs/PRD-001-bash-nice-override.md.
 *
 * Environment variables:
 *   PI_BASH_NICE_LEVEL   nice increment, clamped to 1..19 (default 2)
 *   PI_BASH_NICE_DISABLE set to "1" to disable the rewrite entirely
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildNiceCommand, resolveConfig, type NiceConfig } from "./src/nice.ts";
import { probeNice } from "./src/probe.ts";

export default function (pi: ExtensionAPI) {
	// Session-scoped state: undefined means "pass through, do not wrap".
	// Reset and re-probe on every session_start because reload and session
	// replacement invalidate the old runtime (PRD-001 §5.1, §5.9).
	let config: NiceConfig | undefined;

	pi.on("session_start", async (_event, ctx) => {
		config = undefined;
		const resolved = resolveConfig(process.env, process.platform);
		if (resolved.disabled || !resolved.supportedPlatform) return;
		if (!(await probeNice(resolved.level))) {
			// Fail-open (PRD-001 G4): one diagnostic, commands run at normal priority.
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-bash-process-priority: nice probe failed — commands run at normal priority this session`,
					"warning",
				);
			}
			return;
		}
		config = resolved;
	});

	pi.on("tool_call", (event) => {
		if (!config || event.toolName !== "bash") return;
		const command = event.input.command;
		if (typeof command !== "string") return;
		const wrapped = buildNiceCommand(command, config.level);
		if (wrapped !== null) event.input.command = wrapped;
	});
}
