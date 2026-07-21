import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
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
