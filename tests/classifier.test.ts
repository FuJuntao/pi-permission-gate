/**
 * Analyzer test suite: parser + classifier, fail-closed behavior,
 * hard blocks, config rules, protected paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "../src/analyzer/classifier.ts";
import { parse } from "../src/analyzer/shell-parser.ts";
import { matchHardBlock } from "../src/hard-blocks.ts";
import { matchConfigRules, matchProtectedPath } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

function expectClass(
	cmd: string,
	expected: "readonly" | "mutating" | "unknown",
) {
	test(`classify ${JSON.stringify(cmd)} → ${expected}`, () => {
		const a = classifyCommand(cmd);
		assert.equal(
			a.classification,
			expected,
			`got ${a.classification} (${a.note}); segments: ${JSON.stringify(
				a.segments.map((s) => ({
					bin: s.binary,
					sub: s.subcommand,
					flags: s.flags,
					args: s.args,
					problem: s.problem,
				})),
			)}`,
		);
	});
}

// ---------------- parser sanity ----------------

test("parse: simple command", () => {
	const { segments } = parse("git status");
	assert.equal(segments.length, 1);
	assert.equal(segments[0]!.binary, "git");
	assert.equal(segments[0]!.subcommand, "status");
});

test("parse: bundled flags split", () => {
	const { segments } = parse("rm -rf dist/");
	assert.deepEqual(segments[0]!.flags.sort(), ["-f", "-r"]);
	assert.deepEqual(segments[0]!.args, ["dist/"]);
});

test("parse: pipe splits segments", () => {
	const { segments, separators } = parse("cat foo | grep bar | wc -l");
	assert.equal(segments.length, 3);
	assert.deepEqual(separators, ["|", "|"]);
	assert.equal(segments[1]!.binary, "grep");
});

test("parse: && and ; separators", () => {
	const { segments, separators } = parse("npm test && git status; ls");
	assert.equal(segments.length, 3);
	assert.deepEqual(separators, ["&&", ";"]);
});

test("parse: write redirect captured", () => {
	const { segments } = parse("echo hello > out.txt");
	assert.equal(segments[0]!.redirects.length, 1);
	assert.equal(segments[0]!.redirects[0]!.kind, "write");
	assert.equal(segments[0]!.redirects[0]!.target, "out.txt");
});

test("parse: fd dup is not a write", () => {
	const { segments } = parse("make test 2>&1 | tail -5");
	const r = segments[0]!.redirects[0]!;
	assert.equal(r.kind, "fd-dup");
	assert.equal(r.writes, false);
});

test("parse: 2>&1 fd number not leaked as arg", () => {
	// Regression: the fd target (1) used to be lexed as a separate word and
	// became a spurious positional arg.
	const { segments } = parse("git check-ignore -v package-lock.json 2>&1");
	const seg = segments[0]!;
	assert.equal(seg.binary, "git");
	assert.equal(seg.subcommand, "check-ignore");
	assert.deepEqual(seg.args, ["package-lock.json"]);
	assert.equal(seg.redirects.length, 1);
	assert.equal(seg.redirects[0]!.kind, "fd-dup");
	assert.equal(seg.redirects[0]!.writes, false);
});

test("parse: 1>&2 and <&0 fd-dup", () => {
	const a = parse("cmd 1>&2").segments[0]!;
	assert.equal(a.redirects[0]!.kind, "fd-dup");
	assert.deepEqual(a.args, []);
	const b = parse("cmd <&0").segments[0]!;
	assert.equal(b.redirects[0]!.kind, "fd-dup");
	assert.deepEqual(b.args, []);
});

test("parse: quoted strings preserved", () => {
	const { segments } = parse(`grep "foo bar" 'baz qux'`);
	// grep: first positional (the pattern) becomes subcommand, second is an arg.
	assert.equal(segments[0]!.subcommand, "foo bar");
	assert.deepEqual(segments[0]!.args, ["baz qux"]);
});

test("parse: leading env assignment", () => {
	const { segments } = parse("FOO=bar NODE_ENV=test npm run build");
	assert.equal(segments[0]!.env.FOO, "bar");
	assert.equal(segments[0]!.env.NODE_ENV, "test");
	assert.equal(segments[0]!.binary, "npm");
});

test("parse: substitution collected", () => {
	const { segments } = parse("echo $(date +%Y)");
	assert.deepEqual(segments[0]!.substitutions, ["date +%Y"]);
});

test("parse: nested substitution", () => {
	const { segments } = parse("echo $(foo $(bar))");
	assert.deepEqual(segments[0]!.substitutions, ["foo $(bar)"]);
});

test("parse: heredoc fails closed", () => {
	const { problem } = parse("cat <<EOF\nhello\nEOF");
	assert.ok(problem?.includes("heredoc"));
});

test("parse: heredoc body not lexed as commands", () => {
	// Regression: the body used to be lexed as commands, so '(' / '{}' inside
	// it produced a misleading "unsupported grouping" error instead of the
	// accurate "heredoc" fail-closed result.
	const cases = [
		"cat > f.ts <<'EOF'\nconst { x } = loadConfig(process.cwd(), false);\nEOF",
		"cat <<EOF\nfoo(bar)\nEOF",
		"cat <<-EOF\n\tbody line\nEOF",
	];
	for (const c of cases) {
		const { problem } = parse(c);
		assert.ok(problem, `expected a problem for ${JSON.stringify(c)}`);
		assert.ok(
			problem!.includes("heredoc"),
			`expected 'heredoc' in problem, got: ${problem}`,
		);
		assert.ok(
			!problem!.includes("grouping"),
			`body should not be lexed; got: ${problem}`,
		);
	}
});

test("parse: heredoc body skipped so trailing command lexes", () => {
	// The body is skipped; the command after the delimiter is still parsed.
	// (parse() still bails the whole line on the heredoc redirect, so this only
	// confirms the body did not poison the lexer with a spurious error.)
	const { problem } = parse("cat <<'EOF'\nfoo(bar)\nEOF\necho hi");
	assert.ok(problem?.includes("heredoc"));
	assert.ok(!problem!.includes("grouping"));
});

test("parse: unterminated heredoc fails closed", () => {
	const { problem } = parse("cat <<EOF\nbody with no end");
	assert.ok(problem?.includes("heredoc"));
});

test("parse: unterminated quote fails closed", () => {
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
expectClass("git check-ignore -v package-lock.json 2>&1", "readonly");
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

expectClass('eval "$SCRIPT"', "unknown");
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
expectClass('echo "unterminated', "unknown");
expectClass("(cd /tmp && ls)", "unknown"); // grouping unsupported
expectClass("npm exec -- some-tool", "unknown"); // unlisted subcommand of mutating base
expectClass("git bisect start", "mutating");
expectClass("env FOO=1 node server.js", "unknown");

// ---------------- global flag before subcommand (e.g. `git -C <path>`) ----------------
// A value-taking global flag used to hide the subcommand, falling back to the
// readonly base (a false T2 allow for `git -C path push`). Re-derived now.
expectClass("git -C /repo push origin main", "mutating");
expectClass("git -C /repo commit -m wip", "mutating");
expectClass("git -C /repo add file.txt", "mutating");
expectClass("git -C /repo reset --hard", "mutating");
expectClass("git -C /repo status", "readonly");
expectClass("git -C /repo diff HEAD~3", "readonly");
expectClass("git -C /repo log --oneline", "readonly");
expectClass("git -C ~/repo show HEAD", "readonly");
expectClass("git -C /repo --git-dir=/x status", "readonly");

// ---------------- shell builtins & keywords (regression: used to be unknown -> T0) ----------------

// `cd` and other builtins must not taint an otherwise read-only compound command.
expectClass("cd /home/user/project && ls -la", "readonly");
expectClass("cd /tmp && echo hi && sed -n '1,10p' file.txt", "readonly");
expectClass("cd /home/user/project && grep -rn foo src/", "readonly");
expectClass("cd /home/user/project", "readonly");
expectClass("pushd /tmp && popd", "readonly");
expectClass("export FOO=bar && env", "readonly");

// `cd` does not hide mutations in sibling segments.
expectClass("cd /tmp && rm -rf build/", "mutating");
expectClass("cd /home/user/project && git push origin main", "mutating");

// Shell control keywords: the loop/cond body is analyzed, not the keyword.
expectClass("for f in a b c; do echo $f; done", "readonly");
expectClass("for f in a b c; do rm $f; done", "mutating");
expectClass("if grep -q foo file; then echo yes; fi", "readonly");
expectClass("if grep -q foo file; then rm file; fi", "mutating");
expectClass("while read line; do echo $line; done < input.txt", "readonly");
expectClass("{ rm -rf dist/; }", "mutating");
expectClass("{ echo hi; }", "readonly");

// `do`/`then` strip to the real command; bare keywords are readonly no-ops.
test("parse: do keyword strips to real command", () => {
	const { segments } = parse("do rm -rf dist/");
	assert.equal(segments[0]!.binary, "rm");
});
test("parse: if keyword strips to real command", () => {
	const { segments } = parse("if grep foo file");
	assert.equal(segments[0]!.binary, "grep");
});
test("parse: bare then is a readonly no-op binary", () => {
	const { segments } = parse("then");
	assert.equal(segments[0]!.binary, "then");
});

// ---------------- hard blocks ----------------

test("hard block: rm -rf /", () => assert.ok(matchHardBlock("rm -rf /")));
test("hard block: rm -rf /*", () => assert.ok(matchHardBlock("rm -rf /*")));
test("hard block: rm -rf ~", () => assert.ok(matchHardBlock("rm -rf ~")));
test("hard block: rm -rf $HOME", () =>
	assert.ok(matchHardBlock("rm -rf $HOME")));
test("hard block: rm -rf --no-preserve-root /", () =>
	assert.ok(matchHardBlock("rm -rf --no-preserve-root /")));
test("hard block: fork bomb", () => assert.ok(matchHardBlock(":(){ :|:& };:")));
test("hard block: fork bomb spaced", () =>
	assert.ok(matchHardBlock(": ( ) { : | : & } ; :")));
test("hard block: mkfs /dev/sda", () =>
	assert.ok(matchHardBlock("mkfs.ext4 /dev/sda1")));
test("hard block: dd of=/dev/nvme", () =>
	assert.ok(matchHardBlock("dd if=img.iso of=/dev/nvme0n1 bs=4M")));
test("hard block: redirect to /dev/sda", () =>
	assert.ok(matchHardBlock("cat img.iso > /dev/sda")));
test("hard block: shred device", () =>
	assert.ok(matchHardBlock("shred /dev/sdb")));

// these must NOT hard-block
test("no hard block: rm -rf dist/", () =>
	assert.equal(matchHardBlock("rm -rf dist/"), undefined));
test("no hard block: rm -rf /tmp/build", () =>
	assert.equal(matchHardBlock("rm -rf /tmp/build"), undefined));
test("no hard block: rm -rf ~/tmp", () =>
	assert.equal(matchHardBlock("rm -rf ~/tmp"), undefined));
test("no hard block: dd of=file.img", () =>
	assert.equal(matchHardBlock("dd if=/dev/zero of=file.img"), undefined));
test("no hard block: ls /", () =>
	assert.equal(matchHardBlock("ls /"), undefined));

// ---------------- config rules ----------------

test("config: deny beats allow", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		allow: ["git *"],
		deny: ["git push *--force*"],
	};
	assert.equal(matchConfigRules(cfg, "git status"), "allow");
	assert.equal(matchConfigRules(cfg, "git push origin --force"), "deny");
	assert.equal(matchConfigRules(cfg, "npm test"), undefined);
});

test("config: wildcard allow", () => {
	const cfg = { ...DEFAULT_CONFIG, allow: ["ls *"] };
	assert.equal(matchConfigRules(cfg, "ls -la"), "allow");
});

// ---------------- protected paths ----------------

test("protected: ~/.ssh covers subtree", () => {
	const home = process.env.HOME ?? "/home/user";
	assert.equal(matchProtectedPath(DEFAULT_CONFIG, "~/.ssh/id_rsa"), "~/.ssh");
	assert.equal(
		matchProtectedPath(DEFAULT_CONFIG, `${home}/.ssh/config`),
		"~/.ssh",
	);
});

test("protected: **/.env anywhere", () => {
	assert.equal(matchProtectedPath(DEFAULT_CONFIG, "/repo/app/.env"), "**/.env");
	assert.equal(
		matchProtectedPath(DEFAULT_CONFIG, "/repo/.env.production"),
		"**/.env.*",
	);
});

test("protected: normal project file is fine", () => {
	assert.equal(
		matchProtectedPath(DEFAULT_CONFIG, "/repo/src/index.ts"),
		undefined,
	);
});
