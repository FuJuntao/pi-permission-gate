/**
 * Three-layer config: defaults → global (~/.pi/agent/permission-gate.json)
 * → project (<cwd>/.pi/permission-gate.json, trusted projects only).
 *
 * Security rule: project config may TIGHTEN but never LOOSEN global guards.
 * Practically: deny/allow lists and sensitive paths are additive (union);
 * scalar settings (mode, judgeModel, ...) follow global → project override.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type GateConfig, type Mode } from "./types.ts";

const FILE_NAME = "permission-gate.json";

type PartialConfig = Partial<{
	mode: Mode;
	judgeModel: string;
	judgeInObserveMode: boolean;
	hardBlocksEnabled: boolean;
	allow: string[];
	deny: string[];
	sensitivePaths: string[];
	logPath: string;
	judgeTimeoutMs: number;
}>;

export function expandPath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function readJsonFile(path: string): PartialConfig | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as PartialConfig;
	} catch {
		return undefined; // malformed config: ignore rather than crash the gate
	}
}

function validateRegexes(list: string[] | undefined): string[] {
	if (!Array.isArray(list)) return [];
	const ok: string[] = [];
	for (const p of list) {
		if (typeof p !== "string") continue;
		try {
			new RegExp(p);
			ok.push(p);
		} catch {
			// skip invalid pattern
		}
	}
	return ok;
}

function mergeLayer(base: GateConfig, layer: PartialConfig | undefined, source: "global" | "project"): GateConfig {
	if (!layer) return base;
	const merged = { ...base };

	// Lists are additive in both directions (union, deduped).
	merged.allow = [...new Set([...base.allow, ...validateRegexes(layer.allow)])];
	merged.deny = [...new Set([...base.deny, ...validateRegexes(layer.deny)])];
	merged.sensitivePaths = [...new Set([...base.sensitivePaths, ...(Array.isArray(layer.sensitivePaths) ? layer.sensitivePaths.filter((s) => typeof s === "string") : [])])];

	// Scalars: project overrides global.
	if (layer.mode === "auto" || layer.mode === "observe" || layer.mode === "strict") merged.mode = layer.mode;
	if (typeof layer.judgeModel === "string") merged.judgeModel = layer.judgeModel;
	if (typeof layer.judgeInObserveMode === "boolean") merged.judgeInObserveMode = layer.judgeInObserveMode;
	// hardBlocksEnabled: only ever flips toward more strict from project layer.
	if (source === "global" && typeof layer.hardBlocksEnabled === "boolean") merged.hardBlocksEnabled = layer.hardBlocksEnabled;
	if (source === "project" && layer.hardBlocksEnabled === true && !base.hardBlocksEnabled) merged.hardBlocksEnabled = true;
	if (typeof layer.logPath === "string" && source === "global") merged.logPath = layer.logPath;
	if (typeof layer.judgeTimeoutMs === "number" && layer.judgeTimeoutMs > 0) merged.judgeTimeoutMs = layer.judgeTimeoutMs;

	return merged;
}

export interface LoadedConfig {
	config: GateConfig;
	globalPath: string;
	projectPath?: string;
}

export function loadConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
	const globalPath = join(getAgentDir(), FILE_NAME);
	const projectPath = join(cwd, CONFIG_DIR_NAME, FILE_NAME);

	let config = mergeLayer({ ...DEFAULT_CONFIG }, readJsonFile(globalPath), "global");
	const usedProjectPath = projectTrusted && existsSync(projectPath) ? projectPath : undefined;
	if (usedProjectPath) {
		config = mergeLayer(config, readJsonFile(projectPath), "project");
	}

	config.logPath = expandPath(config.logPath);
	return { config, globalPath, projectPath: usedProjectPath };
}

/** Match a command against allow/deny regex lists. Deny wins over allow. */
export function matchConfigRules(config: GateConfig, command: string): "deny" | "allow" | undefined {
	for (const p of config.deny) {
		if (new RegExp(p).test(command)) return "deny";
	}
	for (const p of config.allow) {
		if (new RegExp(p).test(command)) return "allow";
	}
	return undefined;
}

/**
 * Minimal glob matcher for sensitive paths.
 * Supports: `**` (any depth), `*` (within a segment), leading `~/`.
 * A pattern without wildcards matches the path itself or anything beneath it.
 */
export function matchSensitivePath(patterns: string[], inputPath: string): string | undefined {
	const normalized = resolve(expandPath(inputPath));
	for (const raw of patterns) {
		const pattern = expandPath(raw);
		if (globMatch(pattern, normalized)) return raw;
	}
	return undefined;
}

function globMatch(pattern: string, path: string): boolean {
	// No wildcards: exact or prefix-at-boundary (dir covers its subtree).
	if (!pattern.includes("*")) {
		return path === pattern || path.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
	}
	const pSegs = pattern.split("/").filter((s) => s !== "");
	const tSegs = path.split("/").filter((s) => s !== "");
	return matchSegs(pSegs, tSegs);
}

function matchSegs(p: string[], t: string[]): boolean {
	if (p.length === 0) return t.length === 0;
	const [head, ...rest] = p;
	if (head === "**") {
		// ** matches zero or more segments.
		if (matchSegs(rest, t)) return true;
		if (t.length > 0) return matchSegs(p, t.slice(1));
		return false;
	}
	if (t.length === 0) return false;
	if (!matchOne(head!, t[0]!)) return false;
	return matchSegs(rest, t.slice(1));
}

function matchOne(pattern: string, seg: string): boolean {
	const re = new RegExp("^" + pattern.split("*").map(escapeRe).join("[^/]*") + "$");
	return re.test(seg);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
