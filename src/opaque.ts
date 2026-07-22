/**
 * Opaque interpreter / script launches: load exact source for the judge.
 */

import { readFileSync, existsSync } from "node:fs";
import type { Analysis, Segment } from "./types.ts";
import { resolveAgainst } from "./paths.ts";

const OPAQUE_BINS = new Set([
	"perl",
	"ruby",
	"python",
	"python3",
	"node",
	"nodejs",
	"php",
	"lua",
	"deno",
	"bun",
	"bash",
	"sh",
	"zsh",
	"fish",
	"dash",
	"ksh",
]);

const INLINE_FLAGS = new Set(["-c", "-e", "-p", "-l"]);

export function isOpaqueBinary(bin: string): boolean {
	return OPAQUE_BINS.has(bin);
}

/**
 * Extract script source from an opaque invocation when possible.
 * Prefers inline `-c`/`-e` payloads, then script file contents, then heredoc bodies.
 */
export function extractOpaqueSource(command: string, analysis: Analysis, cwd: string): string | undefined {
	// Track the effective cwd by following `cd`/`pushd` so a script launched
	// after a cd (e.g. `cd /tmp && node t.mjs`) is found where it actually runs,
	// not under the session cwd.
	let curCwd = cwd;
	for (const seg of analysis.segments) {
		if ((seg.binary === "cd" || seg.binary === "pushd") && !seg.problem && seg.subcommand) {
			curCwd = resolveAgainst(seg.subcommand, curCwd);
			continue;
		}
		const src = sourceFromSegment(seg, curCwd);
		if (src) return src;
	}
	// Heredoc: python <<'EOF' ... EOF
	const heredoc = extractHeredoc(command);
	if (heredoc) return heredoc;
	return undefined;
}

function sourceFromSegment(seg: Segment, cwd: string): string | undefined {
	if (!seg.binary || !isOpaqueBinary(seg.binary)) return undefined;

	const inlineFlag = seg.flags.find((f) => INLINE_FLAGS.has(f));
	if (inlineFlag) {
		// Parser puts the script in subcommand or first arg after flags were stripped.
		const script = seg.subcommand ?? seg.args[0];
		if (script) return script;
	}

	// Script file: python script.py / bash other.sh
	const fileArg = firstScriptArg(seg);
	if (fileArg) {
		const full = resolveAgainst(fileArg, cwd);
		if (existsSync(full)) {
			try {
				return readFileSync(full, "utf8");
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

function firstScriptArg(seg: Segment): string | undefined {
	const candidates = [seg.subcommand, ...seg.args].filter((a): a is string => typeof a === "string");
	for (const a of candidates) {
		if (a.startsWith("-")) continue;
		return a;
	}
	return undefined;
}

function extractHeredoc(command: string): string | undefined {
	// Match: <<'TAG' or <<"TAG" or <<TAG ... newline ... TAG
	const open = /<<-?\s*(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\b/.exec(command);
	if (!open) return undefined;
	return open[3];
}
