# pi-permission-gate

A [pi](https://github.com/earendil-works/pi-mono) extension that gates tool
calls so agents can loop fast while catastrophic operations stay blocked.

**Design goals**

- Prefer speed: routine create/read/update work should not interrupt the agent.
- Prevent catastrophe: hard blocks for weaponized commands; cautious delete.
- Credential-related paths are *protected*: for U/D they are **T1**.

## How it works

Every gated tool call flows through this pipeline:

```
tool_call
  └─► 1. classify            map the call to C | R | U | D (or unknown)
  └─► 2. hard blocks         immutable catastrophic denies (default / auto)
  └─► 3. custom rules        wildcard allow / deny (deny wins)
  └─► 4. assign tier         T2 | T1 | T0 from op + path context
  └─► 5. apply tier
         ├─ T2 ─► allow
         ├─ T1 ─► LLM judge  (see Modes)
         └─ T0 ─► prompt (default) / deny (auto)
  └─► 6. user prompt         when the mode/tier requires it
```

### Operation kinds (CRUD)

| Kind | Meaning | Examples |
| ------ | --------- | ---------- |
| **C** Create | Creates a new file/dir/resource | `write` new path, `mkdir`, `touch` |
| **R** Read | Observes without changing state | `read`, `grep`, `ls`, `cat`, `git status` |
| **U** Update | Modifies existing content/state | `edit`, `sed -i`, overwrite `write` |
| **D** Delete | Removes files/resources | `rm`, `git rm`, `unlink` |

Compound shell commands take the **most dangerous** kind among segments
(`D > U > C > R`).

**Opaque invocations** are interpreter or script launches whose real work
lives in a referenced file or inline source — e.g. `python script.py`,
`python -c '...'`, `node -e`, `bash other.sh`. Classification:

1. Load the script or inline source (file on disk, `-c` / `-e` payload,
   simple heredoc body).
2. Send that **exact source** to the LLM judge to classify operation kind
   (C / R / U / D) and target paths when possible. The result enters the
   normal tier matrix (and may then take a T1 safety judgment if the tier
   is T1).
3. When the body cannot be loaded, or the judge cannot return a kind,
   assign **T0**.

Dynamic shells with no recoverable body (`eval` of computed strings,
unknown binaries without a script argument) use step 3.

Ordinary bash is classified by the static shell analyzer (parser + command
DB). File tools are classified from the tool name and whether the target
path already exists. Opaque script bodies go to the judge for kind
classification.

### Hard blocks

A short, immutable list of catastrophic patterns (e.g. `rm -rf /`, fork
bombs, `mkfs` / `dd` to raw disks). Enforced in `default` and `auto`
(including dry-run). Skipped when `mode` is `off`.
`hardBlocksEnabled: false` disables them when needed.

### Custom rules (wildcards)

`allow` and `deny` use **wildcard** matching (`*`, `**`, `?`) against the
tool subject (command string or path).

- Deny always beats allow.
- Rules are checked after hard blocks and before tier assignment.
- Choosing **Always allow** / **Always allow similar** in a prompt appends a
  rule to the **global** config (`~/.pi/agent/permission-gate.json`).

### Tiers

| Tier | Meaning |
| ------ | --------- |
| **T2** | Pass — no judge, no prompt |
| **T1** | LLM judge decides |
| **T0** | No judge — human prompt (`default`) or auto-deny (`auto`) |

### Path context for U and D

First matching rule wins:

1. **Protected path** → **T1**
2. **Gitignored** → **T1**
3. **Matches `allowedFiles` and git-tracked** → **T2**
4. **Else** → **T0**

**Protected paths** are globs for credential- and auth-related locations
(`~/.ssh`, `**/.env`, `**/*.pem`, …). For **U** and **D**, a matching path
is **T1**. **C** and **R** use the `allowedFiles` rules below.

### Create and Read

| Op | Path matches `allowedFiles` | No match |
| ---- | ------------------------------ | ---------- |
| **R** | T2 | T0 |
| **C** | T2 | T0 |

### The LLM judge

Used in two roles:

1. **T1 allow/deny (or prompt)** — blast radius / irreversibility, using the
   analyzer’s structured breakdown when available.
2. **Opaque op classification** — for interpreter/script bodies, the judge
   receives the **exact source** and returns an operation kind (C/R/U/D)
   plus target paths when possible; that result feeds the normal tier
   matrix (and may then require a T1 safety judgment if the tier is T1).

Verdicts are cached per exact tool, cwd, and subject for the session.

### User prompt

When a human decision is required, options are:

1. **Allow once** — this call only
2. **Always allow** — append an exact-match wildcard rule to global config
3. **Always allow similar** — append a broader wildcard rule (suggested from
   the subject; user confirms)
4. **Deny** — block this call

## Modes

| Mode | T2 | T1 | T0 | Human attention |
| ------ | ---- | ---- | ----- | ----------------- |
| **default** | Pass | Judge → allow **or prompt** | Always prompt | When needed |
| **auto** | Pass | Judge → allow **or deny** | Auto-deny | None |
| **off** | — | — | — | None (passthrough) |

Config default: `"mode": "default"`.

- **`default`** — interactive gate: fast on T2, judge on T1, ask on T0.
- **`auto`** — unattended: never prompts; T1 is judge-final; T0 is denied.
- **`off`** — every tool call passes through; no classification, judge,
  prompt, hard blocks, or custom rules.

**Dry-run** (`"dryRun": true`) applies to **default** and **auto** only
(ignored when `mode` is `off`). It keeps that mode’s classification and
judge behavior, records what the verdict **would be**, and only enforces
hard blocks.

| Combo | What you are testing |
| ------- | ---------------------- |
| `default` | live interactive gate |
| `auto` | live unattended gate |
| `default` + `dryRun` | would prompt vs allow under default |
| `auto` + `dryRun` | would deny vs allow under auto |
| `off` | gate disabled |

Runtime (session-scoped; persist via config):

- `/gate mode default|auto|off`
- `/gate dry-run on|off`

**Judge model:** must be explicitly configured (`judgeModel`). If missing:

- **default** — T1 falls through to prompt.
- **auto** — T1 is denied; warn on session start.
- **dryRun** — same would-be outcomes as the active mode above.
- **off** — judge is unused.

## Configuration

Three layers, merged in order (later wins; project may tighten but not
loosen global guards):

| Layer | Path |
| ------- | ------ |
| Defaults | built into the extension |
| Global | `~/.pi/agent/permission-gate.json` |
| Project | `<cwd>/.pi/permission-gate.json` (trusted projects only) |

```jsonc
{
  // How the gate behaves:
  //   "default" — ask when unsure
  //   "auto"    — never ask; judge decides or denies
  //   "off"     — disable the gate
  "mode": "default",

  // Preview decisions without blocking (except catastrophic hard blocks).
  // Ignored when mode is "off".
  "dryRun": false,

  // Model used to judge risky actions. Format: "provider/model-id".
  "judgeModel": "anthropic/claude-haiku-4-5",

  // Write every decision to the audit log file.
  "audit": false,

  // Block catastrophic commands like `rm -rf /`. Set false to disable.
  "hardBlocksEnabled": true,

  // Files the agent may freely create/read (glob patterns).
  // Updates/deletes on these paths are also easier to auto-approve when git-tracked.
  "allowedFiles": ["**/*"],

  // Tool names treated as read-only (op=read → T2 → allow, no LLM judge).
  // Most read-only tools are auto-discovered from pi tool metadata at
  // session start; use this only to force-classify a tool the heuristic
  // missed (e.g. an unusually-named query tool). Merges additively.
  "readonlyTools": ["my_custom_query_tool"],

  // Always allow matching commands or paths (wildcard patterns).
  "allow": ["git status", "git diff *"],

  // Always deny matching commands or paths (wildcard patterns). Deny wins over allow.
  "deny": ["docker system prune*"],

  // Credential-like paths. Updates and deletes here always go through the judge.
  "protectedPaths": [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "**/.env",
    "**/.env.*",
    "**/auth.json",
    "~/.pi/agent/auth.json",
    "**/id_rsa",
    "**/id_ed25519",
    "**/*.pem",
    "**/*.key"
  ],

  // Where to write the audit log (used when audit is true).
  "logPath": "~/.pi/agent/permission-gate.log",

  // How long to wait for the judge before falling back (milliseconds).
  "judgeTimeoutMs": 15000
}
```

**Always allow / Always allow similar** always append to the **global**
`allow` list, even when a project config layer is present.

Lists (`allow`, `deny`, `allowedFiles`, `protectedPaths`, `readonlyTools`)
merge as additive unions across layers. Project config may enable
`hardBlocksEnabled` when the merged global value is false; it cannot
disable hard blocks that the global layer left enabled. Project config may
set `mode` to `default` or `auto`, but only the global layer may set
`mode` to `off`.

## Commands

- `/gate mode [default|auto|off]` — show or set the mode (session only)
- `/gate dry-run [on|off]` — show or set dry-run (session only; ignored when mode is off)
- `/gate log` — recent decisions with verdict colors (requires `audit`)
- `/gate stats` — decision breakdown by stage/verdict, judge latency
- `/gate config` — merged config + file paths
- `/gate help` — usage

A footer status line shows the current state, e.g. `🛡 gate:default +judge`,
`🛡 gate:auto dry-run`, or `🛡 gate:off`.

## Audit log

When `"audit": true`, every decision under **default** or **auto** (with or
without dry-run) is appended as JSONL to `logPath` (default
`~/.pi/agent/permission-gate.log`). Each line includes op kind, tier,
analyzer breakdown, judge details, and `wouldBe` when `dryRun` is on. The
file rotates at 5MB (keeps the last 1MB).

When `"audit": false`, decisions are not written to disk (`/gate log` /
`/gate stats` stay empty). Dry-run still classifies and judges for
in-session would-be outcomes; disk recording is controlled only by `audit`.
Mode `off` produces no audit entries.

## Tool coverage

| Tool | Handling |
| ------ | ---------- |
| `bash` | classify via shell analyzer → full pipeline |
| `bash` opaque (`python` / `node` / nested scripts, …) | load source → judge classifies op kind → tier matrix |
| read-only tools (auto-discovered + `readonlyTools`) | **R** → T2 allow, no judge |
| `read` / `grep` / `find` / `ls` | **R** → tier by `allowedFiles` glob |
| `write` (new path) | **C** → tier by `allowedFiles` glob |
| `write` (existing) / `edit` | **U** → path tiering |
| delete-like bash (`rm`, …) | **D** → path tiering |
| unknown / custom tools | recover input body when possible → same opaque path; else T0 |

Read-only tools are discovered at session start from pi tool metadata
(`pi.getAllTools()`): a tool qualifies when its name matches a read-only
pattern (`read`, `search`, `query`, `get`, `find`, `diagnostics`, …), does
not match any mutation pattern (`write`, `edit`, `execute`, `replace`, …),
and carries no mutation-indicating parameters (`content`, `command`,
`edits`, `config`, `message`). Anything uncertain is left unclassified and
falls through to the opaque/judge path. Use `readonlyTools` to
force-classify a tool the heuristic misses.

## Decision matrix (summary)

```
mode off?                      → allow (passthrough)
Hard block?                    → deny
Wildcard deny?                 → deny
Wildcard allow?                → allow

R/C  matches allowedFiles      → T2
R/C  no match                  → T0

U/D  protected                 → T1
U/D  gitignored                → T1
U/D  allowedFiles + tracked    → T2
U/D  else                      → T0

opaque → load source → judge-classify kind → matrix above;
         unresolved kind → T0

Then: T2 allow | T1 judge (per mode) | T0 prompt or deny (per mode)
      dryRun → allow (except hard blocks) + record wouldBe
```

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node:test
```

## License

MIT
