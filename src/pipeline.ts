/**
 * Decision pipeline. Every gated tool call flows through:
 *
 *   1. hard blocks       (immutable, all modes)
 *   2. config allow/deny (command regexes + sensitive paths)
 *   3. file edit policy  (tracked or session-granted edits → allow)
 *   4. static analyzer   (provably read-only? → allow)
 *   5. LLM judge         (auto mode + configured model; async-log in observe)
 *   6. user prompt       (strict mode, or auto when judge can't decide)
 *
 * Observe mode runs the same stages but converts the final verdict to
 * "allow + log what would have happened".
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendAudit } from "./audit.ts";
import { classifyCommand } from "./analyzer/classifier.ts";
import { matchConfigRules, matchSensitivePath, type LoadedConfig } from "./config.ts";
import { matchHardBlock } from "./hard-blocks.ts";
import type { FileEditPolicy } from "./file-edit-policy.ts";
import { judge, judgeCacheKey, type JudgeRequest, type JudgeVerdict } from "./judge.ts";
import type { Analysis, AuditEntry, Decision } from "./types.ts";

export interface GateInput {
	tool: string;
	/** bash command, or file path for file tools. */
	subject: string;
	ctx: ExtensionContext;
	loaded: LoadedConfig;
	sessionId?: string;
	/** Session-scoped judge verdict cache. */
	cache: Map<string, JudgeVerdict>;
	/** Git-tracked and session-scoped edit authorization. */
	fileEditPolicy: FileEditPolicy;
	/** Fire-and-forget judge runner for observe mode. */
	onAsyncJudge?: (entry: AuditEntry, verdict: JudgeVerdict) => void;
}

const READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

