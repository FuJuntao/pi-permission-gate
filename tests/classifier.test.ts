/**
 * Analyzer test suite: parser + classifier, fail-closed behavior,
 * hard blocks, config rules, sensitive paths.
 *
 * Run: node --experimental-strip-types tests/classifier.test.ts
 * (or via: npm test)
 */

import assert from "node:assert/strict";
import { classifyCommand } from "../src/analyzer/classifier.ts";
import { parse } from "../src/analyzer/shell-parser.ts";
import { matchHardBlock } from "../src/hard-blocks.ts";
import { matchConfigRules, matchSensitivePath } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
	try {
		fn();
		passed++;
	} catch (e) {
		failed++;
		failures.push(`${name}: ${(e as Error).message}`);
	}
}

function expectClass(cmd: string, expected: "readonly" | "mutating" | "unknown") {
	check(`classify ${JSON.stringify(cmd)} → ${expected}`, () => {
		const a = classifyCommand(cmd);
		assert.equal(
			a.classification,
			expected,
			`got ${a.classification} (${a.note}); segments: ${JSON.stringify(
				a.segments.map((s) => ({ bin: s.binary, sub: s.subcommand, flags: s.flags, args: s.args, problem: s.problem })),
			)}`,
		);
	});
}

// ---------------- parser sanity ----------------

check("parse: simple command", () => {
	const { segments } = parse("git status");
	assert.equal(segments.length, 1);
	assert.equal(segments[0]!.binary, "git");
	assert.equal(segments[0]!.subcommand, "status");
});

check("parse: bundled flags split", () => {
	const { segments } = parse("rm -rf dist/");
	assert.deepEqual(segments[0]!.flags.sort(), ["-f", "-r"]);
	assert.deepEqual(segments[0]!.args, ["dist/"]);
});

check("parse: pipe splits segments", () => {
	const { segments, separators } = parse("cat foo | grep bar | wc -l");
	assert.equal(segments.length, 3);
	assert.deepEqual(separators, ["|", "|"]);
	assert.equal(segments[1]!.binary, "grep");
});

check("parse: && and ; separators", () => {
	const { segments, separators } = parse("npm test && git status; ls");
	assert.equal(segments.length, 3);
	assert.deepEqual(separators, ["&&", ";"]);
});

check("parse: write redirect captured", () => {
	const { segments } = parse("echo hello > out.txt");
	assert.equal(segments[0]!.redirects.length, 1);
	assert.equal(segments[0]!.redirects[0]!.kind, "write");
	assert.equal(segments[0]!.redirects[0]!.target, "out.txt");
});

check("parse: fd dup is not a write", () => {
	const { segments } = parse("make test 2>&1 | tail -5");
	const r = segments[0]!.redirects[0]!;
	assert.equal(r.kind, "fd-dup");
	assert.equal(r.writes, false);
});

check("parse: quoted strings preserved", () => {
	const { segments } = parse(`grep "foo bar" 'baz qux'`);
	// grep: first positional (the pattern) becomes subcommand, second is an arg.
	assert.equal(segments[0]!.subcommand, "foo bar");
	assert.deepEqual(segments[0]!.args, ["baz qux"]);
});

check("parse: leading env assignment", () => {
	const { segments } = parse("FOO=bar NODE_ENV=test npm run build");
	assert.equal(segments[0]!.env.FOO, "bar");
	assert.equal(segments[0]!.env.NODE_ENV, "test");
	assert.equal(segments[0]!.binary, "npm");
});

check("parse: substitution collected", () => {
	const { segments } = parse("echo $(date +%Y)");
	assert.deepEqual(segments[0]!.substitutions, ["date +%Y"]);
});

check("parse: nested substitution", () => {
	const { segments } = parse("echo $(foo $(bar))");
	assert.deepEqual(segments[0]!.substitutions, ["foo $(bar)"]);
});

check("parse: heredoc fails closed", () => {
	const { problem } = parse("cat <<EOF\nhello\nEOF");
	assert.ok(problem?.includes("heredoc"));
});

