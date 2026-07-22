/**
 * Fail-closed shell command parser.
 *
 * Deliberately bounded: it understands a useful subset of shell grammar
 * (words, quoting, escapes, pipelines/lists, redirections, substitutions,
 * leading VAR=val assignments) and marks anything outside that subset with
 * `problem` so the classifier treats it as unknown rather than guessing.
 *
 * Security invariant: NEVER silently drop constructs. Every character of
 * input is accounted for — either modeled in a Segment or flagged.
 */

import type { Redirect, Segment } from "../types.ts";

const SHELL_OPERATORS = new Set(["|", "||", "&&", ";", "&"]);

interface LexToken {
	/** Word text with quotes removed and escapes resolved. */
	text: string;
	/** Operator string when the token is an operator. */
	op?: string;
	/** Raw source text of the token (quotes intact). */
	raw: string;
	/** Substitution bodies found inside this token. */
	subs: string[];
	/** True when any part of the word was quoted. */
	quoted: boolean;
	/** Set when this token encodes an attached redirection target. */
	redir?: { kind: Redirect["kind"]; target: string };
}

interface LexResult {
	tokens: LexToken[];
	problem?: string;
}

/**
 * Expand a substitution body recursively: returns problem string if the body
 * itself fails to lex (kept shallow — the classifier re-analyzes bodies via
 * parse()).
 */
function lex(input: string): LexResult {
	const tokens: LexToken[] = [];
	let i = 0;
	const n = input.length;
	// Heredocs whose bodies must be skipped at the next newline (the body lives
	// on following lines and would otherwise be lexed as commands).
	const pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

	while (i < n) {
		// Newline: consume any pending heredoc bodies before resuming lexing.
		if (input[i] === "\n") {
			i += 1;
			if (pendingHeredocs.length) {
				for (const hd of pendingHeredocs) {
					const r = skipHeredocBody(input, i, hd.delim, hd.stripTabs);
					if (r.problem) return { tokens, problem: r.problem };
					i = r.i;
				}
				pendingHeredocs.length = 0;
			}
			continue;
		}
		// Skip whitespace and line continuations.
		if (input[i] === " " || input[i] === "\t" || (input[i] === "\\" && input[i + 1] === "\n")) {
			i += input[i] === "\\" ? 2 : 1;
			continue;
		}

		// Comments: # at start of a word runs to end of line.
		if (input[i] === "#") {
			while (i < n && input[i] !== "\n") i++;
			continue;
		}

		// Operators and redirections.
		const two = input.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			tokens.push({ text: two, op: two, raw: two, subs: [], quoted: false });
			i += 2;
			continue;
		}
		if (input[i] === "|" || input[i] === ";" || input[i] === "&") {
			const op = input[i]!;
			tokens.push({ text: op, op, raw: op, subs: [], quoted: false });
			i += 1;
			continue;
		}

		// Redirections: [n]> [n]>> [n]< << <<< >&n <&n &> &>>
		const redir = matchRedirection(input, i);
		if (redir) {
			const kind = redirectKind(redir.text);
			if (kind === "heredoc" && redir.text !== "<<<") {
				// Heredoc: read the delimiter now and queue the body for skipping
				// at the next newline. The body lives on following lines and must
				// not be lexed as commands (it may contain (){}$() etc.).
				const stripTabs = redir.text === "<<-";
				const dl = readHeredocDelim(input, i + redir.length);
				if (dl.problem) return { tokens, problem: dl.problem };
				pendingHeredocs.push({ delim: dl.delim, stripTabs });
				tokens.push({ text: redir.text + dl.raw, op: "REDIR", raw: redir.text + dl.raw, subs: [], quoted: false });
				i += redir.length + dl.length;
			} else {
				tokens.push({ text: redir.text, op: "REDIR", raw: redir.text, subs: [], quoted: false });
				i += redir.length;
			}
			continue;
		}

		// A word: consume until whitespace/operator, honoring quotes/escapes/subs.
		const word = matchWord(input, i);
		if (word.problem) return { tokens, problem: word.problem };
		if (word.length === 0) {
			return { tokens, problem: `unexpected character '${input[i]}' at offset ${i}` };
		}
		tokens.push({ text: word.text, raw: word.raw, subs: word.subs, quoted: word.quoted ?? false });
		i += word.length;
	}

	return { tokens };
}

interface RedirMatch {
	text: string;
	length: number;
}

