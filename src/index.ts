/**
 * Permission Gate
 *
 * Prompts for confirmation before potentially dangerous tool calls.
 * In non-interactive mode (print/json), dangerous commands are blocked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const dangerousPatterns: RegExp[] = [
	/\brm\s+(-[a-zA-Z]*[rf]|--recursive|--force)/i, // rm -rf, rm -r, rm --recursive, etc.
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bmkfs\b/i,
	/\bdd\s+.*of=/i, // dd of=...
	/>\s*\/dev\/sd/i, // redirect to block device
	/\bshutdown\b|\breboot\b|\bhalt\b/i,
	/\b(kill|pkill|killall)\s+-9/i,
	/\b(git\s+push)\b.*(--force|-f)\b/i,
	/\b(npm|pnpm|yarn)\s+(publish|unpublish)/i,
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const matched = dangerousPatterns.find((p) => p.test(command));

		if (!matched) return undefined;

		if (!ctx.hasUI) {
			// Non-interactive (print/json mode): block by default
			return { block: true, reason: `Dangerous command blocked (matched ${matched}, no UI for confirmation)` };
		}

		const choice = await ctx.ui.select(
			`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
			["Yes", "Yes, don't ask again this session", "No"],
		);

		if (choice === "No" || choice === undefined) {
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}
