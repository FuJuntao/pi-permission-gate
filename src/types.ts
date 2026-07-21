/**
 * Shared types for the permission gate pipeline.
 */

/** Which pipeline stage produced the final decision. */
export type DecisionStage =
	| "hard-block"
	| "config-deny"
	| "config-allow"
	| "analyzer-readonly"
	| "analyzer-mutating"
	| "git-tracked-edit"
	| "session-edit"
	| "judge"
	| "user-prompt"
	| "no-ui"
	| "observe";

/** Final verdict of the pipeline. */
export type Verdict = "allow" | "block";

/** Gate operating mode. */
export type Mode = "auto" | "observe" | "strict";

export interface Decision {
	verdict: Verdict;
	stage: DecisionStage;
	reason: string;
	/** Set in observe mode: what the verdict would have been in auto/strict. */
	wouldBe?: Verdict;
}

/** A single simple command parsed out of a compound shell command line. */
export interface Segment {
	index: number;
	/** Raw text of this segment. */
	raw: string;
	/** Resolved binary name (basename, e.g. "git"). Undefined if unparseable. */
	binary?: string;
	/** First positional arg when it looks like a subcommand (e.g. "push" for git). */
	subcommand?: string;
	/** Normalized flags, e.g. ["-r","-f"] for "-rf". Long flags kept whole. */
	flags: string[];
	/** Positional arguments (excluding subcommand). */
	args: string[];
	/** Variable assignments prefixed to the segment, e.g. FOO=bar. */
	env: Record<string, string>;
	/** Redirections attached to the segment. */
	redirects: Redirect[];
	/** Raw command-substitution texts found anywhere in the segment. */
	substitutions: string[];
	/** Why this segment could not be fully analyzed, if applicable. */
	problem?: string;
}

export interface Redirect {
	/** "write" (>, >|, >>), "read" (<), "heredoc" (<<, <<<), "fd-dup" (>&2 etc.) */
	kind: "write" | "read" | "heredoc" | "fd-dup";
	/** Target path for file redirects; fd number/name for fd-dup. */
	target: string;
	/** True when target is a path that will be created/truncated/appended. */
	writes: boolean;
}

/** Result of analyzing a full command line. */
export interface Analysis {
	/** Overall classification of the whole command line. */
	classification: "readonly" | "mutating" | "unknown";
	segments: Segment[];
	/** Separators between segments, e.g. ["&&", "|"]. */
	separators: string[];
	/** Human-readable explanation of the classification. */
	note: string;
}

/** Merged configuration (defaults → global → project). */
export interface GateConfig {
	mode: Mode;
	/** "provider/model-id" for the LLM judge. Empty string = not configured. */
	judgeModel: string;
	/** Run the judge asynchronously in observe mode and log its verdict. */
	judgeInObserveMode: boolean;
	/** Hard blocks apply even in observe mode. */
	hardBlocksEnabled: boolean;
	/** Regex strings matched against the full command; allow wins unless denied. */
	allow: string[];
	/** Regex strings matched against the full command; deny always beats allow. */
	deny: string[];
	/** Glob-ish path patterns that file tools and bash path targets must not touch. */
	sensitivePaths: string[];
	/** Audit log file path (supports ~). */
	logPath: string;
	/** Judge request timeout in milliseconds. */
	judgeTimeoutMs: number;
}

export const DEFAULT_CONFIG: GateConfig = {
	mode: "auto",
	judgeModel: "",
	judgeInObserveMode: true,
	hardBlocksEnabled: true,
	allow: [],
	deny: [],
	sensitivePaths: [
		"~/.ssh",
		"~/.gnupg",
		"~/.aws",
		"**/.env",
		"**/.env.*",
		"**/auth.json",
		"~/.pi/agent/auth.json",
		"**/id_rsa",
		"**/id_ed25519",
		"**/*.pem",
		"**/*.key",
	],
	logPath: "~/.pi/agent/permission-gate.log",
	judgeTimeoutMs: 15000,
};

/** One JSONL record in the audit log. */
export interface AuditEntry {
	ts: number;
	session?: string;
	cwd: string;
	tool: string;
	/** The command or path being gated. */
	subject: string;
	mode: Mode;
	stage: DecisionStage;
	verdict: Verdict;
	/** Present in observe mode: what would have happened. */
	wouldBe?: Verdict;
	reason: string;
	/** Analyzer breakdown for tuning. */
	analysis?: {
		classification: Analysis["classification"];
		note: string;
		segments: Array<{
			raw: string;
			binary?: string;
			subcommand?: string;
			flags: string[];
			args: string[];
			writes: string[];
			problem?: string;
		}>;
	};
	/** Judge details when the judge ran (sync or observe-async). */
	judge?: {
		model: string;
		safe: boolean;
		reason: string;
		ms: number;
		async: boolean;
	};
	userChoice?: string;
}