function matchRedirection(input: string, start: number): RedirMatch | undefined {
	let i = start;
	// Optional fd prefix: 2> 1>&2
	const fdMatch = /^[0-9]+/.exec(input.slice(i));
	let fdPrefix = "";
	if (fdMatch && (input[i + fdMatch[0].length] === ">" || input[i + fdMatch[0].length] === "<")) {
		fdPrefix = fdMatch[0];
		i += fdMatch[0].length;
	}
	const rest = input.slice(i);
	let m: RegExpExecArray | null;
	if ((m = /^&>>/.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^&>/.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^>>\|?/.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^>&(?:[-0-9]*)/.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^>\|?/.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^<<</.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^<<-?/.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^<&(?:[-0-9]*)/.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	if ((m = /^</.exec(rest))) return { text: fdPrefix + m[0], length: fdPrefix.length + m[0].length };
	return fdPrefix ? undefined : undefined;
}

interface WordMatch {
	text: string;
	raw: string;
	length: number;
	subs: string[];
	quoted?: boolean;
	problem?: string;
}

/**
 * Consume one shell word starting at `start`. Resolves quotes and escapes,
 * collects substitution bodies (without expanding them).
 */
function matchWord(input: string, start: number): WordMatch {
	let i = start;
	const n = input.length;
	let text = "";
	let raw = "";
	const subs: string[] = [];

	while (i < n) {
		const c = input[i]!;
		// Word terminators (unquoted).
		if (c === " " || c === "\t" || c === "\n" || c === "|" || c === ";" || c === "&" || c === "<" || c === ">" || c === "#") {
			break;
		}
		if (c === "\\") {
			if (i + 1 >= n) return { text, raw, length: i - start, subs, problem: "trailing backslash" };
			text += input[i + 1];
			raw += input.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) return { text, raw, length: i - start, subs, problem: "unterminated single quote" };
			text += input.slice(i + 1, end);
			raw += input.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let ok = false;
			while (j < n) {
				const d = input[j]!;
				if (d === "\\") {
					text += input[j + 1] ?? "";
					raw += input.slice(j, j + 2);
					j += 2;
					continue;
				}
				if (d === '"') {
					ok = true;
					j += 1;
					break;
				}
				if (d === "$" && input[j + 1] === "(") {
					const sub = extractSubstitution(input, j);
					if (sub.problem) return { text, raw, length: i - start, subs, problem: sub.problem };
					subs.push(sub.body);
					text += "$(" + sub.body + ")";
					raw += input.slice(j, j + sub.length);
					j += sub.length;
					continue;
				}
				if (d === "`") {
					const sub = extractBacktick(input, j);
					if (sub.problem) return { text, raw, length: i - start, subs, problem: sub.problem };
					subs.push(sub.body);
					text += "`" + sub.body + "`";
					raw += input.slice(j, j + sub.length);
					j += sub.length;
					continue;
				}
				text += d;
				raw += d;
				j += 1;
			}
			if (!ok) return { text, raw, length: i - start, subs, problem: "unterminated double quote" };
			i = j;
			continue;
		}
		if (c === "$" && input[i + 1] === "(") {
			const sub = extractSubstitution(input, i);
			if (sub.problem) return { text, raw, length: i - start, subs, problem: sub.problem };
			subs.push(sub.body);
			text += "$(" + sub.body + ")";
			raw += input.slice(i, i + sub.length);
			i += sub.length;
			continue;
		}
		if (c === "`") {
			const sub = extractBacktick(input, i);
			if (sub.problem) return { text, raw, length: i - start, subs, problem: sub.problem };
			subs.push(sub.body);
			text += "`" + sub.body + "`";
			raw += input.slice(i, i + sub.length);
			i += sub.length;
			continue;
		}
		if (c === "(" || c === ")") {
			// Subshell/grouping outside a substitution — not in our subset.
			return { text, raw, length: i - start, subs, problem: `unsupported grouping '${c}'` };
		}
		text += c;
		raw += c;
		i += 1;
	}

	return { text, raw, length: i - start, subs };
}

interface SubMatch {
	body: string;
	length: number;
	problem?: string;
}

/** Extract $( ... ) body starting at the `$` (index of `$`). */
function extractSubstitution(input: string, start: number): SubMatch {
	// start points at '$', start+1 is '('.
	let depth = 1;
	let i = start + 2;
	const n = input.length;
	let body = "";
	while (i < n && depth > 0) {
		const c = input[i]!;
		if (c === "\\") {
			body += input.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) return { body, length: i - start, problem: "unterminated quote in substitution" };
			body += input.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (c === "(") depth++;
		if (c === ")") {
			depth--;
			if (depth === 0) {
				i += 1;
				break;
			}
		}
		body += c;
		i += 1;
	}
	if (depth !== 0) return { body, length: i - start, problem: "unterminated $() substitution" };
	return { body, length: i - start };
}

/** Extract `...` backtick body starting at the opening backtick. */
function extractBacktick(input: string, start: number): SubMatch {
	let i = start + 1;
	const n = input.length;
	let body = "";
	while (i < n) {
		const c = input[i]!;
		if (c === "\\") {
			body += input.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "`") return { body, length: i - start + 1 };
		body += c;
		i += 1;
	}
	return { body, length: i - start, problem: "unterminated backtick substitution" };
}

interface HeredocDelim {
	delim: string;
	raw: string;
	length: number;
	problem?: string;
}

/**
 * Read the heredoc delimiter following `<<` / `<<-` at `pos`. The delimiter
 * may be unquoted (<<EOF), single- (<<'EOF') or double-quoted (<<"EOF").
 * Returns the delimiter text, its raw source, and chars consumed from `pos`.
 */
function readHeredocDelim(input: string, pos: number): HeredocDelim {
	let i = pos;
	const n = input.length;
	while (i < n && (input[i] === " " || input[i] === "\t")) i += 1;
	if (i >= n) return { delim: "", raw: "", length: i - pos, problem: "missing heredoc delimiter" };
	const c = input[i]!;
	let delim = "";
	let raw = "";
	if (c === "'" || c === '"') {
		const end = input.indexOf(c, i + 1);
		if (end === -1) return { delim: "", raw: "", length: i - pos, problem: "unterminated quote in heredoc delimiter" };
		delim = input.slice(i + 1, end);
		raw = input.slice(i, end + 1);
		i = end + 1;
	} else {
		while (i < n) {
			const d = input[i]!;
			if (d === " " || d === "\t" || d === "\n" || d === "<" || d === ">" || d === "|" || d === "&" || d === ";" || d === "#" || d === "(" || d === ")") break;
			delim += d;
			i += 1;
		}
		raw = delim;
	}
	if (delim === "") return { delim: "", raw, length: i - pos, problem: "missing heredoc delimiter" };
	return { delim, raw, length: i - pos };
}

interface HeredocBody {
	i: number;
	problem?: string;
}

/**
 * Skip a heredoc body starting at `start` (the first char after the newline
 * that begins the body). Consumes lines until one equals `delim` (after
 * stripping leading tabs when `stripTabs`, for `<<-`). Returns the index past
 * the delimiter line, or a problem if the delimiter is never found.
 */
function skipHeredocBody(input: string, start: number, delim: string, stripTabs: boolean): HeredocBody {
	let i = start;
	const n = input.length;
	for (;;) {
		const nl = input.indexOf("\n", i);
		const lineEnd = nl === -1 ? n : nl;
		let line = input.slice(i, lineEnd);
		if (stripTabs) line = line.replace(/^\t+/, "");
		if (line === delim) return { i: nl === -1 ? n : nl + 1 };
		if (nl === -1) return { i: n, problem: `unterminated heredoc '${delim}'` };
		i = nl + 1;
	}
}

function isAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
}

