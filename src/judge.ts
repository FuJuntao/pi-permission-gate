/**
 * LLM judge — two roles:
 *   1. safety: T1 allow/deny (blast radius / irreversibility)
 *   2. classify: opaque script → operation kind (+ paths when possible)
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Analysis, OpKind } from "./types.ts";

export interface SafetyVerdict {
	role: "safety";
	safe: boolean;
	reason: string;
	model: string;
	ms: number;
}

export interface ClassifyVerdict {
	role: "classify";
	op?: OpKind;
	paths: string[];
	reason: string;
	model: string;
	ms: number;
}

export type JudgeVerdict = SafetyVerdict | ClassifyVerdict;

export interface JudgeRequest {
	tool: string;
	subject: string;
	cwd: string;
	analysis?: Analysis;
	extra?: string;
}

const SAFETY_PROMPT = `You are a safety judge for a coding agent's tool calls. Decide whether executing the action is acceptable in a development context.

Focus on blast radius and irreversibility: data loss, destructive deletes, force-push to shared branches, production changes, host compromise, effects outside the project. Routine builds, tests, edits, installs, and commits are safe.

Respond with ONLY a JSON object, no markdown fences:
{"safe": true, "reason": "one sentence"}`;

const CLASSIFY_PROMPT = `You classify what a script or opaque tool invocation does for a permission gate.

Given the exact source (or tool input), return the dominant operation kind:
- "create" — creates new files/dirs/resources
- "read" — only observes (prints, lists, queries)
- "update" — modifies existing content/state
- "delete" — removes files/resources

If multiple apply, pick the most dangerous: delete > update > create > read.
Include target paths when you can infer them (relative or absolute).

Respond with ONLY a JSON object, no markdown fences:
{"op": "read"|"create"|"update"|"delete", "paths": ["optional"], "reason": "one sentence"}`;

function buildSafetyPrompt(req: JudgeRequest): string {
	const lines: string[] = [];
	lines.push(`Tool: ${req.tool}`);
	lines.push(`Working directory: ${req.cwd}`);
	lines.push(`Subject: ${req.subject}`);
	if (req.analysis) {
		const a = req.analysis;
		lines.push(`Analyzer: ${a.classification} (${a.note})`);
		for (const seg of a.segments) {
			lines.push(`  segment: ${seg.raw}`);
		}
	}
	if (req.extra) lines.push(req.extra);
	return lines.join("\n");
}

function buildClassifyPrompt(source: string, cwd: string, tool: string): string {
	return [`Tool: ${tool}`, `Working directory: ${cwd}`, `Source:`, source].join("\n");
}

function parseSafety(text: string): { safe: boolean; reason: string } | undefined {
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

const OPS = new Set(["create", "read", "update", "delete"]);

function parseClassify(text: string): { op?: OpKind; paths: string[]; reason: string } | undefined {
	const match = /\{[\s\S]*"op"[\s\S]*\}/s.exec(text);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[0]) as { op?: unknown; paths?: unknown; reason?: unknown };
		const op = typeof parsed.op === "string" && OPS.has(parsed.op) ? (parsed.op as OpKind) : undefined;
		const paths = Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === "string") : [];
		return { op, paths, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
	} catch {
		return undefined;
	}
}

export interface JudgeDeps {
	findModel: ExtensionContext["modelRegistry"]["find"];
	getApiKeyAndHeaders: ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"];
	completeRequest?: typeof complete;
	timeoutMs: number;
	signal?: AbortSignal;
}

export function safetyCacheKey(req: JudgeRequest): string {
	return JSON.stringify(["safety", req.tool, req.cwd, req.subject, req.extra ?? ""]);
}

export function classifyCacheKey(tool: string, cwd: string, source: string): string {
	return JSON.stringify(["classify", tool, cwd, source]);
}

async function callJudge(
	modelSpec: string,
	systemPrompt: string,
	userText: string,
	deps: JudgeDeps,
	retryHint: string,
	parse: (text: string) => unknown,
): Promise<{ parsed: unknown; model: string; ms: number } | undefined> {
	const slash = modelSpec.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = modelSpec.slice(0, slash);
	const modelId = modelSpec.slice(slash + 1);
	const model = deps.findModel(provider, modelId);
	if (!model) return undefined;

	const auth = await deps.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return undefined;

	const start = Date.now();
	const callOnce = async (extra?: string) => {
		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: extra ? `${userText}\n\n${extra}` : userText }],
				timestamp: Date.now(),
			},
		];
		const response = await (deps.completeRequest ?? complete)(
			model,
			{ systemPrompt, messages },
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
		const first = parse(await withTimeout(callOnce()));
		if (first) return { parsed: first, model: modelSpec, ms: Date.now() - start };
		const second = parse(await withTimeout(callOnce(retryHint)));
		if (second) return { parsed: second, model: modelSpec, ms: Date.now() - start };
		return undefined;
	} catch {
		return undefined;
	}
}

export async function judgeSafety(modelSpec: string, req: JudgeRequest, deps: JudgeDeps): Promise<SafetyVerdict | undefined> {
	const result = await callJudge(
		modelSpec,
		SAFETY_PROMPT,
		buildSafetyPrompt(req),
		deps,
		'Reply with ONLY: {"safe": boolean, "reason": string}',
		parseSafety,
	);
	if (!result) return undefined;
	const v = result.parsed as { safe: boolean; reason: string };
	return { role: "safety", safe: v.safe, reason: v.reason, model: result.model, ms: result.ms };
}

export async function judgeClassify(
	modelSpec: string,
	tool: string,
	cwd: string,
	source: string,
	deps: JudgeDeps,
): Promise<ClassifyVerdict | undefined> {
	const result = await callJudge(
		modelSpec,
		CLASSIFY_PROMPT,
		buildClassifyPrompt(source, cwd, tool),
		deps,
		'Reply with ONLY: {"op": "read"|"create"|"update"|"delete", "paths": [], "reason": string}',
		parseClassify,
	);
	if (!result) return undefined;
	const v = result.parsed as { op?: OpKind; paths: string[]; reason: string };
	return { role: "classify", op: v.op, paths: v.paths, reason: v.reason, model: result.model, ms: result.ms };
}

/** @deprecated alias for tests */
export const judge = judgeSafety;
export const judgeCacheKey = safetyCacheKey;
