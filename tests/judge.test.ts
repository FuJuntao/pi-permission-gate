import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { judge } from "../src/judge.ts";

const dynamicModel = {
	provider: "lite-llm",
	id: "deepseek-v4-flash",
	api: "openai-completions",
} as Model<Api>;

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
assert.equal(verdict?.safe, true);
assert.equal(verdict?.reason, "bounded project edit");
assert.equal(verdict?.model, "lite-llm/deepseek-v4-flash");

console.log("\n1 passed, 0 failed");