check("parse: unterminated quote fails closed", () => {
	const { problem } = parse(`echo "foo`);
	assert.ok(problem?.includes("unterminated"));
});

// ---------------- classifier: read-only ----------------

expectClass("ls -la", "readonly");
expectClass("git status", "readonly");
expectClass("git diff HEAD~3 --stat", "readonly");
expectClass("git log --oneline -20", "readonly");
expectClass("cat package.json", "readonly");
expectClass("grep -rn 'foo' src/", "readonly");
expectClass("rg --files | head -20", "readonly");
expectClass("cat foo | grep bar | wc -l", "readonly");
expectClass("find . -name '*.ts' -type f", "readonly");
expectClass("git rev-parse HEAD", "readonly");
expectClass("gh pr view 123", "readonly");
expectClass("gh issue list --limit 10", "readonly");
expectClass("docker ps -a", "readonly");
expectClass("kubectl get pods -n default", "readonly");
expectClass("npm ls --depth=0", "readonly");
expectClass("curl -s https://api.github.com/repos/foo/bar", "readonly");
expectClass("terraform plan -no-color", "readonly");
expectClass("tar -tf archive.tar.gz", "readonly");
expectClass("tar tf archive.tar", "readonly");
expectClass("make test 2>&1 | tail -5", "mutating"); // make runs recipes (mutating)
expectClass("git stash list", "readonly");
expectClass("echo $(date)", "readonly");
expectClass("jq '.dependencies' package.json", "readonly");
expectClass("FOO=bar env", "readonly");

// ---------------- classifier: mutating ----------------

expectClass("rm -rf dist/", "mutating");
expectClass("git push origin main", "mutating");
expectClass("git clean -fdx", "mutating");
expectClass("git commit -am 'wip'", "mutating");
expectClass("git checkout -b feature", "mutating");
expectClass("npm install", "mutating");
expectClass("npm run build", "mutating");
expectClass("echo hello > out.txt", "mutating");
expectClass("echo hello >> out.txt", "mutating");
expectClass("sed -i 's/a/b/' file.txt", "mutating");
expectClass("find . -name '*.log' -delete", "mutating");
expectClass("mkdir -p dist", "mutating");
expectClass("docker compose up -d", "mutating");
expectClass("kubectl apply -f deploy.yaml", "mutating");
expectClass("tar -cf out.tar src/", "mutating");
expectClass("cargo build --release", "mutating");
expectClass("curl -o file.zip https://example.com/f.zip", "mutating");
expectClass("wget -O index.html https://example.com", "mutating");
expectClass("chmod +x script.sh", "mutating");
expectClass("ls > /tmp/files.txt", "mutating");
expectClass("sort -o sorted.txt data.txt", "mutating");

// substitution with a mutating inner command poisons the outer
expectClass("echo $(rm -rf dist/)", "mutating");
expectClass("cat `touch sentinel`", "mutating");
expectClass("echo hi && rm -rf dist/", "mutating");
expectClass("ls; npm publish", "mutating");

// ---------------- classifier: unknown (fail closed) ----------------

expectClass("eval \"$SCRIPT\"", "unknown");
expectClass("bash -c 'rm -rf dist/'", "mutating"); // -c body is analyzed
expectClass("bash -c 'some opaque string with spaces and $VARS'", "unknown");
expectClass("source ~/.bashrc", "unknown");
expectClass("xargs rm < list.txt", "unknown");
expectClass("sudo systemctl restart nginx", "unknown");
expectClass("some-random-binary --flag", "unknown");
expectClass("node -e 'console.log(1)'", "unknown");
expectClass("python3 -c 'print(1)'", "unknown");
expectClass("perl -pe 's/a/b/' file", "unknown");
expectClass("ssh user@host 'uptime'", "unknown");
expectClass("cat <<EOF\nhi\nEOF", "unknown"); // heredoc unsupported
expectClass("echo \"unterminated", "unknown");
expectClass("(cd /tmp && ls)", "unknown"); // grouping unsupported
expectClass("npm exec -- some-tool", "unknown"); // unlisted subcommand of mutating base
expectClass("git bisect start", "mutating");
expectClass("env FOO=1 node server.js", "unknown");

