import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverReadonlyTools, type ToolMeta } from "../src/tool-heuristic.ts";

function tool(name: string, parameters?: Record<string, unknown>): ToolMeta {
	return {
		name,
		parameters: parameters ? { properties: parameters } : undefined,
	};
}

test("discovers read-only tools by name pattern", () => {
	const tools = [
		tool("web_search"),
		tool("fetch_content"),
		tool("get_search_content"),
		tool("symbol_search"),
		tool("module_report"),
		tool("read_symbol"),
		tool("read_enclosing"),
		tool("lsp_diagnostics"),
		tool("lens_diagnostics"),
	];
	const found = new Set(discoverReadonlyTools(tools));
	for (const t of tools)
		assert.ok(found.has(t.name), `${t.name} should be readonly`);
});

test("does not classify mutating tools as read-only", () => {
	const tools = [
		tool("bash"),
		tool("write"),
		tool("edit"),
		tool("subagent"),
		tool("ast_grep_replace"),
		tool("lens_diagnostic_mark"),
		tool("pi_lens_activate_tools"),
	];
	const found = new Set(discoverReadonlyTools(tools));
	for (const t of tools)
		assert.ok(!found.has(t.name), `${t.name} should NOT be readonly`);
});

test("mutation params veto an otherwise read-only name", () => {
	// "get_config" looks read-only by name, but carries a "config" param.
	const tools = [tool("get_config", { config: {} })];
	assert.deepEqual(discoverReadonlyTools(tools), []);
});

test("read-only name with benign params stays read-only", () => {
	const tools = [tool("query_metrics", { query: {}, limit: {} })];
	assert.deepEqual(discoverReadonlyTools(tools), ["query_metrics"]);
});

test("unknown tools are not classified (fall through to judge)", () => {
	const tools = [tool("frobnicate"), tool("do_stuff")];
	assert.deepEqual(discoverReadonlyTools(tools), []);
});
