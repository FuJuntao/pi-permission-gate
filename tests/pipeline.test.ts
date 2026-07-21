import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { FileEditPolicy } from "../src/file-edit-policy.ts";
import { decide } from "../src/pipeline.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const logPath = "/tmp/pi-permission-gate-pipeline-test.log";
rmSync(logPath, { force: true });

function decideBash(subject: string) {
	return decide({
		tool: "bash",
		subject,
		ctx: { cwd: "/repo", hasUI: true, isProjectTrusted: () => true } as never,
		loaded: {
			config: { ...DEFAULT_CONFIG, mode: "observe", judgeModel: "", logPath },
			globalPath: "/tmp/permission-gate.json",
		},
		cache: new Map(),
		fileEditPolicy: new FileEditPolicy(),
	});
}

for (const subject of [
	"python3 - <<'PY'\nprint('ok')\nPY",
	"if rg -n 'x' .; then exit 1; else echo ok; fi",
]) {
	const decision = await decideBash(subject);
	assert.equal(decision.verdict, "allow");
	assert.equal(decision.stage, "observe");
	assert.equal(decision.wouldBe, undefined, "an async/pending judge verdict must not be reported as would-block");
}

let auditEntries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
assert.ok(auditEntries.every((entry) => entry.verdict === "allow" && entry.wouldBe === undefined));

const hardBlock = await decideBash("rm -rf /");
assert.equal(hardBlock.verdict, "block", "hard blocks must remain enforced in observe mode");
assert.equal(hardBlock.stage, "hard-block");
auditEntries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
assert.equal(auditEntries.at(-1)?.verdict, "block");
assert.equal(auditEntries.at(-1)?.stage, "hard-block");

rmSync(logPath, { force: true });
console.log("\n6 passed, 0 failed");
