/**
 * Wildcard matching for allow/deny rules against a tool subject (command or
 * path string). `*` = any sequence, `?` = one character, `**` = any sequence.
 */

export function matchWildcard(pattern: string, subject: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) {
		return subject === pattern;
	}
	const re = wildcardToRegExp(pattern);
	return re.test(subject);
}

export function matchWildcardList(patterns: string[], subject: string): string | undefined {
	for (const p of patterns) {
		if (matchWildcard(p, subject)) return p;
	}
	return undefined;
}

/** Escape wildcard metacharacters so the pattern matches the subject literally. */
export function escapeWildcard(subject: string): string {
	return subject.replace(/[\\*?]/g, "\\$&");
}

function wildcardToRegExp(pattern: string): RegExp {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "\\" && i + 1 < pattern.length) {
			re += escapeRe(pattern[++i]!);
			continue;
		}
		if (c === "*" && pattern[i + 1] === "*") {
			re += ".*";
			i++;
			continue;
		}
		if (c === "*") {
			re += ".*";
			continue;
		}
		if (c === "?") {
			re += ".";
			continue;
		}
		re += escapeRe(c);
	}
	re += "$";
	return new RegExp(re);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
