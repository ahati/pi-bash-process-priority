/**
 * E2E-only companion extension (PRD-007 verification harness).
 *
 * Exposes `/spawn <command>` which starts a background task through the
 * product's own shared-registry surface (`SHARED_TASK_MANAGER_KEY`,
 * exported from the extension's index.ts). This lets the tui-test harness
 * create real dock tasks without an LLM/API key.
 *
 * Not part of the shipped extension — loaded explicitly via `pi -e` in the
 * e2e harness only.
 */
export default function spawnDriver(pi: {
	registerCommand(
		name: string,
		cmd: { description?: string; handler: (args: string, ctx: unknown) => void | Promise<void> },
	): void;
}): void {
	pi.registerCommand("spawn", {
		description: "e2e driver: start a background task via the shared registry",
		handler: async (args: string) => {
			const shared = (globalThis as Record<symbol, unknown>)[
				Symbol.for("pi-bash:shared-task-manager")
			] as { registry?: { run(command: string, cwd: string): Promise<unknown> } } | undefined;
			const registry = shared?.registry;
			const command = (args ?? "").trim();
			if (!registry || command === "") return;
			await registry.run(command, process.cwd());
		},
	});
}
