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
  └─► 3. file edit policy   allow edits to tracked files or files mutated this session
  └─► 4. static analyzer    hand-rolled shell parser + command DB
         ├─ provably read-only  ─► allow
         ├─ mutating / unknown  ─► continue
  └─► 5. LLM judge          light model evaluates the analyzer's structured breakdown
  └─► 6. user prompt        fallback when the judge can't decide (or no judge configured)
```

In **observe mode** the pipeline runs identically but never blocks (except
hard blocks). Definite rule denials and unsafe asynchronous judge verdicts
are reported without claiming that pending judgments would have blocked.

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

### File edit policy

In trusted projects, `edit` is allowed for Git-tracked regular files after
sensitive-path and symlink checks. A successful `write` or `edit` of another
regular project file grants later `edit` calls for that file in the same
session. Grants are restored on reload/resume, but reads never create grants
and `write` always requires its normal judgment.

### The LLM judge

When the analyzer can't prove a command read-only, the judge evaluates the
raw subject together with the parser's **structured breakdown** (segments,
binaries, flags, redirects, chained-with). This lets it handle fail-closed
constructs without asking it to reconstruct ordinary shell grammar.

Verdicts are cached per exact tool, working directory, and subject for the
session. Repeated identical actions are judged once, while partially parsed
commands can never share a security verdict.

## Install

```bash
pi install git:github.com/FuJuntao/pi-permission-gate
```

Or try it without installing:

```bash
pi -e git:github.com/FuJuntao/pi-permission-gate
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
  Every decision is logged, plus the judge's async verdict when configured.
  Warnings are shown only for definite rule denials or unsafe judge verdicts.
- **`strict`** — no judge. Read-only actions and trusted tracked/session edits
  still pass; everything else mutating or unknown prompts the user.

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
| `edit` | sensitive-path check; in trusted projects, tracked regular files and files successfully mutated this session are allowed; otherwise judge |
| `write` | sensitive-path check, then judge; successful project writes grant later `edit` calls for that session |
| unknown/custom tools | treated as unknown → judge or prompt per mode |

## Development

```bash
cd main
npm install
npm run check   # tsc --noEmit
npm test        # analyzer, pipeline, judge-cache, and file-edit-policy tests
```

## License

MIT
