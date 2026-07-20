# pi-permission-gate

A [pi](https://github.com/earendil-works/pi-mono) extension that gates tool
calls through a multi-stage permission pipeline, with an **auto mode** that
uses static analysis + an LLM judge to decide whether a command is safe
without prompting on every action.

## How it works

Every gated tool call flows through this pipeline (cheapest stage first):

```
tool_call
  └─► 1. hard blocks        immutable, all modes (rm -rf /, mkfs /dev/sd*, fork bombs, ...)
  └─► 2. config rules       allow/deny regexes + sensitive-path globs
  └─► 3. static analyzer    hand-rolled shell parser + command DB
         ├─ provably read-only  ─► allow
         ├─ mutating / unknown  ─► continue
  └─► 4. LLM judge           light model evaluates the analyzer's structured breakdown
  └─► 5. user prompt         fallback when the judge can't decide (or no judge configured)
```

In **observe mode** the pipeline runs identically but never blocks (except
hard blocks); every decision is logged with what *would have* happened, so
you can tune your config before trusting auto mode.

### The static analyzer

A fail-closed shell parser (`src/analyzer/shell-parser.ts`) understands a
useful subset of shell grammar — pipelines, `&&`/`;`, redirections, command
substitutions, leading `VAR=val` assignments — and marks anything outside
that subset as `unanalyzable` so it routes to the judge rather than being
guessed. The command database (`src/analyzer/command-db.ts`) knows which
binaries are read-only, flag-dependent (`sed -i`, `find -delete`), or
always mutating, plus subcommand maps for `git`, `npm`, `docker`,
`kubectl`, `terraform`, etc.

Substitutions are analyzed recursively: `echo $(rm -rf dist)` is **not**
read-only just because `echo` is.

### The LLM judge

When the analyzer can't prove a command read-only, the judge evaluates it.
The judge never receives a raw command blob — it gets the parser's
**structured breakdown** (segments, binaries, flags, redirects, chained-with)
so it only reasons about risk, not shell grammar. This keeps the prompt
small and the success rate high.

Verdicts are cached per normalized command structure for the session, so
repeated commands like `git push origin main` are judged once.

## Install

```bash
pi install git:github.com/fujuntao/pi-permission-gate
```

Or try it without installing:

```bash
pi -e git:github.com/fujuntao/pi-permission-gate
```

## Configuration

Three layers, merged in order (later wins; project may tighten but not
loosen global guards):

| Layer | Path |
|-------|------|
| Defaults | built into the extension |
| Global | `~/.pi/agent/permission-gate.json` |
| Project | `<cwd>/.pi/permission-gate.json` (trusted projects only) |

```jsonc
{
  "mode": "auto",                 // "auto" | "observe" | "strict"
  "judgeModel": "anthropic/claude-haiku-4-5",  // required for auto mode; "provider/model-id"
  "judgeInObserveMode": true,     // run judge async in observe mode for tuning data
  "hardBlocksEnabled": true,      // immutable catastrophic blocks; escape hatch
  "allow": ["^git (status|diff|log)"],   // regex, checked after hard blocks
  "deny":  ["^docker system prune"],     // regex, deny always beats allow
  "sensitivePaths": ["~/.ssh", "**/.env", "**/auth.json"],
  "logPath": "~/.pi/agent/permission-gate.log",
  "judgeTimeoutMs": 15000
}
```

**The judge model must be explicitly configured.** With `mode: "auto"` but
no `judgeModel`, non-read-only commands fall back to a user prompt (same as
strict) and a warning fires on session start. No silent auto-pick.

## Modes

- **`auto`** — full pipeline. Read-only commands pass silently; mutating/
  unknown commands go to the judge, then a prompt on uncertainty.
- **`observe`** — pipeline runs but nothing is blocked (except hard blocks).
  Every decision is logged with what *would* have happened, plus the judge's
  async verdict when configured. Use this to tune before trusting auto.
- **`strict`** — no judge, no auto-allow beyond config rules; everything
  mutating/unknown prompts the user.

Switch at runtime with `/gate mode auto|observe|strict` (session-scoped;
edit the config file to persist).

## Commands

- `/gate mode [auto|observe|strict]` — show or set the mode (session only)
- `/gate log` — recent decisions with verdict colors
- `/gate stats` — decision breakdown by stage/verdict, judge latency
- `/gate config` — merged config + file paths
- `/gate help` — usage

A footer status line shows the current mode: `🛡 gate:auto +judge`.

## Audit log

Append-only JSONL at `~/.pi/agent/permission-gate.log` (configurable). One
line per decision, including the analyzer breakdown and judge details — the
data source for observe-mode tuning. Rotates at 5MB (keeps the last 1MB).

## Tool coverage

| Tool | Handling |
|------|----------|
| `bash` | full pipeline (parser + judge) |
| `read` / `grep` / `find` / `ls` | sensitive-path check, else allow |
| `write` / `edit` | sensitive-path check, then judge in auto mode |
| unknown/custom tools | treated as unknown → judge or prompt per mode |

## Development

```bash
cd main
npm install
npm run check   # tsc --noEmit
npm test        # 99 analyzer/classifier/hard-block/config tests
```

## License

MIT
