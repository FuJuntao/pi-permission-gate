/**
 * Path glob matching: `**` (any depth), `*` (within a segment), `?` (one char
 * in a segment), leading `~/`. A pattern without wildcards matches the path
 * itself or anything beneath it.
 */

import { resolve } from "node:path";
import { expandPath } from "./paths.ts";

export function matchPathGlob(patterns: string[], inputPath: string): string | undefined {
	const normalized = resolve(expandPath(inputPath));
	for (const raw of patterns) {
		const pattern = expandPath(raw);
		if (pathGlobMatch(pattern, normalized)) return raw;
	}
	return undefined;
}

export function pathGlobMatch(pattern: string, path: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) {
		return path === pattern || path.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
	}
	const pSegs = pattern.split("/").filter((s) => s !== "");
	const tSegs = path.split("/").filter((s) => s !== "");
	return matchSegs(pSegs, tSegs);
}

function matchSegs(p: string[], t: string[]): boolean {
	if (p.length === 0) return t.length === 0;
	const [head, ...rest] = p;
	if (head === "**") {
		if (matchSegs(rest, t)) return true;
		if (t.length > 0) return matchSegs(p, t.slice(1));
		return false;
	}
	if (t.length === 0) return false;
	if (!matchOne(head!, t[0]!)) return false;
	return matchSegs(rest, t.slice(1));
}

function matchOne(pattern: string, seg: string): boolean {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else re += escapeRe(c);
	}
	re += "$";
	return new RegExp(re).test(seg);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
