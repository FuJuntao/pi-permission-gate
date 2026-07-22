import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { decide } from "../src/pipeline.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const logPath = "/tmp/pi-permission-gate-pipeline-test.log";

function decideBash(subject: string, overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
	return decide({
		tool: "bash",
		subject,
		ctx: { cwd: "/repo", hasUI: true, isProjectTrusted: () => true } as never,
		loaded: {
			config: { ...DEFAULT_CONFIG, mode: "default", dryRun: true, audit: true, judgeModel: "", logPath, ...overrides },
			globalPath: "/tmp/permission-gate.json",
		},
		cache: new Map(),
	});
}

describe("pipeline", () => {
	before(() => {
		rmSync(logPath, { force: true });
	});

	after(() => {
		rmSync(logPath, { force: true });
	});

	test("dry-run allows readonly commands as T2", async () => {
		for (const subject of ["git status", "ls -la"]) {
			const decision = await decideBash(subject);
			assert.equal(decision.verdict, "allow");
			assert.equal(decision.op, "read");
			assert.equal(decision.tier, "T2");
		}
	});

	test("mode off is passthrough", async () => {
		const decision = await decideBash("rm -rf /tmp/foo", { mode: "off", dryRun: false });
		assert.equal(decision.verdict, "allow");
		assert.equal(decision.stage, "off");
	});

	test("hard blocks remain enforced in dry-run", async () => {
		const hardBlock = await decideBash("rm -rf /");
		assert.equal(hardBlock.verdict, "block");
		assert.equal(hardBlock.stage, "hard-block");

		const auditEntries = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(auditEntries.at(-1)?.verdict, "block");
		assert.equal(auditEntries.at(-1)?.stage, "hard-block");
	});

	test("auto mode auto-denies T0", async () => {
		const decision = await decide({
			tool: "read",
			subject: "/etc/passwd",
			ctx: { cwd: "/repo", hasUI: true, isProjectTrusted: () => true } as never,
			loaded: {
				config: {
					...DEFAULT_CONFIG,
					mode: "auto",
					allowedFiles: ["/repo/**"],
					audit: false,
					judgeModel: "",
					logPath,
				},
				globalPath: "/tmp/permission-gate.json",
			},
			cache: new Map(),
		});
		assert.equal(decision.verdict, "block");
		assert.equal(decision.tier, "T0");
		assert.equal(decision.stage, "tier-t0");
	});
});

describe("auto-mode resolution (regression: cd/keywords no longer T0)", () => {
	let root: string;

	before(() => {
		root = mkdtempSync(join(import.meta.dirname, ".tmp-pipeline-"));
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(join(root, "tracked.txt"), "tracked\n");
		execFileSync("git", ["-C", root, "add", "tracked.txt"]);
	});

	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function decideAuto(subject: string) {
		return decide({
			tool: "bash",
			subject,
			ctx: { cwd: root, hasUI: false, isProjectTrusted: () => true } as never,
			loaded: {
				config: { ...DEFAULT_CONFIG, mode: "auto", audit: false, judgeModel: "", logPath: join(root, "gate.log") },
				globalPath: "/tmp/permission-gate.json",
			},
			cache: new Map(),
		});
	}

	test("cd + read-only compound -> T2 allow (was T0 'unresolved operation kind')", async () => {
		const d = await decideAuto(`cd ${root} && echo hi && sed -n '1,5p' tracked.txt`);
		assert.equal(d.verdict, "allow");
		assert.equal(d.tier, "T2");
		assert.equal(d.op, "read");
	});

	test("for/do/done read-only loop -> T2 allow (was T0)", async () => {
		const d = await decideAuto(`cd ${root} && for f in tracked.txt; do echo $f; done`);
		assert.equal(d.verdict, "allow");
		assert.equal(d.tier, "T2");
		assert.equal(d.op, "read");
	});

	test("cd does not hide a mutating sibling", async () => {
		const d = await decideAuto(`cd ${root} && rm tracked.txt`);
		// rm of a tracked file inside the project -> delete on allowed+tracked -> T2
		assert.equal(d.op, "delete");
		assert.equal(d.tier, "T2");
		assert.equal(d.verdict, "allow");
	});

	test("git add <tracked file> -> T2 (was 'update with no resolvable paths' -> T0)", async () => {
		const d = await decideAuto(`cd ${root} && git add tracked.txt`);
		assert.equal(d.op, "update");
		assert.equal(d.tier, "T2");
		assert.equal(d.verdict, "allow");
	});

	test("for loop with mutating body still resolves op (not 'unresolved')", async () => {
		const d = await decideAuto(`cd ${root} && for f in tracked.txt; do rm $f; done`);
		assert.equal(d.op, "delete");
		// rm $f: $f isn't a static path, so no resolvable path -> T0 (by design),
		// but the op IS resolved (delete), not 'unresolved operation kind'.
		assert.notEqual(d.reason, "T0 auto-deny: unresolved operation kind");
	});
});

describe("disposable paths (e.g. /tmp)", () => {
	function decideAuto(subject: string, cwd = "/home/user/project") {
		return decide({
			tool: "bash",
			subject,
			ctx: { cwd, hasUI: false, isProjectTrusted: () => true } as never,
			loaded: {
				config: { ...DEFAULT_CONFIG, mode: "auto", audit: false, judgeModel: "", logPath: "/tmp/pg-disposable-test.log" },
				globalPath: "/tmp/permission-gate.json",
			},
			cache: new Map(),
		});
	}

	test("rm of absolute /tmp path -> T2 (was 'delete on untracked/outside')", async () => {
		const d = await decideAuto("rm -rf /tmp/some-build");
		assert.equal(d.op, "delete");
		assert.equal(d.tier, "T2");
		assert.equal(d.verdict, "allow");
	});

	test("cd /tmp && rm <relative> -> T2 via cwd tracking + disposable", async () => {
		const d = await decideAuto("cd /tmp && rm -rf watchtower-src");
		assert.equal(d.op, "delete");
		assert.equal(d.tier, "T2");
		assert.equal(d.verdict, "allow");
	});

	test("write redirect into /tmp -> T2", async () => {
		const d = await decideAuto("echo hi > /tmp/out.txt");
		assert.equal(d.op, "update");
		assert.equal(d.tier, "T2");
		assert.equal(d.verdict, "allow");
	});

	test("rm -rf /tmp itself stays gated (root is not disposable)", async () => {
		const d = await decideAuto("rm -rf /tmp");
		// /tmp (the dir itself) is excluded from disposable; not tracked -> T0.
		assert.equal(d.tier, "T0");
		assert.equal(d.verdict, "block");
	});

	test("mutation outside /tmp still gates (e.g. /etc)", async () => {
		const d = await decideAuto("rm -f /etc/foo");
		assert.equal(d.tier, "T0");
		assert.equal(d.verdict, "block");
	});
});
