/**
 * Git path context: tracked vs ignored.
 */

import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { isWithin } from "./paths.ts";

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{ cwd, encoding: "utf8", timeout: 3_000, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				if (error) reject(error);
				else resolvePromise(stdout);
			},
		);
	});
}

async function gitRoot(cwd: string): Promise<string | undefined> {
	try {
		const out = await runGit(["rev-parse", "--show-toplevel"], cwd);
		return await realpath(out.trim());
	} catch {
		return undefined;
	}
}

/** Resolve to a real path when the file exists; otherwise lexical resolve. */
export async function resolvePath(inputPath: string, cwd: string): Promise<string> {
	const lexical = resolve(cwd, inputPath.startsWith("@") ? inputPath.slice(1) : inputPath);
	try {
		return await realpath(lexical);
	} catch {
		return lexical;
	}
}

export async function isGitTracked(filePath: string, cwd: string): Promise<boolean> {
	try {
		const root = await gitRoot(cwd);
		if (!root) return false;
		const file = await resolvePath(filePath, cwd);
		if (!isWithin(root, file) && file !== root) return false;

		const relativePath = relative(root, file).split(sep).join("/");
		if (!relativePath || relativePath.split("/").includes(".git")) return false;

		const output = await runGit(["ls-files", "--stage", "--error-unmatch", "--", `:(literal)${relativePath}`], root);
		const mode = /^(\d{6})\s/.exec(output)?.[1];
		// Tracked regular files, or any tracked entry (dirs via tree aren't listed this way).
		return Boolean(mode);
	} catch {
		return false;
	}
}

export async function isGitIgnored(filePath: string, cwd: string): Promise<boolean> {
	try {
		const root = await gitRoot(cwd);
		if (!root) return false;
		const file = await resolvePath(filePath, cwd);
		const relativePath = relative(root, file).split(sep).join("/");
		if (!relativePath || relativePath.startsWith("..")) return false;

		await runGit(["check-ignore", "-q", "--", relativePath], root);
		return true; // exit 0
	} catch {
		return false; // exit 1 = not ignored, or git missing
	}
}

/** True when path exists as a regular (non-symlink) file. */
export async function pathExistsAsFile(inputPath: string, cwd: string): Promise<boolean> {
	try {
		const lexical = resolve(cwd, inputPath.startsWith("@") ? inputPath.slice(1) : inputPath);
		const stat = await lstat(lexical);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}