export async function decide(input: GateInput): Promise<Decision> {
	const { tool, subject, ctx, loaded } = input;
	const { config } = loaded;
	const mode = config.mode;

	const finish = (decision: Decision, analysis?: Analysis, judgeInfo?: AuditEntry["judge"], userChoice?: string): Decision => {
		const observed = mode === "observe";
		// Observe mode bypasses ordinary denials for tuning, but catastrophic hard
		// blocks remain enforced in every mode.
		const bypassedBlock = observed && decision.verdict === "block" && decision.stage !== "hard-block";
		const entry: AuditEntry = {
			ts: Date.now(),
			session: input.sessionId,
			cwd: ctx.cwd,
			tool,
			subject,
			mode,
			stage: decision.stage,
			verdict: bypassedBlock ? "allow" : decision.verdict,
			wouldBe: bypassedBlock ? "block" : decision.wouldBe,
			reason: decision.reason,
			analysis: analysis
				? {
						classification: analysis.classification,
						note: analysis.note,
						segments: analysis.segments.map((s) => ({
							raw: s.raw,
							binary: s.binary,
							subcommand: s.subcommand,
							flags: s.flags,
							args: s.args,
							writes: s.redirects.filter((r) => r.kind === "write").map((r) => r.target),
							problem: s.problem,
						})),
					}
				: undefined,
			judge: judgeInfo,
			userChoice,
		};
		appendAudit(loaded.config.logPath, entry);
		if (bypassedBlock) {
			return { verdict: "allow", stage: "observe", reason: decision.reason, wouldBe: "block" };
		}
		return decision;
	};

	// ---- Stage 1: hard blocks (all modes, never bypassed) ----
	if (config.hardBlocksEnabled && tool === "bash") {
		const reason = matchHardBlock(subject);
		if (reason) {
			return finish({ verdict: "block", stage: "hard-block", reason: `hard block: ${reason}` });
		}
	}

	// ---- Stage 2: config rules ----
	if (tool === "bash") {
		const rule = matchConfigRules(config, subject);
		if (rule === "deny") {
			return finish({ verdict: "block", stage: "config-deny", reason: "matched config deny rule" });
		}
		if (rule === "allow") {
			return finish({ verdict: "allow", stage: "config-allow", reason: "matched config allow rule" });
		}
	}

	// Sensitive paths apply to file tools AND bash path targets.
	if (tool !== "bash") {
		const pathArg = extractPathArg(tool, input);
		if (pathArg) {
			const hit = matchSensitivePath(config.sensitivePaths, resolveAgainst(pathArg, ctx.cwd));
			if (hit) {
				return finish({ verdict: "block", stage: "config-deny", reason: `sensitive path: ${hit}` });
			}
		}
	}

	// ---- Read-only file tools: allow after config ----
	if (READONLY_TOOLS.has(tool)) {
		return finish({ verdict: "allow", stage: "analyzer-readonly", reason: "read-only tool" });
	}

	// ---- Tracked/session file edits: allow after sensitive-path checks ----
	if (tool === "edit" && ctx.isProjectTrusted()) {
		const allowance = await input.fileEditPolicy.allowance(tool, subject, ctx.cwd);
		if (allowance === "git-tracked") {
			return finish({ verdict: "allow", stage: "git-tracked-edit", reason: "edit target is a Git-tracked regular file" });
		}
		if (allowance === "session") {
			return finish({ verdict: "allow", stage: "session-edit", reason: "file was successfully mutated earlier in this session" });
		}
	}

	// ---- Stage 3: static analysis (bash) ----
	let analysis: Analysis | undefined;
	if (tool === "bash") {
		analysis = classifyCommand(subject);

		// Sensitive-path check on redirect targets and path-like args.
		for (const seg of analysis.segments) {
			for (const r of seg.redirects) {
				if (r.kind !== "write") continue;
				const hit = matchSensitivePath(config.sensitivePaths, resolveAgainst(r.target, ctx.cwd));
				if (hit) {
					return finish({ verdict: "block", stage: "config-deny", reason: `redirect to sensitive path: ${hit}` }, analysis);
				}
			}
		}

		if (analysis.classification === "readonly") {
			return finish({ verdict: "allow", stage: "analyzer-readonly", reason: analysis.note }, analysis);
		}
	}

	// ---- File-write tools: build a lightweight analysis-like request ----
	const judgeReq: JudgeRequest = {
		tool,
		subject,
		cwd: ctx.cwd,
		analysis,
		extra: FILE_WRITE_TOOLS.has(tool) ? "File write/edit tool call. Judge the target path and change, not shell syntax." : undefined,
	};

	// ---- Observe mode: run judge async (if enabled), never gate ----
	if (mode === "observe") {
		if (config.judgeModel && config.judgeInObserveMode) {
			runJudge(judgeReq, input)
				.then((verdict) => {
					if (!verdict || !input.onAsyncJudge) return;
					input.onAsyncJudge(
						{
							ts: Date.now(),
							session: input.sessionId,
							cwd: ctx.cwd,
							tool,
							subject,
							mode,
							stage: "judge",
							verdict: "allow",
							wouldBe: verdict.safe ? "allow" : "block",
							reason: verdict.reason,
							judge: { model: verdict.model, safe: verdict.safe, reason: verdict.reason, ms: verdict.ms, async: true },
						},
						verdict,
					);
				})
				.catch(() => {});
		}
		const reason =
			tool === "bash"
				? `observe: analyzer said ${analysis?.classification ?? "n/a"} (${analysis?.note ?? ""})`
				: `observe: ${tool} would require judgment`;
		// The asynchronous judge has not produced a verdict yet. Do not claim the
		// command would be blocked; onAsyncJudge reports the eventual result.
		return finish({ verdict: "allow", stage: "observe", reason }, analysis);
	}

	// ---- Stage 4: judge (auto mode only) ----
	if (mode === "auto" && config.judgeModel) {
		const verdict = await runJudge(judgeReq, input);
		if (verdict) {
			const info: AuditEntry["judge"] = { model: verdict.model, safe: verdict.safe, reason: verdict.reason, ms: verdict.ms, async: false };
			if (verdict.safe) {
				return finish({ verdict: "allow", stage: "judge", reason: `judge: ${verdict.reason}` }, analysis, info);
			}
			return finish({ verdict: "block", stage: "judge", reason: `judge blocked: ${verdict.reason}` }, analysis, info);
		}
		// Judge unavailable → fall through to prompt.
	}

	// ---- Stage 5: user prompt ----
	if (!ctx.hasUI) {
		// Non-interactive: fail closed for anything not provably read-only.
		const reason =
			mode === "auto" && !config.judgeModel
				? "no judge configured and no UI for confirmation"
				: "non-interactive mode: cannot confirm";
		return finish({ verdict: "block", stage: "no-ui", reason }, analysis);
	}

	const summary =
		tool === "bash"
			? `\n\n  ${subject}\n\nAnalyzer: ${analysis?.classification} — ${analysis?.note}`
			: `\n\n  ${tool}: ${subject}`;
	const choice = await ctx.ui.select(`Permission gate (${mode}) — allow?${summary}`, ["Yes", "No"]);
	const userChoice = choice ?? "No";
	if (userChoice === "Yes") {
		return finish({ verdict: "allow", stage: "user-prompt", reason: "allowed by user" }, analysis, undefined, userChoice);
	}
	return finish({ verdict: "block", stage: "user-prompt", reason: "blocked by user" }, analysis, undefined, userChoice);
}

async function runJudge(req: JudgeRequest, input: GateInput): Promise<JudgeVerdict | undefined> {
	const key = judgeCacheKey(req);
	const cached = input.cache.get(key);
	if (cached) return cached;
	const verdict = await judge(input.loaded.config.judgeModel, req, {
		findModel: (provider, modelId) => input.ctx.modelRegistry.find(provider, modelId),
		getApiKeyAndHeaders: (m) => input.ctx.modelRegistry.getApiKeyAndHeaders(m),
		timeoutMs: input.loaded.config.judgeTimeoutMs,
		signal: input.ctx.signal,
	});
	if (verdict) input.cache.set(key, verdict);
	return verdict;
}

function extractPathArg(tool: string, input: GateInput): string | undefined {
	if (tool === "bash") return undefined;
	// subject is the path for file tools (set by the caller).
	if (READONLY_TOOLS.has(tool) || FILE_WRITE_TOOLS.has(tool)) return input.subject;
	return input.subject;
}

function resolveAgainst(p: string, cwd: string): string {
	if (p.startsWith("/") || p.startsWith("~")) return p;
	return `${cwd.replace(/\/$/, "")}/${p}`;
}
