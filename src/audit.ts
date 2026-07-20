/**
 * Append-only JSONL audit log. Every gate decision is recorded — this is
 * the data source for observe-mode tuning (/gate stats, /gate tune).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry } from "./types.ts";

/** Soft cap: rotate when the log exceeds this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
/** How much of the tail to keep when rotating. */
const KEEP_TAIL_BYTES = 1024 * 1024; // 1MB

export function appendAudit(logPath: string, entry: AuditEntry): void {
	try {
		const dir = dirname(logPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		rotateIfNeeded(logPath);
		appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
	} catch {
		// Auditing must never break the gate.
	}
}

function rotateIfNeeded(logPath: string): void {
	try {
		if (!existsSync(logPath)) return;
		const size = statSync(logPath).size;
		if (size < MAX_LOG_BYTES) return;
		const content = readFileSync(logPath, "utf8");
		const tail = content.slice(-KEEP_TAIL_BYTES);
		const firstNewline = tail.indexOf("\n");
		writeFileSync(logPath, firstNewline === -1 ? tail : tail.slice(firstNewline + 1), "utf8");
	} catch {
		// best effort
	}
}

export function readAudit(logPath: string, limit = 200): AuditEntry[] {
	try {
		if (!existsSync(logPath)) return [];
		const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
		const entries: AuditEntry[] = [];
		for (const line of lines.slice(-limit)) {
			try {
				entries.push(JSON.parse(line) as AuditEntry);
			} catch {
				// skip corrupt line
			}
		}
		return entries;
	} catch {
		return [];
	}
}
