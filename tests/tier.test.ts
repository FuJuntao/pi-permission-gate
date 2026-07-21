import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { decide } from "../src/pipeline.ts";
import { assignTier } from "../src/tier.ts";
import { isGitIgnored, isGitTracked } from "../src/git-paths.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { matchWildcard } from "../src/wildcard.ts";

describe("wildcard", () => {
	test("matches exact and star patterns", () => {
		assert.equal(matchWildcard("git status", "git status"), true);
		assert.equal(matchWildcard("git *", "git push origin main"), true);
		assert.equal(matchWildcard("git push *", "git status"), false);
	});
});

describe("tier + git context", () => {
	let root: string;

	before(() => {
		root = mkdtempSync(join(import.meta.dirname, "..", ".tmp-tier-"));
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(join(root, "tracked.txt"), "tracked\n");
		writeFileSync(join(root, "ignored.txt"), "ignored\n");
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(root, ".env"), "SECRET=1\n");
		execFileSync("git", ["-C", root, "add", "tracked.txt", ".gitignore"]);
	});

	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("detects tracked vs ignored", async () => {
		assert.equal(await isGitTracked(join(root, "tracked.txt"), root), true);
		assert.equal(await isGitTracked(join(root, "ignored.txt"), root), false);
		assert.equal(await isGitIgnored(join(root, "ignored.txt"), root), true);
	});

	test("assigns tiers from path context", async () => {
		const cfg = {
			...DEFAULT_CONFIG,
			allowedFiles: [`${root}/**`, "**/*"],
			protectedPaths: ["**/.env", "**/.env.*"],
		};

		assert.equal((await assignTier("update", [join(root, "tracked.txt")], cfg, root)).tier, "T2");
		assert.equal((await assignTier("update", [join(root, "ignored.txt")], cfg, root)).tier, "T1");
		assert.equal((await assignTier("delete", [join(root, ".env")], cfg, root)).tier, "T1");
		assert.equal((await assignTier("read", [join(root, "tracked.txt")], cfg, root)).tier, "T2");
	});

	test("tracked edit is T2 allow", async () => {
		const cfg = {
			...DEFAULT_CONFIG,
			allowedFiles: [`${root}/**`, "**/*"],
			protectedPaths: ["**/.env", "**/.env.*"],
		};
		const trackedEdit = await decide({
			tool: "edit",
			subject: "tracked.txt",
			ctx: { cwd: root, hasUI: false, isProjectTrusted: () => true } as never,
			loaded: {
				config: { ...cfg, mode: "default", audit: false, judgeModel: "", logPath: join(root, "gate.log") },
				globalPath: join(root, "permission-gate.json"),
			},
			cache: new Map(),
		});
		assert.equal(trackedEdit.verdict, "allow");
		assert.equal(trackedEdit.stage, "tier-t2");
		assert.equal(trackedEdit.op, "update");
	});
});
