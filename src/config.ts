/**
 * Three-layer config: defaults → global (~/.pi/agent/permission-gate.json)
 * → project (<cwd>/.pi/permission-gate.json, trusted projects only).
 *
 * Security rule: project config may TIGHTEN but never LOOSEN global guards.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchPathGlob } from "./glob.ts";
import { expandPath, isWithin } from "./paths.ts";
import { matchWildcardList } from "./wildcard.ts";
import { DEFAULT_CONFIG, type GateConfig, type Mode } from "./types.ts";

const FILE_NAME = "permission-gate.json";

type PartialConfig = Partial<{
	mode: Mode;
	dryRun: boolean;
	judgeModel: string;
	audit: boolean;
	hardBlocksEnabled: boolean;
	allowedFiles: string[];
	disposablePaths: string[];
	readonlyTools: string[];
	allow: string[];
	deny: string[];
	protectedPaths: string[];
	/** @deprecated read for migration */
	sensitivePaths: string[];
	logPath: string;
	judgeTimeoutMs: number;
}>;

function readJsonFile(path: string): PartialConfig | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as PartialConfig;
	} catch {
		return undefined;
	}
}

function stringList(list: string[] | undefined): string[] {
	if (!Array.isArray(list)) return [];
	return list.filter((s) => typeof s === "string");
}

function mergeLayer(base: GateConfig, layer: PartialConfig | undefined, source: "global" | "project"): GateConfig {
	if (!layer) return base;
	const merged = { ...base };

	merged.allow = [...new Set([...base.allow, ...stringList(layer.allow)])];
	merged.deny = [...new Set([...base.deny, ...stringList(layer.deny)])];
	merged.allowedFiles = [...new Set([...base.allowedFiles, ...stringList(layer.allowedFiles)])];
	merged.disposablePaths = [...new Set([...base.disposablePaths, ...stringList(layer.disposablePaths)])];
	merged.readonlyTools = [...new Set([...base.readonlyTools, ...stringList(layer.readonlyTools)])];
	const protectedExtra = [...stringList(layer.protectedPaths), ...stringList(layer.sensitivePaths)];
	merged.protectedPaths = [...new Set([...base.protectedPaths, ...protectedExtra])];

	if (source === "global") {
		if (layer.mode === "default" || layer.mode === "auto" || layer.mode === "off") merged.mode = layer.mode;
		if (typeof layer.hardBlocksEnabled === "boolean") merged.hardBlocksEnabled = layer.hardBlocksEnabled;
		if (typeof layer.logPath === "string") merged.logPath = layer.logPath;
	} else {
		// Project may set default/auto, not off.
		if (layer.mode === "default" || layer.mode === "auto") merged.mode = layer.mode;
		if (layer.hardBlocksEnabled === true && !base.hardBlocksEnabled) merged.hardBlocksEnabled = true;
	}

	if (typeof layer.dryRun === "boolean") merged.dryRun = layer.dryRun;
	if (typeof layer.judgeModel === "string") merged.judgeModel = layer.judgeModel;
	if (typeof layer.audit === "boolean") merged.audit = layer.audit;
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

	let config = mergeLayer({ ...DEFAULT_CONFIG, allow: [...DEFAULT_CONFIG.allow], deny: [...DEFAULT_CONFIG.deny], allowedFiles: [...DEFAULT_CONFIG.allowedFiles], protectedPaths: [...DEFAULT_CONFIG.protectedPaths] }, readJsonFile(globalPath), "global");
	const usedProjectPath = projectTrusted && existsSync(projectPath) ? projectPath : undefined;
	if (usedProjectPath) {
		config = mergeLayer(config, readJsonFile(projectPath), "project");
	}

	config.logPath = expandPath(config.logPath);
	return { config, globalPath, projectPath: usedProjectPath };
}

/** Match subject against allow/deny wildcards. Deny wins. */
export function matchConfigRules(config: GateConfig, subject: string): "deny" | "allow" | undefined {
	if (matchWildcardList(config.deny, subject)) return "deny";
	if (matchWildcardList(config.allow, subject)) return "allow";
	return undefined;
}

export function matchProtectedPath(config: GateConfig, inputPath: string): string | undefined {
	return matchPathGlob(config.protectedPaths, inputPath);
}

export function matchAllowedFile(config: GateConfig, inputPath: string): string | undefined {
	return matchPathGlob(config.allowedFiles, inputPath);
}

/** True for paths strictly beneath a disposable root (e.g. /tmp/foo, not /tmp). */
export function matchDisposablePath(config: GateConfig, inputPath: string): string | undefined {
	const normalized = resolve(expandPath(inputPath));
	for (const raw of config.disposablePaths) {
		const root = resolve(expandPath(raw));
		if (isWithin(root, normalized)) return raw;
	}
	return undefined;
}

/** Append an allow rule to the global config file and the in-memory config. */
export function appendGlobalAllow(loaded: LoadedConfig, pattern: string): void {
	if (loaded.config.allow.includes(pattern)) return;
	loaded.config.allow = [...loaded.config.allow, pattern];

	const existing = readJsonFile(loaded.globalPath) ?? {};
	const allow = [...new Set([...stringList(existing.allow), pattern])];
	const next = { ...existing, allow };
	try {
		const dir = dirname(loaded.globalPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(loaded.globalPath, JSON.stringify(next, null, 2) + "\n", "utf8");
	} catch {
		// Persistence failure must not break the allow-once path.
	}
}

export { expandPath };
