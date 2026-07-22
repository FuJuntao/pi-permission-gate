/**
 * Classify a parsed command line as readonly / mutating / unknown.
 *
 * Fail-closed rules:
 *  - any segment with a parse problem → unknown
 *  - any unknown binary → unknown
 *  - any substitution that isn't itself provably read-only → mutating
 *  - any write redirect to a file → mutating
 *  - known-mutating segment → mutating
 *  - everything provably readonly → readonly
 */

import { isAlwaysMutating, isKnownBinary, lookupRule, type CommandRule } from "./command-db.ts";
import { parse } from "./shell-parser.ts";
import type { Analysis, Segment } from "../types.ts";

/** Flags that mean "do something dynamic" on otherwise-simple tools. */
const OPAQUE_PROGRAM_BINS = new Set(["perl", "ruby", "python", "python3", "node", "php", "lua", "awk"]);

/** Depth cap for nested substitution analysis. */
const MAX_DEPTH = 4;

export function classifyCommand(input: string): Analysis {
	return classify(input, 0);
}

function classify(input: string, depth: number): Analysis {
	if (depth > MAX_DEPTH) {
		return { classification: "unknown", segments: [], separators: [], note: "substitution nesting too deep" };
	}

	const { segments, separators, problem } = parse(input);
	if (problem) {
		return { classification: "unknown", segments, separators, note: `parse failed: ${problem}` };
	}
	if (segments.length === 0) {
		return { classification: "unknown", segments, separators, note: "empty command" };
	}

	// A global flag that takes a value (e.g. `git -C <path>`) pushes the real
	// subcommand past the parser's subcommand slot, leaving seg.subcommand unset.
	// Re-derive it from the positional args using the command's subcommand map so
	// `git -C path push` classifies on `push` (mutating), not git's readonly base.
	for (const seg of segments) deriveSubcommand(seg);

	let sawMutating = false;
	let sawUnknown = false;
	const notes: string[] = [];

	for (const seg of segments) {
		const verdict = classifySegment(seg, depth);
		if (verdict === "mutating") {
			sawMutating = true;
			notes.push(segmentNote(seg, "mutating"));
		} else if (verdict === "unknown") {
			sawUnknown = true;
			notes.push(segmentNote(seg, "unknown"));
		}
	}

	// Piping into a write-redirect target is handled per-segment via redirects.

	if (sawMutating) {
		return { classification: "mutating", segments, separators, note: notes.join("; ") };
	}
	if (sawUnknown) {
		return { classification: "unknown", segments, separators, note: notes.join("; ") };
	}
	return { classification: "readonly", segments, separators, note: "all segments read-only" };
}

function segmentNote(seg: Segment, why: string): string {
	const cmd = [seg.binary, seg.subcommand].filter(Boolean).join(" ");
	return `${cmd || seg.raw} → ${why}${seg.problem ? ` (${seg.problem})` : ""}`;
}

/**
 * Recover a hidden subcommand when a value-taking global flag (e.g. `git -C
 * <path>`) pushed it into the positional args. Scans args for the first token
 * that is a key in the command's subcommand map, skipping path/value tokens
 * (contain `/` or `.`). Removes the match from args so path extraction isn't
 * polluted. Net improvement: every `git -C <path> <mutating>` was a false T2.
 */
function deriveSubcommand(seg: Segment): void {
	if (seg.subcommand || !seg.binary || seg.args.length === 0) return;
	const map = lookupRule(seg.binary)?.subcommands;
	if (!map) return;
	for (let i = 0; i < seg.args.length; i++) {
		const a = seg.args[i]!;
		if (a.includes("/") || a.includes(".")) continue;
		if (a in map) {
			seg.subcommand = a;
			seg.args.splice(i, 1);
			return;
		}
	}
}

