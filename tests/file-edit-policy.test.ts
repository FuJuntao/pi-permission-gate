import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEditPolicy } from "../src/file-edit-policy.ts";
import { decide } from "../src/pipeline.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const root = mkdtempSync(join(tmpdir(), "pi-permission-gate-policy-"));
const outside = mkdtempSync(join(tmpdir(), "pi-permission-gate-outside-"));
try {
	execFileSync("git", ["init", "-q", root]);
	writeFileSync(join(root, "tracked.txt"), "tracked\n");
	writeFileSync(join(root, "untracked.txt"), "untracked\n");
	writeFileSync(join(outside, "secret.txt"), "secret\n");
	symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
	execFileSync("git", ["-C", root, "add", "tracked.txt"]);

	const policy = new FileEditPolicy();
	assert.equal(await policy.allowance("edit", "tracked.txt", root), "git-tracked");
	assert.equal(await policy.allowance("write", "tracked.txt", root), undefined, "write must not inherit the edit allowance");
	assert.equal(await policy.allowance("edit", "untracked.txt", root), undefined);
	assert.equal(await policy.allowance("edit", "escape.txt", root), undefined, "symlinks must not be auto-allowed");
	assert.equal(await policy.allowance("edit", join(outside, "secret.txt"), root), undefined, "out-of-project paths must not be auto-allowed");

	const remembered = await policy.rememberSuccessfulMutation("write", "untracked.txt", root);
	assert.equal(remembered, realpathSync(join(root, "untracked.txt")));
	assert.equal(await policy.allowance("edit", "untracked.txt", root), "session");
	assert.equal(await policy.rememberSuccessfulMutation("read", "tracked.txt", root), undefined, "reads must not grant edit permission");
	assert.equal(await policy.rememberSuccessfulMutation("write", "escape.txt", root), undefined);

	const restored = new FileEditPolicy();
	restored.restore(remembered!);
	assert.equal(await restored.allowance("edit", "untracked.txt", root), "session", "session grants must survive extension reload");

	const decideEdit = (
		path: string,
		fileEditPolicy: FileEditPolicy,
		sensitivePaths = DEFAULT_CONFIG.sensitivePaths,
		trusted = true,
	) =>
		decide({
			tool: "edit",
			subject: path,
			ctx: { cwd: root, hasUI: false, isProjectTrusted: () => trusted } as never,
			loaded: {
				config: { ...DEFAULT_CONFIG, mode: "strict", sensitivePaths, logPath: join(root, "gate.log") },
				globalPath: join(root, "permission-gate.json"),
			},
			cache: new Map(),
			fileEditPolicy,
		});

	const trackedDecision = await decideEdit("tracked.txt", policy);
	assert.equal(trackedDecision.stage, "git-tracked-edit");
	assert.equal(trackedDecision.verdict, "allow");
	const sessionDecision = await decideEdit("untracked.txt", policy);
	assert.equal(sessionDecision.stage, "session-edit");
	assert.equal(sessionDecision.verdict, "allow");
	const sensitiveDecision = await decideEdit("tracked.txt", policy, [join(root, "tracked.txt")]);
	assert.equal(sensitiveDecision.stage, "config-deny", "sensitive paths must take precedence over tracked edits");
	assert.equal(sensitiveDecision.verdict, "block");
	const untrustedDecision = await decideEdit("tracked.txt", policy, DEFAULT_CONFIG.sensitivePaths, false);
	assert.equal(untrustedDecision.stage, "no-ui", "untrusted projects must not use automatic edit allowances");
	assert.equal(untrustedDecision.verdict, "block");

	restored.clear();
	assert.equal(await restored.allowance("edit", "untracked.txt", root), undefined);

	console.log("\n19 passed, 0 failed");
} finally {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
}
