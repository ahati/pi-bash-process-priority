/**
 * Bash command intent parsing and program extraction.
 * Ported from pi-ui-enhancement.
 */

export const BASH_INTENT_GUIDELINE_MARKER = "Bash call intent headers";

export const BASH_INTENT_GUIDELINE = [
	`## ${BASH_INTENT_GUIDELINE_MARKER}`,
	"",
	"Start every bash command with comment lines naming what it does and why:",
	"",
	"    # intent: <what and why, at most 10 words>",
	"    # tool: <the program and subcommand this command runs>",
	"    <command>",
	"",
	"`intent` is required and is rendered as the call header instead of the raw command, so make it specific",
	'("check which files are dirty" beats "run git").',
	"",
	"`tool` is rendered as the header label and **must name the program actually being run, exactly as it is",
	"invoked** — `gh pr view`, `git status`, `npm test`, `docker compose`. Never name the shell or the tool you",
	"are calling through (`bash`, `shell`) — that says nothing about the command. For a script that runs several",
	"programs, name the one doing the work. Omit `tool` and the label falls back to the program derived from the",
	"command.",
	"",
	"Both are ordinary shell comments: the renderer strips them for display and they are never executed.",
].join("\n");

/** Wrapper programs that should not become the displayed program name. */
const WRAPPER_COMMANDS = new Set(["sudo", "doas", "env", "nohup", "command", "exec", "time", "nice", "ionice"]);

/**
 * Flags that consume the following token as their value, per wrapper. Without
 * this, `sudo -u root systemctl restart app` would label the user name as the
 * program. Flags not listed here are assumed to be standalone (`env -i`, `sudo -n`).
 */
const WRAPPER_VALUE_FLAGS: Record<string, readonly string[]> = {
	sudo: ["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-D", "--user", "--group", "--prompt", "--host"],
	doas: ["-u", "-C"],
	env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
	time: ["-o", "-f", "-a", "--output", "--format", "--append"],
	command: ["-p", "-v"],
	exec: ["-a"],
	nohup: [],
	nice: ["-n", "--adjustment"],
	ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid"],
};

/** A leading `VAR=value` assignment, which is not the program being run. */
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Shells whose own name says nothing about the work. */
const SHELL_COMMANDS = new Set(["bash", "sh", "dash", "zsh", "ksh", "ash", "fish"]);

/** A shell flag that carries the command string: `-c`, `-ic`, `-lc`, `-euc`, … */
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

/** Shell flags whose value is the next token. */
const SHELL_VALUE_FLAGS = new Set(["-o", "+o", "--rcfile", "--init-file", "--startup-file"]);

function stripQuotes(token: string): string {
	return token.replace(/^["']+/, "").replace(/["']+$/, "");
}

function shellProgramName(args: readonly string[], depth: number): string {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		if (SHELL_COMMAND_FLAG.test(token)) {
			const payload = stripQuotes(args[index + 1] ?? "");
			return payload && depth > 0 ? extractProgramName(payload, depth - 1) : "";
		}
		if (SHELL_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (token === "--" || token.startsWith("-") || ENV_ASSIGNMENT_PATTERN.test(token)) {
			continue;
		}
		return stripQuotes(token).split("/").pop() ?? "";
	}
	return "";
}

/**
 * Shell builtins that give no hint about what a command actually does. A leading
 * `cd /srv/app && git status` should label `git status`, not `cd`.
 */
const NO_IDENTITY_PROGRAMS = new Set([
	".", ":", "alias", "cd", "declare", "export", "local", "popd", "pushd", "readonly",
	"set", "shopt", "source", "trap", "true", "ulimit", "umask", "unalias", "unset", "wait",
]);

function findProgramIndex(tokens: readonly string[]): number {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as string;
		if (ENV_ASSIGNMENT_PATTERN.test(token)) {
			index += 1;
			continue;
		}
		if (!WRAPPER_COMMANDS.has(token)) {
			break;
		}

		const valueFlags = WRAPPER_VALUE_FLAGS[token] ?? [];
		index += 1;
		while (index < tokens.length && (tokens[index] as string).startsWith("-")) {
			const flag = tokens[index] as string;
			index += 1;
			if (!flag.includes("=") && valueFlags.includes(flag)) {
				index += 1;
			}
		}
	}
	return index;
}

/**
 * Extracts the primary executable or command program name from a bash command line,
 * skipping environment variable assignments and wrapper commands (nice, sudo, env, etc.).
 */
export function extractProgramName(command: string, depth = 1): string {
	const firstLine =
		command
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0 && !line.startsWith("#")) ?? "";

	for (const statement of firstLine.split(/\s*(?:\|\||&&|;)\s*/)) {
		const segment = statement.split(/\s*\|\s*/)[0]?.trim() ?? "";
		const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
		const programIndex = findProgramIndex(tokens);
		const program = tokens[programIndex];
		if (program === undefined) {
			continue;
		}

		const programLabel = program.split("/").pop() || program;
		if (SHELL_COMMANDS.has(programLabel)) {
			const inner = shellProgramName(tokens.slice(programIndex + 1), depth);
			if (inner) {
				return inner;
			}
			continue;
		}
		if (NO_IDENTITY_PROGRAMS.has(programLabel)) {
			continue;
		}

		return programLabel;
	}

	return "";
}

/**
 * Injects the bash intent guideline into the system prompt if not already present.
 */
export function buildBashIntentSystemPrompt(systemPrompt: string | undefined): string | undefined {
	if (typeof systemPrompt !== "string" || systemPrompt.length === 0) {
		return undefined;
	}
	if (systemPrompt.includes(BASH_INTENT_GUIDELINE_MARKER)) {
		return undefined;
	}
	return `${systemPrompt}\n\n${BASH_INTENT_GUIDELINE}`;
}
