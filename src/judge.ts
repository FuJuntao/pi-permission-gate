/**
 * LLM judge: evaluates commands the static analyzer couldn't prove read-only.
 *
 * Design:
 *  - The judge NEVER sees just a raw command blob. It receives the parser's
 *    structured breakdown (segments, binaries, flags, redirects) so it only
 *    reasons about risk, never about shell grammar.
 *  - Structured JSON verdict, one retry on parse failure, then fail to the
 *    caller (which falls back to a user prompt).
 *  - Model must be explicitly configured (`judgeModel`). No silent auto-pick.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Analysis } from "./types.ts";

export interface JudgeVerdict {
	safe: boolean;
	reason: string;
	model: string;
	ms: number;
}

export interface JudgeRequest {
	tool: string;
	/** Raw command (bash) or path (file tools). */
	subject: string;
	cwd: string;
	/** Analyzer breakdown, present for bash. */
	analysis?: Analysis;
	/** Extra context for non-bash tools (e.g. file size, diff summary). */
	extra?: string;
}

const SYSTEM_PROMPT = `You are a security judge for a coding agent's tool calls. Decide whether executing the action is safe in a development context.

You receive a STRUCTURED breakdown produced by a static analyzer, never just a raw command. Trust the segment analysis; reason only about risk.

Verdict rules:
- "safe": true  → routine development action with bounded, reversible blast radius (build, test, install deps, format, commit, restart a dev server, write project files).
- "safe": false → meaningful risk of data loss, secret exfiltration, irreversible remote effects, host compromise, or effects outside the working directory's project.
Consider: destructive ops beyond generated artifacts; force-pushes to shared branches; publishing packages; touching paths outside the project; reading private keys/credentials; network posts of local data; system config changes; anything targeting production-looking resources.
When genuinely torn, answer false.

Respond with ONLY a JSON object, no markdown fences, no prose:
{"safe": true, "reason": "one sentence"}`;

function buildPrompt(req: JudgeRequest): string {
	const lines: string[] = [];
	lines.push(`Tool: ${req.tool}`);
	lines.push(`Working directory: ${req.cwd}`);
	lines.push(`Subject: ${req.subject}`);

	if (req.analysis) {
		const a = req.analysis;
		lines.push(`Analyzer classification: ${a.classification} (${a.note})`);
		lines.push(`Segments:`);
		for (const seg of a.segments) {
			const parts: string[] = [`  ${seg.index + 1}. ${seg.raw}`];
			if (seg.binary) parts.push(`binary=${seg.binary}`);
			if (seg.subcommand) parts.push(`subcommand=${seg.subcommand}`);
			if (seg.flags.length) parts.push(`flags=[${seg.flags.join(",")}]`);
			if (seg.args.length) parts.push(`args=[${seg.args.join(",")}]`);
			const writes = seg.redirects.filter((r) => r.kind === "write").map((r) => r.target);
			if (writes.length) parts.push(`writes=[${writes.join(",")}]`);
			if (seg.substitutions.length) parts.push(`substitutions=${seg.substitutions.length} (analyzed as read-only)`);
			if (seg.problem) parts.push(`problem=${seg.problem}`);
			lines.push(parts.join("  "));
		}
		if (a.separators.length) lines.push(`Chained with: ${a.separators.join(" ")}`);
	}
	if (req.extra) lines.push(req.extra);
	return lines.join("\n");
}

function parseVerdict(text: string): { safe: boolean; reason: string } | undefined {
	// Tolerant extraction: first {...} block containing "safe".
	const match = /\{[^{}]*"safe"[^{}]*\}/s.exec(text);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[0]) as { safe?: unknown; reason?: unknown };
		if (typeof parsed.safe !== "boolean") return undefined;
		return { safe: parsed.safe, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
	} catch {
		return undefined;
	}
}

export interface JudgeDeps {
	findModel: ExtensionContext["modelRegistry"]["find"];
	getApiKeyAndHeaders: ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"];
	/** Injectable for tests; production uses pi-ai's complete(). */
	completeRequest?: typeof complete;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Cache key: normalized so re-judging the same structure is free. */
export function judgeCacheKey(req: JudgeRequest): string {
	if (!req.analysis) return `${req.tool}:${req.subject}`;
	const shape = req.analysis.segments
		.map((s) => `${s.binary ?? "?"}:${s.subcommand ?? ""}:${s.flags.join(",")}:${s.args.join(",")}:${s.redirects.filter((r) => r.kind === "write").map((r) => r.target).join(",")}`)
		.join("|");
	return `${req.tool}:${shape}`;
}

export async function judge(
	modelSpec: string,
	req: JudgeRequest,
	deps: JudgeDeps,
): Promise<JudgeVerdict | undefined> {
	const slash = modelSpec.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = modelSpec.slice(0, slash);
	const modelId = modelSpec.slice(slash + 1);
	// Resolve through pi's runtime registry rather than pi-ai's static built-in
	// catalog so configured/custom providers (for example LiteLLM) work too.
	const model = deps.findModel(provider, modelId);
	if (!model) return undefined;

	const auth = await deps.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return undefined;

	const prompt = buildPrompt(req);
	const start = Date.now();

	const callOnce = async (extraInstruction?: string) => {
		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: extraInstruction ? `${prompt}\n\n${extraInstruction}` : prompt }],
				timestamp: Date.now(),
			},
		];
		const response = await (deps.completeRequest ?? complete)(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages },
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: deps.signal, maxTokens: 256, temperature: 0 },
		);
		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	};

	const withTimeout = async <T>(p: Promise<T>): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				p,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("judge timeout")), deps.timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};

	try {
		const first = parseVerdict(await withTimeout(callOnce()));
		if (first) return { ...first, model: modelSpec, ms: Date.now() - start };
		// One retry with the parse failure fed back.
		const second = parseVerdict(
			await withTimeout(callOnce("Your previous reply was not valid JSON. Reply with ONLY: {\"safe\": boolean, \"reason\": string}")),
		);
		if (second) return { ...second, model: modelSpec, ms: Date.now() - start };
		return undefined;
	} catch {
		return undefined;
	}
}