// ---------------- hard blocks ----------------

check("hard block: rm -rf /", () => assert.ok(matchHardBlock("rm -rf /")));
check("hard block: rm -rf /*", () => assert.ok(matchHardBlock("rm -rf /*")));
check("hard block: rm -rf ~", () => assert.ok(matchHardBlock("rm -rf ~")));
check("hard block: rm -rf $HOME", () => assert.ok(matchHardBlock("rm -rf $HOME")));
check("hard block: rm -rf --no-preserve-root /", () => assert.ok(matchHardBlock("rm -rf --no-preserve-root /")));
check("hard block: fork bomb", () => assert.ok(matchHardBlock(":(){ :|:& };:")));
check("hard block: fork bomb spaced", () => assert.ok(matchHardBlock(": ( ) { : | : & } ; :")));
check("hard block: mkfs /dev/sda", () => assert.ok(matchHardBlock("mkfs.ext4 /dev/sda1")));
check("hard block: dd of=/dev/nvme", () => assert.ok(matchHardBlock("dd if=img.iso of=/dev/nvme0n1 bs=4M")));
check("hard block: redirect to /dev/sda", () => assert.ok(matchHardBlock("cat img.iso > /dev/sda")));
check("hard block: shred device", () => assert.ok(matchHardBlock("shred /dev/sdb")));

// these must NOT hard-block
check("no hard block: rm -rf dist/", () => assert.equal(matchHardBlock("rm -rf dist/"), undefined));
check("no hard block: rm -rf /tmp/build", () => assert.equal(matchHardBlock("rm -rf /tmp/build"), undefined));
check("no hard block: rm -rf ~/tmp", () => assert.equal(matchHardBlock("rm -rf ~/tmp"), undefined));
check("no hard block: dd of=file.img", () => assert.equal(matchHardBlock("dd if=/dev/zero of=file.img"), undefined));
check("no hard block: ls /", () => assert.equal(matchHardBlock("ls /"), undefined));

// ---------------- config rules ----------------

check("config: deny beats allow", () => {
	const cfg = { ...DEFAULT_CONFIG, allow: ["^git"], deny: ["push.*--force"] };
	assert.equal(matchConfigRules(cfg, "git status"), "allow");
	assert.equal(matchConfigRules(cfg, "git push --force"), "deny");
	assert.equal(matchConfigRules(cfg, "npm test"), undefined);
});

check("config: invalid regex skipped at load", () => {
	// direct call with a bad pattern should throw — validateRegexes guards at load;
	// here we just confirm valid usage works.
	const cfg = { ...DEFAULT_CONFIG, allow: ["^ls\\b"] };
	assert.equal(matchConfigRules(cfg, "ls -la"), "allow");
});

// ---------------- sensitive paths ----------------

check("sensitive: ~/.ssh covers subtree", () => {
	assert.equal(matchSensitivePath(DEFAULT_CONFIG.sensitivePaths, "~/.ssh/id_rsa"), "~/.ssh");
	assert.equal(matchSensitivePath(DEFAULT_CONFIG.sensitivePaths, "/home/fujuntao/.ssh/config"), "~/.ssh");
});

check("sensitive: **/.env anywhere", () => {
	assert.equal(matchSensitivePath(DEFAULT_CONFIG.sensitivePaths, "/repo/app/.env"), "**/.env");
	assert.equal(matchSensitivePath(DEFAULT_CONFIG.sensitivePaths, "/repo/.env.production"), "**/.env.*");
});

check("sensitive: normal project file is fine", () => {
	assert.equal(matchSensitivePath(DEFAULT_CONFIG.sensitivePaths, "/repo/src/index.ts"), undefined);
});

// ---------------- summary ----------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log("\nFailures:");
	for (const f of failures) console.log("  ✗ " + f);
	process.exit(1);
}
