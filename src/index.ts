/**
 * Permission Gate
 *
 * Auto-mode permission pipeline for pi tool calls:
 *   hard blocks → config rules → static read-only analysis → LLM judge → prompt
 * with an observe mode that logs decisions without blocking, for tuning.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendAudit, readAudit } from "./audit.ts";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { decide } from "./pipeline.ts";
import type { JudgeVerdict } from "./judge.ts";
import type { AuditEntry, Mode } from "./types.ts";

const STATUS_KEY = "perm-gate";
const MODE_ICON: Record<Mode, string> = { auto: "🛡", observe: "👁", strict: "🔒" };

export default function (pi: ExtensionAPI) {
	let loaded: LoadedConfig | undefined;
	let sessionId: string | undefined;
	const judgeCache = new Map<string, JudgeVerdict>();

	const reload = (ctx: ExtensionContext) => {
		loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
	};

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx);
		sessionId = ctx.sessionManager.getSessionId();
		updateStatus(ctx);
		const { config } = loaded!;
		if (config.mode === "auto" && !config.judgeModel) {
			ctx.ui.notify(
				"permission-gate: auto mode with no judgeModel configured — non-read-only commands will prompt. Set judgeModel in ~/.pi/agent/permission-gate.json",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		judgeCache.clear();
	});

	function updateStatus(ctx: ExtensionContext) {
		if (!loaded) return;
		const { mode, judgeModel } = loaded.config;
		const judge = mode === "auto" ? (judgeModel ? ` +judge` : " (no judge)") : "";
		ctx.ui.setStatus(STATUS_KEY, `${MODE_ICON[mode]} gate:${mode}${judge}`);
	}

	// ---------- tool gating ----------

	pi.on("tool_call", async (event, ctx) => {
		if (!loaded) reload(ctx);
		const l = loaded!;

		const subject = subjectFor(event.toolName, event.input as Record<string, unknown>);
		if (subject === undefined) return undefined; // tool we don't gate

		const decision = await decide({
			tool: event.toolName,
			subject,
			ctx,
			loaded: l,
			sessionId,
			cache: judgeCache,
			onAsyncJudge: (entry) => {
				appendAudit(l.config.logPath, entry);
			},
		});

		if (decision.wouldBe === "block" && decision.stage === "observe") {
			ctx.ui.notify(`observe: would have blocked — ${decision.reason}`, "warning");
		}
		if (decision.verdict === "block") {
			return { block: true, reason: `permission-gate: ${decision.reason}` };
		}
		return undefined;
	});

	// ---------- /gate command ----------

	pi.registerCommand("gate", {
		description: "Permission gate: /gate [mode|log|stats|config|help]",
		getArgumentCompletions: (prefix) => {
			const subs = ["mode", "log", "stats", "config", "help"];
			const modes = ["auto", "observe", "strict"];
			const items = (prefix.startsWith("mode ") ? modes : subs).map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix.split(" ").pop() ?? ""));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!loaded) reload(ctx);
			const l = loaded!;
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

			switch (sub ?? "help") {
				case "mode": {
					const next = rest[0] as Mode | undefined;
					if (!next) {
						ctx.ui.notify(`mode: ${l.config.mode} (usage: /gate mode auto|observe|strict)`, "info");
						return;
					}
					if (next !== "auto" && next !== "observe" && next !== "strict") {
						ctx.ui.notify(`unknown mode '${next}' — use auto|observe|strict`, "error");
						return;
					}
					l.config.mode = next; // session-scoped; persist by editing config file
					updateStatus(ctx);
					ctx.ui.notify(`permission-gate mode → ${next} (session only; edit permission-gate.json to persist)`, "info");
					return;
				}
				case "log": {
					const entries = readAudit(l.config.logPath, 50);
					if (entries.length === 0) {
						ctx.ui.notify(`no audit entries yet (${l.config.logPath})`, "info");
						return;
					}
					showLog(entries.slice(-15), ctx);
					return;
				}
				case "stats": {
					const entries = readAudit(l.config.logPath, 2000);
					ctx.ui.notify(buildStats(entries), "info");
					return;
				}
				case "config": {
					ctx.ui.notify(formatConfig(l), "info");
					return;
				}
				default: {
					ctx.ui.notify(
						[
							"/gate mode [auto|observe|strict] — show or set mode (session)",
							"/gate log — recent decisions",
							"/gate stats — decision breakdown",
							"/gate config — merged config + file paths",
						].join("\n"),
						"info",
					);
				}
			}
		},
	});
}

function subjectFor(tool: string, input: Record<string, unknown>): string | undefined {
	if (tool === "bash") return typeof input.command === "string" ? input.command : undefined;
	if (tool === "write" || tool === "edit" || tool === "read") {
		return typeof input.path === "string" ? input.path : undefined;
	}
	if (tool === "grep" || tool === "find" || tool === "ls") {
		// Read-only by design; the pipeline still runs them through sensitive-path checks.
		return typeof input.path === "string" ? input.path : "";
	}
	// Unknown/custom tools: gate on a serialized form.
	return JSON.stringify(input).slice(0, 500);
}

function formatConfig(l: LoadedConfig): string {
	const c = l.config;
	return [
		`mode: ${c.mode}`,
		`judgeModel: ${c.judgeModel || "(not configured)"}`,
		`judgeInObserveMode: ${c.judgeInObserveMode}`,
		`hardBlocksEnabled: ${c.hardBlocksEnabled}`,
		`allow rules: ${c.allow.length} · deny rules: ${c.deny.length} · sensitive paths: ${c.sensitivePaths.length}`,
		`log: ${c.logPath}`,
		`global config: ${l.globalPath}`,
		`project config: ${l.projectPath ?? "(none / untrusted)"}`,
	].join("\n");
}

function verdictMark(e: AuditEntry): string {
	if (e.wouldBe === "block") return "🚫would-block";
	if (e.verdict === "block") return "⛔blocked";
	return "✅allowed";
}

function showLog(entries: AuditEntry[], ctx: ExtensionContext) {
	const lines = entries.map((e) => {
		const time = new Date(e.ts).toLocaleTimeString();
		const judge = e.judge ? ` judge:${e.judge.safe ? "safe" : "unsafe"}(${e.judge.ms}ms${e.judge.async ? ",async" : ""})` : "";
		const subject = e.subject.length > 80 ? e.subject.slice(0, 77) + "…" : e.subject;
		return `${time} ${verdictMark(e)} [${e.stage}] ${subject}${judge}`;
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

function buildStats(entries: AuditEntry[]): string {
	if (entries.length === 0) return "no audit entries yet";
	const byStage = new Map<string, number>();
	const byVerdict = new Map<string, number>();
	let judgeRuns = 0;
	let judgeMs = 0;
	for (const e of entries) {
		byStage.set(e.stage, (byStage.get(e.stage) ?? 0) + 1);
		const v = e.wouldBe ? `would-${e.wouldBe}` : e.verdict;
		byVerdict.set(v, (byVerdict.get(v) ?? 0) + 1);
		if (e.judge) {
			judgeRuns++;
			judgeMs += e.judge.ms;
		}
	}
	const fmt = (m: Map<string, number>) =>
		[...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n");
	return [
		`${entries.length} decisions`,
		`by verdict:\n${fmt(byVerdict)}`,
		`by stage:\n${fmt(byStage)}`,
		judgeRuns ? `judge: ${judgeRuns} runs, avg ${Math.round(judgeMs / judgeRuns)}ms` : "judge: no runs",
	].join("\n");
}
