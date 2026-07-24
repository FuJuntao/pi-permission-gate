/**
 * Shared types for the permission gate pipeline.
 */

/** CRUD operation kind inferred from a tool call. */
export type OpKind = "create" | "read" | "update" | "delete";

/** Policy tier after path/op context is applied. */
export type Tier = "T0" | "T1" | "T2";

/** Which pipeline stage produced the final decision. */
export type DecisionStage =
	| "off"
	| "hard-block"
	| "config-deny"
	| "config-allow"
	| "tier-t2"
	| "tier-t0"
	| "judge"
	| "user-prompt"
	| "no-ui"
	| "dry-run";

/** Final verdict of the pipeline. */
export type Verdict = "allow" | "block";

/** Gate operating mode. */
export type Mode = "default" | "auto" | "off";

export interface Decision {
	verdict: Verdict;
	stage: DecisionStage;
	reason: string;
	/** Set in dry-run: what the verdict would have been when enforcing. */
	wouldBe?: Verdict;
	op?: OpKind;
	tier?: Tier;
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

/** Result of analyzing a full command line (shell parser + command DB). */
export interface Analysis {
	/** Legacy shell classification used by the analyzer internals. */
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
	/** When true, classify as mode but only enforce hard blocks; record wouldBe. */
	dryRun: boolean;
	/** "provider/model-id" for the LLM judge. Empty string = not configured. */
	judgeModel: string;
	/** Write every decision to logPath. */
	audit: boolean;
	/** Hard blocks apply in default/auto (including dry-run). */
	hardBlocksEnabled: boolean;
	/** Glob patterns for freely creatable/readable files. */
	allowedFiles: string[];
	/** Root directories whose contents are disposable (U/D -> T2). */
	disposablePaths: string[];
	/** Wildcard patterns matched against the tool subject; allow wins unless denied. */
	allow: string[];
	/** Wildcard patterns matched against the tool subject; deny always beats allow. */
	deny: string[];
	/** Glob patterns for credential-like paths (U/D → T1). */
	protectedPaths: string[];
	/** Audit log file path (supports ~). */
	logPath: string;
	/** Judge request timeout in milliseconds. */
	judgeTimeoutMs: number;
	/** Tool names classified as read-only (op=read, no LLM judge needed). */
	readonlyTools: string[];
}

export const DEFAULT_CONFIG: GateConfig = {
	mode: "default",
	dryRun: false,
	judgeModel: "",
	audit: false,
	hardBlocksEnabled: true,
	allowedFiles: ["**/*"],
	disposablePaths: ["/tmp", "/var/tmp", "/dev/shm", "~/.cache"],
	allow: [],
	deny: [],
	protectedPaths: [
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
	readonlyTools: [
		"read", "grep", "find", "ls",
		"web_search", "fetch_content", "get_search_content",
		"symbol_search", "module_report", "read_symbol", "read_enclosing",
		"lsp_diagnostics", "lens_diagnostics",
	],
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
	dryRun?: boolean;
	stage: DecisionStage;
	verdict: Verdict;
	/** Present in dry-run: what would have happened when enforcing. */
	wouldBe?: Verdict;
	reason: string;
	op?: OpKind;
	tier?: Tier;
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
	/** Judge details when the judge ran. */
	judge?: {
		model: string;
		safe?: boolean;
		op?: OpKind;
		reason: string;
		ms: number;
		role: "safety" | "classify";
	};
	userChoice?: string;
}
