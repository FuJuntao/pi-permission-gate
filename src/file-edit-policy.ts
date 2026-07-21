import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type FileEditAllowance = "git-tracked" | "session";

/**
 * Session-scoped policy for routine project-file edits.
 *
 * The interface deliberately accepts tool/path/cwd and hides path
 * canonicalization, symlink containment, Git lookup, and grant persistence.
 */
export class FileEditPolicy {
	private readonly sessionFiles = new Set<string>();

	/** Return why an edit can bypass the judge, or undefined when it cannot. */
	async allowance(tool: string, path: string, cwd: string): Promise<FileEditAllowance | undefined> {
		if (tool !== "edit") return undefined;
		const file = await secureProjectFile(path, cwd);
		if (!file) return undefined;
		if (this.sessionFiles.has(file.real)) return "session";
		if (await isGitTrackedRegularFile(file.real, cwd)) return "git-tracked";
		return undefined;
	}

	/**
	 * Remember a successfully mutated file. Returns the canonical path only when
	 * a new grant was added, allowing the caller to persist it in the session.
	 */
	async rememberSuccessfulMutation(tool: string, path: string, cwd: string): Promise<string | undefined> {
		if (tool !== "edit" && tool !== "write") return undefined;
		const file = await secureProjectFile(path, cwd);
		if (!file || this.sessionFiles.has(file.real)) return undefined;
		this.sessionFiles.add(file.real);
		return file.real;
	}

	/** Restore a canonical path previously emitted by rememberSuccessfulMutation. */
	restore(path: string): void {
		if (isAbsolute(path)) this.sessionFiles.add(resolve(path));
	}

	clear(): void {
		this.sessionFiles.clear();
	}
}

interface SecureProjectFile {
	real: string;
}

async function secureProjectFile(inputPath: string, cwd: string): Promise<SecureProjectFile | undefined> {
	try {
		const normalizedInput = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
		const projectRoot = await realpath(resolve(cwd));
		const lexicalPath = resolve(cwd, normalizedInput);
		const stat = await lstat(lexicalPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;

		const real = await realpath(lexicalPath);
		if (!isWithin(projectRoot, real)) return undefined;

		const projectRelative = relative(projectRoot, real);
		if (projectRelative.split(sep).includes(".git")) return undefined;
		return { real };
	} catch {
		return undefined;
	}
}

async function isGitTrackedRegularFile(file: string, cwd: string): Promise<boolean> {
	try {
		const rootOutput = await runGit(["rev-parse", "--show-toplevel"], cwd);
		const gitRoot = await realpath(rootOutput.trim());
		if (!isWithin(gitRoot, file)) return false;

		const relativePath = relative(gitRoot, file).split(sep).join("/");
		const output = await runGit(["ls-files", "--stage", "--error-unmatch", "--", `:(literal)${relativePath}`], gitRoot);
		const mode = /^(\d{6})\s/.exec(output)?.[1];
		return mode === "100644" || mode === "100755";
	} catch {
		return false;
	}
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

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
