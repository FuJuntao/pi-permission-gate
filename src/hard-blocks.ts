/**
 * Hard blocks: immutable, catastrophic-only deny patterns.
 *
 * These are checked before everything else, in every mode (including
 * observe), and cannot be extended or removed via config. The only escape
 * hatch is `hardBlocksEnabled: false` in config — a deliberate act.
 *
 * Keep this list SHORT. Only operations that are:
 *   - catastrophic and unrecoverable (root filesystem wipe, disk format), or
 *   - classic weaponized payloads (fork bomb)
 * Everything else belongs in the analyzer, the judge, or user config.
 */

interface HardBlock {
	pattern: RegExp;
	reason: string;
}

const HARD_BLOCKS: HardBlock[] = [
	{
		// rm -rf /  ·  rm -rf /*  ·  rm -rf --no-preserve-root /
		pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--\w[\w-]*\s+)*(--no-preserve-root\s+)?\/\s*(?:\*+\s*)?$/,
		reason: "recursive delete of filesystem root",
	},
	{
		// rm -rf ~  ·  rm -rf ~/  ·  rm -rf $HOME  ·  rm -rf ${HOME}
		pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--\w[\w-]*\s+)*(~\/??|\$\{?HOME\}?)\s*$/,
		reason: "recursive delete of home directory",
	},
	{
		// The classic fork bomb, in any whitespace arrangement.
		pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
		reason: "fork bomb",
	},
	{
		// mkfs on a real block device.
		pattern: /\bmkfs(?:\.\w+)?\b[^|;&]*\/dev\/(?:sd|nvme|vd|xvd|hd|mmcblk)/i,
		reason: "formatting a block device",
	},
	{
		// dd writing onto a real block device.
		pattern: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|vd|xvd|hd|mmcblk)/i,
		reason: "raw write to a block device",
	},
	{
		// Redirect writing onto a real block device:  > /dev/sda
		pattern: />>?\s*\/dev\/(?:sd|nvme|vd|xvd|hd|mmcblk)/i,
		reason: "redirect overwrites a block device",
	},
	{
		// shred/wipe of a whole device.
		pattern: /\b(?:shred|wipefs|blkdiscard)\b[^|;&]*\/dev\/(?:sd|nvme|vd|xvd|hd|mmcblk)/i,
		reason: "secure-erase of a block device",
	},
];

/**
 * Returns a reason when the command hits a hard block, else undefined.
 */
export function matchHardBlock(command: string): string | undefined {
	for (const { pattern, reason } of HARD_BLOCKS) {
		if (pattern.test(command)) return reason;
	}
	return undefined;
}
