import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { judge, judgeCacheKey } from "../src/judge.ts";
import { classifyCommand } from "../src/analyzer/classifier.ts";

const dynamicModel = {
	provider: "lite-llm",
	id: "deepseek-v4-flash",
	api: "openai-completions",
} as Model<Api>;

describe("judge", () => {
	test("resolves model via registry and returns safety verdict", async () => {
		let resolvedWith: [string, string] | undefined;
		const verdict = await judge(
			"lite-llm/deepseek-v4-flash",
			{
				tool: "bash",
				subject: "python3 - <<'PY'\nprint('ok')\nPY",
				cwd: "/repo",
			},
			{
				findModel: (provider, modelId) => {
					resolvedWith = [provider, modelId];
					return dynamicModel;
				},
				getApiKeyAndHeaders: async (model) => {
					assert.equal(model, dynamicModel);
					return { ok: true, apiKey: "test-key" };
				},
				completeRequest: (async (model) => {
					assert.equal(model, dynamicModel);
					return {
						content: [{ type: "text", text: '{"safe":true,"reason":"bounded project edit"}' }],
					};
				}) as never,
				timeoutMs: 1_000,
			},
		);

		assert.deepEqual(resolvedWith, ["lite-llm", "deepseek-v4-flash"]);
		assert.equal(verdict?.role, "safety");
		assert.equal(verdict?.role === "safety" ? verdict.safe : false, true);
		assert.equal(verdict?.reason, "bounded project edit");
		assert.equal(verdict?.model, "lite-llm/deepseek-v4-flash");
	});

	test("cache keys differ for different subjects and cwds", () => {
		const safeHeredoc = "python3 - <<'PY'\nprint('safe')\nPY";
		const destructiveHeredoc = "python3 - <<'PY'\nimport shutil; shutil.rmtree('.')\nPY";
		const cacheRequest = (subject: string) => ({
			tool: "bash",
			subject,
			cwd: "/repo",
			analysis: classifyCommand(subject),
		});
		assert.notEqual(
			judgeCacheKey(cacheRequest(safeHeredoc)),
			judgeCacheKey(cacheRequest(destructiveHeredoc)),
			"different parse-failed commands must never share a judge verdict",
		);
		assert.notEqual(
			judgeCacheKey(cacheRequest(safeHeredoc)),
			judgeCacheKey({ ...cacheRequest(safeHeredoc), cwd: "/other-repo" }),
			"relative commands in different working directories must not share a judge verdict",
		);
	});
});
