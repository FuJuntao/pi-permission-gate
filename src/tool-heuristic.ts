/**
 * Heuristic read-only tool discovery from pi tool metadata.
 *
 * Conservative by design: a tool must match a read-only name pattern,
 * NOT match any mutation name pattern, and NOT carry mutation-indicating
 * parameters. False negatives just fall through to the LLM judge (the
 * pre-existing behavior); false positives would bypass the gate.
 */

export interface ToolMeta {
	name: string;
	description?: string;
	parameters?: unknown;
}

/** Name substrings that suggest a read-only tool. */
const READONLY_PATTERNS = [
	"read",
	"search",
	"query",
	"get",
	"find",
	"list",
	"view",
	"show",
	"report",
	"diagnostics",
	"inspect",
	"check",
	"lookup",
	"fetch",
	"symbol",
	"module",
	"enclosing",
	"status",
	"outline",
	"dump",
];

/** Name substrings that suggest a mutating tool — veto read-only. */
const MUTATION_PATTERNS = [
	"write",
	"edit",
	"create",
	"delete",
	"remove",
	"execute",
	"run",
	"install",
	"replace",
	"activate",
	"send",
	"register",
	"update",
	"set",
	"mark",
	"grant",
	"stop",
	"interrupt",
	"resume",
	"steer",
	"append",
	"schedule",
	"cancel",
];

/** Parameter names that indicate a tool can mutate state. */
const MUTATION_PARAMS = new Set([
	"content",
	"command",
	"edits",
	"config",
	"message",
]);

/**
 * Return tool names that are heuristically read-only.
 * Conservative: only classifies when all signals agree.
 */
export function discoverReadonlyTools(tools: ToolMeta[]): string[] {
	return tools.filter(isHeuristicallyReadonly).map((t) => t.name);
}

function isHeuristicallyReadonly(tool: ToolMeta): boolean {
	const name = tool.name.toLowerCase();

	// Must match at least one read-only pattern.
	if (!READONLY_PATTERNS.some((p) => name.includes(p))) return false;

	// Must not match any mutation pattern.
	if (MUTATION_PATTERNS.some((p) => name.includes(p))) return false;

	// Must not carry mutation-indicating parameters.
	if (hasMutationParams(tool.parameters)) return false;

	return true;
}

function hasMutationParams(schema: unknown): boolean {
	if (!schema || typeof schema !== "object") return false;
	const props = (schema as Record<string, unknown>).properties;
	if (!props || typeof props !== "object") return false;
	return Object.keys(props as Record<string, unknown>).some((k) =>
		MUTATION_PARAMS.has(k),
	);
}
