/** Shared path helpers. */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function expandPath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function resolveAgainst(p: string, cwd: string): string {
	const expanded = expandPath(p);
	if (isAbsolute(expanded)) return resolve(expanded);
	return resolve(cwd, expanded);
}

export function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
