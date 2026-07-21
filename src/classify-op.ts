/**
 * Classify a gated tool call into CRUD + target paths.
 */

import { existsSync } from "node:fs";
import { classifyCommand } from "./analyzer/classifier.ts";
import { pathExistsAsFile, resolvePath } from "./git-paths.ts";
import { extractOpaqueSource, isOpaqueBinary } from "./opaque.ts";
import { resolveAgainst } from "./paths.ts";
import type { Analysis, OpKind, Segment } from "./types.ts";

const OP_RANK: Record<OpKind, number> = { delete: 3, update: 2, create: 1, read: 0 };

const READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const DELETE_BINS = new Set(["rm", "rmdir", "unlink", "shred", "wipefs", "blkdiscard"]);
const CREATE_BINS = new Set(["mkdir", "touch", "mktemp", "install", "truncate"]);

export interface Classification {
	op?: OpKind;
	paths: string[];
	analysis?: Analysis;
	/** Exact script/source for opaque interpreter launches. */
	opaqueSource?: string;
	note: string;
}

export async function classifyToolCall(tool: string, subject: string, cwd: string): Promise<Classification> {
	if (READONLY_TOOLS.has(tool)) {
		const paths = subject ? [resolveAgainst(subject, cwd)] : [];
		return { op: "read", paths, note: "read-only tool" };
	}

	if (tool === "edit") {
		const paths = [resolveAgainst(subject, cwd)];
		return { op: "update", paths, note: "edit tool" };
	}

	if (tool === "write") {
		const paths = [resolveAgainst(subject, cwd)];
		const exists = await pathExistsAsFile(subject, cwd);
		return { op: exists ? "update" : "create", paths, note: exists ? "write existing file" : "write new file" };
	}

	if (tool === "bash") {
		return classifyBash(subject, cwd);
	}

	// Unknown / custom tools: try to treat serialized input as opaque body.
	return {
		opaqueSource: subject,
		paths: [],
		note: "unknown tool — judge classifies kind from input",
	};
}

function classifyBash(subject: string, cwd: string): Classification {
	const analysis = classifyCommand(subject);

	if (analysis.classification === "unknown" || analysis.segments.some((s) => isOpaqueSegment(s))) {
		const opaqueSource = extractOpaqueSource(subject, analysis, cwd);
		if (opaqueSource) {
			return { analysis, opaqueSource, paths: pathsFromAnalysis(analysis, cwd), note: "opaque invocation" };
		}
		if (analysis.classification === "unknown") {
			return { analysis, paths: pathsFromAnalysis(analysis, cwd), note: analysis.note };
		}
	}

	let best: OpKind | undefined;
	const notes: string[] = [];
	for (const seg of analysis.segments) {
		const op = opFromSegment(seg);
		if (!op) continue;
		notes.push(`${seg.binary ?? "?"}→${op}`);
		if (!best || OP_RANK[op] > OP_RANK[best]) best = op;
	}

	// Write redirects imply at least update.
	for (const seg of analysis.segments) {
		for (const r of seg.redirects) {
			if (r.kind === "write" && !isDevNull(r.target)) {
				if (!best || OP_RANK.update > OP_RANK[best]) best = "update";
			}
		}
	}

	if (analysis.classification === "readonly") {
		return { op: "read", paths: pathsFromAnalysis(analysis, cwd), analysis, note: analysis.note };
	}

	if (!best && analysis.classification === "mutating") {
		best = "update";
	}

	return {
		op: best,
		paths: pathsFromAnalysis(analysis, cwd),
		analysis,
		note: notes.length ? notes.join("; ") : analysis.note,
	};
}

function isOpaqueSegment(seg: Segment): boolean {
	if (!seg.binary) return Boolean(seg.problem);
	if (isOpaqueBinary(seg.binary)) return true;
	if (["eval", "exec", "source", ".", "sudo", "su", "doas"].includes(seg.binary)) return true;
	return false;
}

function opFromSegment(seg: Segment): OpKind | undefined {
	if (seg.problem || !seg.binary) return undefined;
	const bin = seg.binary;

	if (DELETE_BINS.has(bin)) return "delete";
	if (bin === "git" && seg.subcommand === "rm") return "delete";
	if (bin === "git" && ["clean", "reset"].includes(seg.subcommand ?? "")) return "delete";

	if (CREATE_BINS.has(bin)) return "create";
	if (bin === "git" && seg.subcommand === "init") return "create";

	if (bin === "mv" || bin === "cp") return "update";
	if (bin === "sed" && (seg.flags.includes("-i") || seg.flags.includes("--in-place"))) return "update";
	if (bin === "git") {
		const sub = seg.subcommand ?? "";
		if (["status", "diff", "log", "show", "ls-files", "branch", "remote", "rev-parse", "describe", "blame", "grep"].includes(sub)) {
			return "read";
		}
		if (["add", "commit", "checkout", "switch", "restore", "stash", "rebase", "merge", "cherry-pick", "pull", "fetch", "push", "tag", "config"].includes(sub)) {
			return "update";
		}
	}

	// Known mutating from analyzer path without finer grain → update.
	return undefined;
}

function pathsFromAnalysis(analysis: Analysis, cwd: string): string[] {
	const paths: string[] = [];
	for (const seg of analysis.segments) {
		for (const r of seg.redirects) {
			if (r.kind === "write" && !isDevNull(r.target)) paths.push(resolveAgainst(r.target, cwd));
		}
		// Positional path-like args for common file ops.
		if (seg.binary && (DELETE_BINS.has(seg.binary) || CREATE_BINS.has(seg.binary) || seg.binary === "mv" || seg.binary === "cp" || seg.binary === "chmod" || seg.binary === "chown")) {
			for (const a of [...(seg.subcommand ? [seg.subcommand] : []), ...seg.args]) {
				if (a.startsWith("-")) continue;
				if (looksLikePath(a)) paths.push(resolveAgainst(a, cwd));
			}
		}
		if (seg.binary === "git" && seg.subcommand === "rm") {
			for (const a of seg.args) {
				if (!a.startsWith("-")) paths.push(resolveAgainst(a, cwd));
			}
		}
	}
	return [...new Set(paths)];
}

function looksLikePath(s: string): boolean {
	return s.includes("/") || s.includes(".") || s === ".." || !s.includes("=");
}

function isDevNull(target: string): boolean {
	return target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr" || target.startsWith("/dev/fd/");
}

/** Re-export for tests. */
export async function resolveExisting(path: string, cwd: string): Promise<string> {
	if (existsSync(resolveAgainst(path, cwd))) return resolvePath(path, cwd);
	return resolveAgainst(path, cwd);
}
