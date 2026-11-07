/**
 * Privacy guard for the e2e record/replay harness (PRD-007 §12.3).
 *
 * Policy (user-set): provider names and model names MAY appear in committed
 * fixtures/docs. Personal identifiers (the operator's name, email, OS
 * username, home directory path) and credential material MUST NOT.
 *
 * `collectIdentities()` derives the concrete identifiers for this machine and
 * `scanFixture()` fails the capture/replay if any of them — or anything that
 * looks like a key — appears in recorded model output. The recorder runs this
 * before writing/keeping the fixture; the replayer runs it when loading, so a
 * hand-edited fixture cannot smuggle content into the tree either.
 */
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

export interface PrivacyHit {
	kind: "identity" | "credential-shape";
	description: string;
	/** First 40 chars of the matching region, remainder masked. */
	excerpt: string;
}

function gitConfig(key: string): string | undefined {
	try {
		const value = execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The concrete personal identifiers this harness must keep out of the tree.
 * Returns `needle → description` pairs with non-trivial lengths only.
 */
export function collectIdentities(): Array<{ needle: string; description: string }> {
	const identities: Array<{ needle: string; description: string }> = [];
	const push = (needle: string | undefined, description: string) => {
		if (needle && needle.length >= 4) identities.push({ needle, description });
	};

	push(gitConfig("user.name"), "git user.name");
	push(gitConfig("user.email"), "git user.email");
	try {
		push(userInfo().username, "OS username");
	} catch {
		/* userInfo can throw on exotic setups */
	}
	push(homedir(), "home directory path");
	// Email local-part of the git email (catches it without the domain).
	const email = gitConfig("user.email");
	if (email?.includes("@")) push(email.split("@")[0], "git email local-part");

	return identities;
}

/** Credential-shaped patterns; structural, so they catch unknown providers. */
const CREDENTIAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "OpenAI-style key (sk-…)", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/ },
	{ label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/ },
	{ label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	{ label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./ },
	{ label: "Authorization header", pattern: /\b(?:authorization|proxy-authorization)\s*[:=]/i },
	{ label: "api key assignment", pattern: /\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i },
	{ label: "long secret-shaped run", pattern: /\b[A-Za-z0-9+/=_-]{43,}\b/ },
];

function excerptOf(content: string, index: number, length: number): string {
	const start = Math.max(0, index);
	const raw = content.slice(start, start + length);
	return (raw.length > 40 ? raw.slice(0, 37) + "…" : raw).replace(/\s+/g, " ");
}

/** Scan recorded/loaded fixture content. Returns every violation found. */
export function scanFixture(content: string): PrivacyHit[] {
	const hits: PrivacyHit[] = [];

	for (const { label, pattern } of CREDENTIAL_PATTERNS) {
		const match = pattern.exec(content);
		if (match) {
			hits.push({
				kind: "credential-shape",
				description: label,
				excerpt: excerptOf(content, match.index, match[0].length),
			});
		}
	}

	for (const { needle, description } of collectIdentities()) {
		const index = content.indexOf(needle);
		if (index !== -1) {
			hits.push({
				kind: "identity",
				description,
				excerpt: excerptOf(content, index, needle.length),
			});
		}
	}

	return hits;
}

/** Human-readable report for CLI output. */
export function reportHits(hits: PrivacyHit[]): string {
	return hits
		.map((hit) => `  - [${hit.kind}] ${hit.description}: "${hit.excerpt}"`)
		.join("\n");
}