export interface ParseResult {
	segments: Segment[];
	separators: string[];
	problem?: string;
}

/**
 * Parse a command line into segments. Fail-closed: any construct outside
 * the supported subset sets `problem` on the result (and the classifier
 * must then treat the whole line as unknown).
 */
export function parse(input: string): ParseResult {
	const { tokens, problem } = lex(input);
	if (problem) {
		return { segments: [], separators: [], problem };
	}

	// Heredocs: the body lives on following lines and our lexer has no model
	// for it — lines of the body would be misread as commands. Fail closed.
	for (const tok of tokens) {
		if (tok.op === "REDIR" && redirectKind(tok.text) === "heredoc") {
			return { segments: [], separators: [], problem: "heredoc not supported" };
		}
	}

	const segments: Segment[] = [];
	const separators: string[] = [];

	let current: LexToken[] = [];
	let pendingProblem: string | undefined;

	const flush = () => {
		if (current.length === 0) return;
		segments.push(buildSegment(current, segments.length, pendingProblem));
		current = [];
		pendingProblem = undefined;
	};

	let expectRedirectTarget: { kind: Redirect["kind"]; raw: string } | undefined;

	for (const tok of tokens) {
		if (expectRedirectTarget) {
			// Attach target as a redirect on the current segment being built.
			current.push({ ...tok, redir: { kind: expectRedirectTarget.kind, target: tok.text } });
			expectRedirectTarget = undefined;
			continue;
		}
		if (tok.op === "REDIR") {
			const kind = redirectKind(tok.text);
			if (kind === "fd-dup") {
				// e.g. 2>&1 - no target word consumed; attach immediately.
			current.push({ ...tok, redir: { kind: "fd-dup", target: tok.text } });
			} else {
				expectRedirectTarget = { kind, raw: tok.text };
			}
			continue;
		}
		if (tok.op && SHELL_OPERATORS.has(tok.op)) {
			flush();
			separators.push(tok.op);
			continue;
		}
		current.push(tok);
	}
	if (expectRedirectTarget) {
		return { segments, separators, problem: `dangling redirection '${expectRedirectTarget.raw}'` };
	}
	flush();

	if (segments.length === 0 && tokens.length > 0) {
		return { segments, separators, problem: "no command found" };
	}

	return { segments, separators };
}