function classifySegment(seg: Segment, depth: number): "readonly" | "mutating" | "unknown" {
	if (seg.problem) return "unknown";

	// Substitutions: $(rm -rf x) inside `echo` makes the whole thing mutating.
	for (const sub of seg.substitutions) {
		const subAnalysis = classify(sub, depth + 1);
		if (subAnalysis.classification !== "readonly") {
			return subAnalysis.classification === "mutating" ? "mutating" : "unknown";
		}
	}

	// Write redirects to a file target → mutating.
	for (const r of seg.redirects) {
		if (r.kind === "write") {
			// Writing to /dev/null or a tty is harmless.
			if (r.target === "/dev/null" || r.target === "/dev/stdout" || r.target === "/dev/stderr") continue;
			if (r.target.startsWith("/dev/fd/")) continue;
			return "mutating";
		}
	}

	if (!seg.binary) return "unknown";
	const bin = seg.binary;

	// Shells and evaluators: never read-only.
	if (bin === "eval" || bin === "exec" || bin === "source" || bin === "." || bin === "sudo" || bin === "su" || bin === "doas") {
		return "unknown"; // opaque: judge with full context, never auto-allow
	}
	if (["bash", "sh", "zsh", "fish", "dash", "ksh"].includes(bin)) {
		// bash -c 'cmd' → analyze the inner command if we can extract it.
		const cIdx = [...seg.flags.map((f, i) => ({ f, i }))].findIndex(({ f }) => f === "-c");
		if (cIdx !== -1) {
			// The command string is the arg following -c in the ORIGINAL order.
			// Our parser split flags from args, so reconstruct: -c's operand is
			// the first positional when -c is present.
			const script = seg.subcommand ?? seg.args[0];
			if (script) {
				const inner = classify(script, depth + 1);
				return inner.classification;
			}
		}
		return "unknown";
	}

	// Script interpreters with inline programs: opaque unless trivially -e/-c free.
	if (OPAQUE_PROGRAM_BINS.has(bin)) {
		const inlineFlags = ["-e", "-p", "-c", "-l"];
		if (seg.flags.some((f) => inlineFlags.includes(f)) || seg.subcommand === "-e") {
			return "unknown"; // inline program text — opaque to us
		}
		// Running a script file: opaque too (script contents unknown).
		if (seg.subcommand || seg.args.length > 0) return "unknown";
		return "readonly";
	}

	const rule = lookupRule(bin);
	if (!rule) return "unknown";

	// xargs/env/time/watch/timeout/nohup execute other commands — the executed
	// argv was split into our args; be conservative.
	if (rule.executesArgs && bin !== "env" && bin !== "time" && bin !== "watch") {
		return "unknown";
	}
	if ((bin === "env" || bin === "time" || bin === "watch") && (seg.subcommand || seg.args.length > 0)) {
		return "unknown";
	}

	// Special cases.
	if (bin === "tar") return classifyTar(seg);
	if (bin === "rsync") return seg.flags.includes("--dry-run") || seg.flags.includes("-n") ? "readonly" : "mutating";
	if (bin === "awk") {
		// awk programs with redirection/system() are opaque. Program text is
		// usually the subcommand/first arg.
		const program = seg.subcommand ?? seg.args[0] ?? "";
		if (/(^|[^>])>(?!&)|\bsystem\s*\(|getline.*<|print.*>/.test(program)) return "unknown";
		return "readonly";
	}
	if (bin === "gpg") {
		// Subcommand-like long flags decide behavior.
		const ruleGpg = rule.subcommands ?? {};
		for (const f of seg.flags) {
			if (ruleGpg[f]) return ruleGpg[f] === "mutating" ? "mutating" : "readonly";
		}
		return "unknown";
	}
	if (bin === "gh") {
		// gh <noun> <verb>: classify on the verb when present.
		const noun = seg.subcommand;
		const verb = seg.args[0];
		if (noun && verb) {
			const ghRule = rule.subcommands ?? {};
			if (["issue", "pr", "repo", "release", "workflow", "run"].includes(noun)) {
				if (["view", "list", "status", "diff", "checks", "watch"].includes(verb)) return "readonly";
				return "mutating";
			}
			if (ghRule[noun]) return ghRule[noun] === "mutating" ? "mutating" : "readonly";
		}
		return rule.behavior;
	}

	// Generic: subcommand map → flag scan → base behavior.
	if (rule.subcommands && seg.subcommand) {
		const sub = rule.subcommands[seg.subcommand];
		if (sub === "mutating") return "mutating";
		if (sub === "unknown") return "unknown";
		if (sub === "readonly") return flagsWrite(rule, seg.flags) ? "mutating" : "readonly";
		// Unlisted subcommand: mutating-base tools get judged (unknown),
		// readonly-base tools fall back to base.
		return rule.behavior === "mutating" ? "unknown" : "readonly";
	}
	if (rule.subcommands && !seg.subcommand && rule.behavior === "mutating") {
		// e.g. bare `docker` with only flags → treat as its base.
		return "unknown";
	}

	if (isAlwaysMutating(bin)) return "mutating";
	if (flagsWrite(rule, seg.flags)) return "mutating";
	return rule.behavior;
}

function flagsWrite(rule: CommandRule, flags: string[]): boolean {
	if (!rule.writeFlags) return false;
	return flags.some((f) => rule.writeFlags!.includes(f));
}

function classifyTar(seg: Segment): "readonly" | "mutating" | "unknown" {
	// tar's operation letter hides inside bundled flags: -tf (list) vs -cf/-xf.
	let ops = "";
	for (const f of seg.flags) {
		if (f.startsWith("--")) {
			if (["--create", "--extract", "--append", "--delete", "--update"].includes(f)) ops += "c";
			if (["--list", "--diff", "--compare"].includes(f)) ops += "t";
			continue;
		}
		ops += f.slice(1);
	}
	if (seg.subcommand && /^[a-zA-Z]+$/.test(seg.subcommand)) {
		// Old-style: `tar tf archive` — first arg is the op string.
		ops += seg.subcommand;
	}
	if (/[cxArud]/.test(ops)) return "mutating";
	if (/[t]/.test(ops)) return "readonly";
	// Flags like -f consume the archive path; no op letter means tar defaults
	// to reading stdin — call it unknown rather than guess.
	return "unknown";
}

export { isKnownBinary };
