/**
 * Permission Gate — CRUD + tier pipeline for pi tool calls.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAudit } from "./audit.ts";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { decide } from "./pipeline.ts";
import type { JudgeVerdict } from "./judge.ts";
import type { AuditEntry, Mode } from "./types.ts";

const STATUS_KEY = "perm-gate";
const MODE_ICON: Record<Mode, string> = { default: "🛡", auto: "⚡", off: "⏸" };

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
		judgeCache.clear();
		updateStatus(ctx);
		const { config } = loaded!;
		if (config.mode === "auto" && !config.judgeModel) {
			ctx.ui.notify(
				"permission-gate: auto mode with no judgeModel — T1 actions will be denied. Set judgeModel in ~/.pi/agent/permission-gate.json",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		judgeCache.clear();
	});

	function updateStatus(ctx: ExtensionContext) {
		if (!loaded) return;
		const { mode, dryRun, judgeModel } = loaded.config;
		if (mode === "off") {
			ctx.ui.setStatus(STATUS_KEY, `${MODE_ICON.off} gate:off`);
			return;
		}
		const judge = judgeModel ? " +judge" : " (no judge)";
		const dry = dryRun ? " dry-run" : "";
		ctx.ui.setStatus(STATUS_KEY, `${MODE_ICON[mode]} gate:${mode}${dry}${judge}`);
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!loaded) reload(ctx);
		const l = loaded!;

		const subject = subjectFor(event.toolName, event.input as Record<string, unknown>);
		if (subject === undefined) return undefined;

		const decision = await decide({
			tool: event.toolName,
			subject,
			ctx,
			loaded: l,
			sessionId,
			cache: judgeCache,
		});

		if (decision.wouldBe === "block") {
			ctx.ui.notify(`dry-run: would have blocked — ${decision.reason}`, "warning");
		}
		if (decision.verdict === "block") {
			return { block: true, reason: `permission-gate: ${decision.reason}` };
		}
		return undefined;
	});

	pi.registerCommand("gate", {
		description: "Permission gate: /gate [mode|dry-run|log|stats|config|help]",
		getArgumentCompletions: (prefix) => {
			const subs = ["mode", "dry-run", "log", "stats", "config", "help"];
			const modes = ["default", "auto", "off"];
			const onOff = ["on", "off"];
			const head = prefix.trim();
			const items =
				head.startsWith("mode ") ? modes : head.startsWith("dry-run ") ? onOff : subs;
			const last = head.split(/\s+/).pop() ?? "";
			const filtered = items.filter((s) => s.startsWith(last)).map((s) => ({ value: s, label: s }));
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
						ctx.ui.notify(`mode: ${l.config.mode} (usage: /gate mode default|auto|off)`, "info");
						return;
					}
					if (next !== "default" && next !== "auto" && next !== "off") {
						ctx.ui.notify(`unknown mode '${next}' — use default|auto|off`, "error");
						return;
					}
					l.config.mode = next;
					updateStatus(ctx);
					ctx.ui.notify(`permission-gate mode → ${next} (session only; edit permission-gate.json to persist)`, "info");
					return;
				}
				case "dry-run": {
					const next = rest[0];
					if (!next) {
						ctx.ui.notify(`dry-run: ${l.config.dryRun ? "on" : "off"} (usage: /gate dry-run on|off)`, "info");
						return;
					}
					if (next !== "on" && next !== "off") {
						ctx.ui.notify(`usage: /gate dry-run on|off`, "error");
						return;
					}
					l.config.dryRun = next === "on";
					updateStatus(ctx);
					ctx.ui.notify(`permission-gate dry-run → ${next} (session only)`, "info");
					return;
				}
				case "log": {
					if (!l.config.audit) {
						ctx.ui.notify(`audit is off — set "audit": true in permission-gate.json`, "info");
						return;
					}
					const entries = readAudit(l.config.logPath, 50);
					if (entries.length === 0) {
						ctx.ui.notify(`no audit entries yet (${l.config.logPath})`, "info");
						return;
					}
					showLog(entries.slice(-15), ctx);
					return;
				}
				case "stats": {
					if (!l.config.audit) {
						ctx.ui.notify(`audit is off — set "audit": true in permission-gate.json`, "info");
						return;
					}
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
							"/gate mode [default|auto|off] — show or set mode (session)",
							"/gate dry-run [on|off] — show or set dry-run (session)",
							"/gate log — recent decisions (requires audit)",
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
		return typeof input.path === "string" ? input.path : "";
	}
	return JSON.stringify(input).slice(0, 500);
}

function formatConfig(l: LoadedConfig): string {
	const c = l.config;
	return [
		`mode: ${c.mode}`,
		`dryRun: ${c.dryRun}`,
		`judgeModel: ${c.judgeModel || "(not configured)"}`,
		`audit: ${c.audit}`,
		`hardBlocksEnabled: ${c.hardBlocksEnabled}`,
		`allowedFiles: ${c.allowedFiles.length} · allow: ${c.allow.length} · deny: ${c.deny.length} · protected: ${c.protectedPaths.length}`,
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
		const judge = e.judge
			? ` judge:${e.judge.role}${e.judge.safe === false ? ":unsafe" : e.judge.safe === true ? ":safe" : ""}${e.judge.op ? `:${e.judge.op}` : ""}(${e.judge.ms}ms)`
			: "";
		const meta = [e.op, e.tier].filter(Boolean).join("/");
		const subject = e.subject.length > 80 ? e.subject.slice(0, 77) + "…" : e.subject;
		return `${time} ${verdictMark(e)} [${e.stage}${meta ? ` ${meta}` : ""}] ${subject}${judge}`;
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
		[...m.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `  ${k}: ${v}`)
			.join("\n");
	return [
		`${entries.length} decisions`,
		`by verdict:\n${fmt(byVerdict)}`,
		`by stage:\n${fmt(byStage)}`,
		judgeRuns ? `judge: ${judgeRuns} runs, avg ${Math.round(judgeMs / judgeRuns)}ms` : "judge: no runs",
	].join("\n");
}
