# pi-rules-md

Pi extension that discovers markdown rule files and injects conditionally
matched ones into the system prompt. Rules can activate when the agent touches
files matching their globs, matching files exist in the project, a selected
tool, model, or git branch matches, prompt-derived intent satisfies its glob
condition, or the rule is always active.

Functional core / imperative shell; pure functions and data, no classes.

## How it works

1. **Discovery** — every turn, rule files are discovered from
   `<project>/.pi/rules/**/*.md` (when the project is trusted) and
   `~/.pi/agent/rules/**/*.md` (always), parsed with a strict schema, and
   cached by mtime.
2. **Matching** — each rule's activation is evaluated against the live
   session: touched paths, existing files, selected tools, current model, git
   branch, and prompt-derived intent. The `exists` file scan is cached per
   working directory and glob set, and re-run only after a `write`, `edit`, or
   `bash` tool result or a glob-set change — see
   [Exists-scan cache](RULE-SPEC.md#exists-scan-cache).
3. **Selection** — pinned rule bodies are content-deduped, budgeted, and
   ordered for presentation. On-demand rules are listed by path instead of
   having their bodies injected.
4. **Injection** — the selected rules and on-demand index are rendered into a
   single `pi-rules-md` system-prompt section via
   `systemPromptOptions.sections` in `before_agent_start`. The section is
   re-applied every turn while rules are active; identical content produces no
   prompt diff, and the section is removed when nothing is active.

Mid-run delivery is being built on top of that section: rules that only become
active because of a `read`/`edit`/`write` result are appended to that tool
result, once per rule per session. The pure core (which rules are new, the
remaining budget, the attachment block) is specified in
[RULE-SPEC.md §6](RULE-SPEC.md#mid-run-attachment-core); the event wiring is
still pending.

The complete rule-file contract is specified in [RULE-SPEC.md](RULE-SPEC.md).

## Quick start

```markdown
---
description: Follow repo conventions when editing core sources.
version: 1
globs:
  - "src/**/*.ts"
  - "!src/**/*.test.ts"
match: touched
priority: 10
---
Use tabs, keep functions pure, and never introduce classes in src/.
```

Drop that file in `.pi/rules/` and start pi. When you edit any
non-test `src/**/*.ts` file, the rule is injected into the system prompt
for the session. Run `/rules` to see every rule, why each is active or
inactive, what the budget dropped, and any parse errors.

An `alwaysApply: true` rule skips matching entirely. `tools`, `branch`, and
`model` conditions are AND-ed with the activation mode; absent conditions mean
"any."

### Model patterns

`model` is a picomatch glob over the session model id, matched
case-sensitively, so one rule can cover a model family:

```markdown
---
description: Extra care with long files on Claude Opus.
version: 1
model: "claude-opus-*"
---
```

`*sonnet*` and `claude-opus-*` match every id containing that family name.
A plain id such as `claude-opus-4-5` is still valid and matches only itself, so
existing exact rules behave exactly as before. Quote any pattern that starts
with `*` — YAML would otherwise read it as an alias. When a model condition
fails, `/rules` names both the rule's pattern and the session model id.

### Branch patterns

`branch` is the same kind of pattern over the current git branch, resolved once
per turn with `git rev-parse --abbrev-ref HEAD` in the session working
directory:

```markdown
---
description: Release checklist.
version: 1
branch: "release/*"
---
```

Exact names such as `main` still match only themselves. Branch names contain
`/` and `*` never crosses one, so use `feat/**` for a multi-segment family.
Outside a git repository, on a detached HEAD, or when git fails, the session has
no branch and a `branch` condition simply does not match — never an error.

## Enforcement levels

`enforcement` states how binding a rule is. It defaults to `inform`, which
renders no extra line, so sections never gain noise from rules that do not ask
for it.

```markdown
---
description: Never rewrite published history.
version: 1
enforcement: enforce
globs:
  - "**/*.sh"
---
```

- `enforce` renders `> Level: MUST` and `recommend` renders `> Level: SHOULD`,
  directly under the rule heading (after any `Triggered by` line). The body
  follows unchanged.
- `inform` (the default) adds nothing.
- In the token budget, equal-`priority` candidates are admitted by rank:
  `enforce` before `recommend` before `inform`, with discovery order still
  breaking equal ranks. Priority always wins over rank, and the rendered order
  of the rules is unchanged.

## Pinned and on-demand rules

Rules default to `load: pinned`: when active, their bodies are eligible for
injection and count toward the token budget. Use pinned rules for concise
guidance that should be available automatically whenever its conditions match.

Use `load: on-demand` for long references, catalogs, or specialized material
that should not be inserted into every prompt. A matched on-demand rule adds a
path-and-description entry under the **Reference rules available on demand**
index, not its body. The agent can fetch the full body with the `read_rule` tool
using that rules-relative path. On-demand bodies bypass pinned deduplication
and budgeting; the rendered index still contributes to the reported token
estimate.

```markdown
---
description: Database migration reference.
version: 1
globs:
  - "docs/database/**/*.md"
load: on-demand
keywords: [migration, postgres]
---
Detailed migration procedures and reference material...
```

Use `keywords` when a useful rule should be discoverable from task wording
that does not mention its file paths. A whole-word, case-insensitive keyword
match in the current turn prompt donates that rule's positive globs to
pre-loading. Keywords do not activate a rule by themselves, and donated globs
do not count as touched paths or expand the filesystem scan. Language words
also provide built-in intent globs (for example, `python` or `pytest` →
`*.py`; bare `go` intentionally has no trigger). See [RULE-SPEC.md §5](RULE-SPEC.md#5-activation-semantics)
for the full list and matching semantics.

## Token budget

Pinned rule bodies use an estimated token budget of 2000 by default. Override
it for the Pi process with a positive integer value, for example:

```sh
PI_RULES_MAX_TOKENS=3000 pi
```

The shell parses the override with `parseInt`; a missing value, a value that
parses to `NaN`, or a non-positive parsed value uses the default. On-demand
bodies do not consume this budget; their rendered index contributes to the
final token estimate.

## Exists-scan cache

`exists` rules ask the project scanner for their globs on every turn. That
answer is cached per working directory and glob set, so consecutive turns reuse
one scan instead of re-walking the tree; the cache is dropped after a
completed `write`, `edit`, or `bash` tool result (the only results that can
change which files exist) or when the glob set changes. Results are identical
to an uncached scan, and `.gitignore` handling is unchanged — caching only
avoids repeating the same read. The full contract, including the staleness
window for changes made outside the agent, is in
[RULE-SPEC.md §5](RULE-SPEC.md#exists-scan-cache).

## Session persistence

Touched paths survive resume, reload, and tree navigation. Each newly touched
path batch is appended to the session as a custom entry
(`pi-rules-md/touched`, `{ paths: [...] }`) that never reaches the LLM, and on
`session_start` (any reason) and `session_tree` the touched set is rebuilt from
the current branch's entries. Resuming a session therefore restores exactly the
paths its branch touched, and navigating to another branch drops paths recorded
only on the abandoned one. Repeats are never written twice. Only touched paths
persist: `/rules mute` state lives in memory for the current session — see
[RULE-SPEC.md §5](RULE-SPEC.md#session-persistence-of-touched-paths).

## Install

Recommended: install the npm package through the CLI wrapper:

```sh
npx pi-rules-md install
```

The wrapper invokes the `pi` CLI for package changes; it never edits
`settings.json` directly.

| Command | Description |
| --- | --- |
| `pi-rules install` | Install pi-rules-md. |
| `pi-rules uninstall` | Remove pi-rules-md. |
| `pi-rules update` | Update an unpinned npm installation. |
| `pi-rules status` | Show installation status and available updates. |
| `pi-rules doctor` | Diagnose installation health. |

Common options: `--local` uses project scope for install, uninstall, and
update; `--purge` removes the package directory during uninstall; `--dry-run`
prints actions without changing anything; `--agent-dir <dir>` selects a Pi
agent directory.

For local development, load the source directly:

```sh
pi --extension ./index.ts
```

For a local-path install, run `pnpm build` first; the package manifest loads
`./dist/extension.js`. Source entries track the working tree; npm entries are
updated with `pi-rules update`.

## Commands

- `/rules` — report of the last evaluation: active rules with reasons,
  inactive rules with reasons, budget drops with cause, parse/discovery
  errors, the injected content hash, and `budget:`/`section:` token
  visibility lines. In TUI/RPC modes a status-bar entry `pi-rules-md`
  shows `rules: <active> · ~<tokens> tok` while anything is active.
- `/rules show <id>` — one rule's path, source, configured conditions, load,
  enforcement, and body.
- `/rules why <path>` — which rules a given path would activate and why
  (read-only; non-path conditions appear as caveats).
- `/rules mute <id>` / `/rules unmute <id>` — exclude or re-include one rule
  for the current session. A muted rule reports
  `inactive: <id> (muted for this session)` and stays out of the injected
  section; mutes reset on session switch/fork. Unknown ids answer
  `Unknown rule: <id>`.

## Trust model

Project rules (`.pi/rules/`) load only when the project is trusted
(pi's `isProjectTrusted()`); global rules always load. An unlistable or
unreadable rule source is reported via `/rules` and never breaks the
session.

## Development

```sh
pnpm install
pnpm typecheck   # strict TS, no emit
pnpm test        # vitest: co-located unit tests, goldens, property tests, perf guard
```

- Functional core: `src/` (types, frontmatter parser, conditions, match,
  select, render, engine, state reducer) — pure, total, property-tested.
- Imperative shell: `shell/` + `index.ts` (discovery, event collectors,
  injection, wiring) — thin, dependency-injected, structurally mirrored
  against the pi SDK types (no runtime pi import).
- ODD feature tracking: [odd/tasks/pi-rules-md.md](odd/tasks/pi-rules-md.md).
