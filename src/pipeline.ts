/**
 * Decision pipeline:
 *   off → allow
 *   classify → hard blocks → wildcard rules → tier → T2/T1/T0 → prompt
 *   dryRun → allow (except hard blocks) + wouldBe
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendAudit } from "./audit.ts";
import { classifyToolCall } from "./classify-op.ts";
import { appendGlobalAllow, matchConfigRules, type LoadedConfig } from "./config.ts";
import { matchHardBlock } from "./hard-blocks.ts";
import {
	classifyCacheKey,
	judgeClassify,
	judgeSafety,
	safetyCacheKey,
	type JudgeVerdict,
	type SafetyVerdict,
} from "./judge.ts";
import { resolveAgainst } from "./paths.ts";
import { assignTier } from "./tier.ts";
import { escapeWildcard } from "./wildcard.ts";
import type { Analysis, AuditEntry, Decision, OpKind, Tier } from "./types.ts";

export interface GateInput {
	tool: string;
	subject: string;
	ctx: ExtensionContext;
	loaded: LoadedConfig;
	sessionId?: string;
	cache: Map<string, JudgeVerdict>;
}

const PROMPT_OPTIONS = ["Allow once", "Always allow", "Always allow similar", "Deny"] as const;

export async function decide(input: GateInput): Promise<Decision> {
	const { tool, subject, ctx, loaded } = input;
	const { config } = loaded;
	const mode = config.mode;
	const dryRun = mode !== "off" && config.dryRun;

	if (mode === "off") {
		return { verdict: "allow", stage: "off", reason: "gate off" };
	}

	let op: OpKind | undefined;
	let tier: Tier | undefined;
	let analysis: Analysis | undefined;
	let lastJudge: AuditEntry["judge"] | undefined;

	const finish = (
		decision: Decision,
		opts?: { analysis?: Analysis; judge?: AuditEntry["judge"]; userChoice?: string; op?: OpKind; tier?: Tier },
	): Decision => {
		const enriched: Decision = {
			...decision,
			op: opts?.op ?? op ?? decision.op,
			tier: opts?.tier ?? tier ?? decision.tier,
		};

		let final = enriched;
		if (dryRun && enriched.verdict === "block" && enriched.stage !== "hard-block") {
			final = {
				verdict: "allow",
				stage: "dry-run",
				reason: enriched.reason,
				wouldBe: "block",
				op: enriched.op,
				tier: enriched.tier,
			};
		}

		if (config.audit) {
			const entry: AuditEntry = {
				ts: Date.now(),
				session: input.sessionId,
				cwd: ctx.cwd,
				tool,
				subject,
				mode,
				dryRun,
				stage: final.stage,
				verdict: final.verdict,
				wouldBe: final.wouldBe,
				reason: final.reason,
				op: final.op,
				tier: final.tier,
				analysis: (opts?.analysis ?? analysis)
					? {
							classification: (opts?.analysis ?? analysis)!.classification,
							note: (opts?.analysis ?? analysis)!.note,
							segments: (opts?.analysis ?? analysis)!.segments.map((s) => ({
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
				judge: opts?.judge ?? lastJudge,
				userChoice: opts?.userChoice,
			};
			appendAudit(config.logPath, entry);
		}

		return final;
	};

	// ---- Hard blocks ----
	if (config.hardBlocksEnabled && tool === "bash") {
		const reason = matchHardBlock(subject);
		if (reason) {
			return finish({ verdict: "block", stage: "hard-block", reason: `hard block: ${reason}` });
		}
	}

	// ---- Custom wildcard rules ----
	const rule = matchConfigRules(config, subject);
	if (rule === "deny") {
		return finish({ verdict: "block", stage: "config-deny", reason: "matched config deny rule" });
	}
	if (rule === "allow") {
		return finish({ verdict: "allow", stage: "config-allow", reason: "matched config allow rule" });
	}

	// ---- Classify ----
	const classified = await classifyToolCall(tool, subject, ctx.cwd, config);
	analysis = classified.analysis;
	op = classified.op;
	let paths = classified.paths;

	if (!op && classified.opaqueSource) {
		const classifiedOp = await runClassifyJudge(classified.opaqueSource, input);
		if (classifiedOp) {
			lastJudge = {
				model: classifiedOp.model,
				op: classifiedOp.op,
				reason: classifiedOp.reason,
				ms: classifiedOp.ms,
				role: "classify",
			};
			op = classifiedOp.op;
			if (classifiedOp.paths.length) {
				paths = classifiedOp.paths.map((p) => resolveAgainst(p, ctx.cwd));
			}
		}
	}

	const tierResult = await assignTier(op, paths, config, ctx.cwd);
	tier = tierResult.tier;

	// ---- Apply tier ----
	if (tier === "T2") {
		return finish({ verdict: "allow", stage: "tier-t2", reason: tierResult.reason }, { op, tier });
	}

	if (tier === "T0") {
		if (mode === "auto") {
			return finish({ verdict: "block", stage: "tier-t0", reason: `T0 auto-deny: ${tierResult.reason}` }, { op, tier });
		}
		return promptUser(input, finish, {
			op,
			tier,
			analysis,
			summaryExtra: tierResult.reason,
		});
	}

	// T1 — LLM judge
	if (!config.judgeModel) {
		if (mode === "auto") {
			return finish(
				{ verdict: "block", stage: "judge", reason: "T1 requires judgeModel in auto mode" },
				{ op, tier },
			);
		}
		return promptUser(input, finish, { op, tier, analysis, summaryExtra: "no judgeModel — confirm manually" });
	}

	const safety = await runSafetyJudge(input, analysis);
	if (!safety) {
		if (mode === "auto") {
			return finish({ verdict: "block", stage: "judge", reason: "judge unavailable in auto mode" }, { op, tier });
		}
		return promptUser(input, finish, { op, tier, analysis, summaryExtra: "judge unavailable" });
	}

	lastJudge = {
		model: safety.model,
		safe: safety.safe,
		reason: safety.reason,
		ms: safety.ms,
		role: "safety",
	};

	if (safety.safe) {
		return finish(
			{ verdict: "allow", stage: "judge", reason: `judge: ${safety.reason}` },
			{ op, tier, judge: lastJudge },
		);
	}

	if (mode === "auto") {
		return finish(
			{ verdict: "block", stage: "judge", reason: `judge blocked: ${safety.reason}` },
			{ op, tier, judge: lastJudge },
		);
	}

	return promptUser(input, finish, {
		op,
		tier,
		analysis,
		judge: lastJudge,
		summaryExtra: `judge: ${safety.reason}`,
	});
}

type FinishFn = (
	decision: Decision,
	opts?: { analysis?: Analysis; judge?: AuditEntry["judge"]; userChoice?: string; op?: OpKind; tier?: Tier },
) => Decision;

async function promptUser(
	input: GateInput,
	finish: FinishFn,
	ctx: {
		op?: OpKind;
		tier?: Tier;
		analysis?: Analysis;
		judge?: AuditEntry["judge"];
		summaryExtra?: string;
	},
): Promise<Decision> {
	const { tool, subject } = input;
	if (!input.ctx.hasUI) {
		return finish(
			{ verdict: "block", stage: "no-ui", reason: "non-interactive mode: cannot confirm" },
			{ op: ctx.op, tier: ctx.tier, analysis: ctx.analysis, judge: ctx.judge },
		);
	}

	const bits = [
		`op=${ctx.op ?? "?"} tier=${ctx.tier ?? "?"}`,
		ctx.summaryExtra,
		tool === "bash" ? subject : `${tool}: ${subject}`,
	].filter(Boolean);
	const choice = await input.ctx.ui.select(`Permission gate — allow?\n\n  ${bits.join("\n  ")}`, [...PROMPT_OPTIONS]);
	const userChoice = choice ?? "Deny";

	if (userChoice === "Deny") {
		return finish(
			{ verdict: "block", stage: "user-prompt", reason: "blocked by user" },
			{ op: ctx.op, tier: ctx.tier, analysis: ctx.analysis, judge: ctx.judge, userChoice },
		);
	}

	if (userChoice === "Always allow") {
		appendGlobalAllow(input.loaded, escapeWildcard(subject));
	} else if (userChoice === "Always allow similar") {
		const similar = suggestSimilar(tool, subject);
		const picked = await input.ctx.ui.select(`Allow similar pattern?`, [similar, "Cancel"]);
		if (picked && picked !== "Cancel") appendGlobalAllow(input.loaded, picked);
	}

	return finish(
		{ verdict: "allow", stage: "user-prompt", reason: "allowed by user" },
		{ op: ctx.op, tier: ctx.tier, analysis: ctx.analysis, judge: ctx.judge, userChoice },
	);
}

function suggestSimilar(tool: string, subject: string): string {
	if (tool === "bash") {
		const parts = subject.trim().split(/\s+/);
		if (parts.length >= 2) return `${parts[0]} ${parts[1]} *`;
		if (parts.length === 1) return `${parts[0]} *`;
	}
	const slash = subject.lastIndexOf("/");
	if (slash >= 0) return subject.slice(0, slash + 1) + "*";
	return escapeWildcard(subject);
}

async function runSafetyJudge(input: GateInput, analysis?: Analysis): Promise<SafetyVerdict | undefined> {
	const req = { tool: input.tool, subject: input.subject, cwd: input.ctx.cwd, analysis };
	const key = safetyCacheKey(req);
	const cached = input.cache.get(key);
	if (cached && cached.role === "safety") return cached;

	const verdict = await judgeSafety(input.loaded.config.judgeModel, req, {
		findModel: (provider, modelId) => input.ctx.modelRegistry.find(provider, modelId),
		getApiKeyAndHeaders: (m) => input.ctx.modelRegistry.getApiKeyAndHeaders(m),
		timeoutMs: input.loaded.config.judgeTimeoutMs,
		signal: input.ctx.signal,
	});
	if (verdict) input.cache.set(key, verdict);
	return verdict;
}

async function runClassifyJudge(source: string, input: GateInput) {
	const key = classifyCacheKey(input.tool, input.ctx.cwd, source);
	const cached = input.cache.get(key);
	if (cached && cached.role === "classify") return cached;

	const verdict = await judgeClassify(input.loaded.config.judgeModel, input.tool, input.ctx.cwd, source, {
		findModel: (provider, modelId) => input.ctx.modelRegistry.find(provider, modelId),
		getApiKeyAndHeaders: (m) => input.ctx.modelRegistry.getApiKeyAndHeaders(m),
		timeoutMs: input.loaded.config.judgeTimeoutMs,
		signal: input.ctx.signal,
	});
	if (verdict) input.cache.set(key, verdict);
	return verdict;
}
