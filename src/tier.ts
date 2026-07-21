/**
 * Assign T0 / T1 / T2 from op kind + path context.
 */

import type { GateConfig, OpKind, Tier } from "./types.ts";
import { matchAllowedFile, matchProtectedPath } from "./config.ts";
import { isGitIgnored, isGitTracked } from "./git-paths.ts";

export interface TierResult {
	tier: Tier;
	reason: string;
}

/**
 * Path tiering for U/D (first match wins):
 *   protected → T1
 *   gitignored → T1
 *   allowedFiles + git-tracked → T2
 *   else → T0
 *
 * C/R: allowedFiles match → T2, else T0.
 * No op / no paths → T0.
 */
export async function assignTier(
	op: OpKind | undefined,
	paths: string[],
	config: GateConfig,
	cwd: string,
): Promise<TierResult> {
	if (!op) {
		return { tier: "T0", reason: "unresolved operation kind" };
	}

	if (op === "read" || op === "create") {
		if (paths.length === 0) {
			// Bash reads with no path args (e.g. git status) — treat as allowed.
			return { tier: "T2", reason: `${op} with no file targets` };
		}
		const allAllowed = paths.every((p) => matchAllowedFile(config, p));
		if (allAllowed) return { tier: "T2", reason: `${op} matches allowedFiles` };
		return { tier: "T0", reason: `${op} outside allowedFiles` };
	}

	// update / delete
	if (paths.length === 0) {
		return { tier: "T0", reason: `${op} with no resolvable paths` };
	}

	// Most restrictive tier among paths (T0 > T1 > T2).
	let worst: TierResult = { tier: "T2", reason: "" };
	for (const p of paths) {
		const one = await tierForMutationPath(op, p, config, cwd);
		if (tierRank(one.tier) > tierRank(worst.tier)) worst = one;
	}
	return worst;
}

async function tierForMutationPath(op: OpKind, path: string, config: GateConfig, cwd: string): Promise<TierResult> {
	if (matchProtectedPath(config, path)) {
		return { tier: "T1", reason: `${op} on protected path` };
	}
	if (await isGitIgnored(path, cwd)) {
		return { tier: "T1", reason: `${op} on gitignored path` };
	}
	if (matchAllowedFile(config, path) && (await isGitTracked(path, cwd))) {
		return { tier: "T2", reason: `${op} on allowed + git-tracked path` };
	}
	return { tier: "T0", reason: `${op} on untracked/outside path` };
}

function tierRank(t: Tier): number {
	return t === "T0" ? 2 : t === "T1" ? 1 : 0;
}