function redirectKind(text: string): Redirect["kind"] {
	// Strip fd prefix.
	const t = text.replace(/^[0-9]+/, "");
	if (t === ">" || t === ">|" || t === ">>" || t === "&>" || t === "&>>") return "write";
	if (t === "<") return "read";
	if (t.startsWith("<<")) return "heredoc";
	return "fd-dup"; // >& <&
}

/** Shell keywords that prefix a real command (`if grep x`, `do rm f`).
 * Stripped by buildSegment so the following command is analyzed directly;
 * also listed in command-db so a bare keyword token is a readonly no-op. */
const PREFIX_KEYWORDS = new Set(["if", "elif", "while", "until", "do", "then", "else", "!", "{"]);

function buildSegment(tokens: LexToken[], index: number, pendingProblem?: string): Segment {
	const seg: Segment = {
		index,
		raw: tokens.map((t) => t.raw).join(" "),
		flags: [],
		args: [],
		env: {},
		redirects: [],
		substitutions: [],
		problem: pendingProblem,
	};

	let sawCommand = false;
	let strippedPrefix: string | undefined;
	for (const tok of tokens) {
		seg.substitutions.push(...tok.subs);

		if (tok.redir) {
			seg.redirects.push({
				kind: tok.redir.kind,
				target: tok.redir.target,
				writes: tok.redir.kind === "write",
			});
			continue;
		}

		if (!sawCommand && isAssignment(tok.text)) {
			const eq = tok.text.indexOf("=");
			seg.env[tok.text.slice(0, eq)] = tok.text.slice(eq + 1);
			continue;
		}

		// Strip leading shell keywords (`if`/`while`/`do`/`then`/...) so the real
		// command becomes the binary. `if rm x` must classify on `rm`, not `if`.
		if (!sawCommand && PREFIX_KEYWORDS.has(tok.text)) {
			strippedPrefix = tok.text;
			continue;
		}

		if (!sawCommand) {
			seg.binary = basename(tok.text);
			sawCommand = true;
			continue;
		}

		if (!seg.subcommand && seg.args.length === 0 && seg.flags.length === 0 && !tok.text.startsWith("-")) {
			// Candidate subcommand — classifier decides whether to use it.
			seg.subcommand = tok.text;
			continue;
		}

		if (tok.text.startsWith("-") && tok.text !== "-") {
			if (tok.text.startsWith("--")) {
				seg.flags.push(tok.text.split("=")[0]!);
			} else {
				// Split bundled short flags (-rf => -r -f) only for short clusters
				// of single letters. Longer -word tokens (find predicates like
				// -name/-delete) stay whole so command-db writeFlags such as
				// "-delete" match literally.
				const body = tok.text.slice(1);
				if (body.length <= 3 && /^[a-zA-Z]+$/.test(body)) {
					for (const ch of body) seg.flags.push("-" + ch);
				} else {
					seg.flags.push(tok.text);
				}
			}
			continue;
		}

		seg.args.push(tok.text);
	}

	if (!seg.binary) {
		// A bare keyword segment (e.g. `then`/`done` with no body): treat the
		// stripped/leading keyword as a readonly no-op rather than "no command".
		if (strippedPrefix) {
			seg.binary = strippedPrefix;
		} else {
			seg.problem = seg.problem ?? "no command word";
		}
	}
	return seg;
}
