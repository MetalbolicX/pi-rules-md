# pi-rules-md

Pi extension that discovers markdown rule files and injects conditionally
matched ones into the system prompt. Rules can activate when the agent touches
files matching their globs, matching files exist in the project, a selected
tool, model, or git branch matches, prompt-derived intent satisfies its glob
condition, or the rule is always active.

Functional core / imperative shell; pure functions and data, no classes.

## How it works

1. **Discovery** — every turn, rule files are discovered from
   `<project>/.pi/rules/**/*.md`, from every ancestor `.pi/rules` up to the
   enclosing git root, from every nested `.pi/rules` below the working
   directory (all of them only when the project is trusted — see
   [Monorepo rule discovery](#monorepo-rule-discovery)), and from
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

Mid-run delivery is built on top of that section: rules that only become
active because of a `read`/`edit`/`write` result are appended to that tool
result, once per rule per session — see
[Mid-run attachment](#mid-run-attachment).

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

## Monorepo rule discovery

A working directory inside a monorepo sees the rules of every directory between
it and the enclosing git root, plus the rules of the packages nested below it.
Discovery reads `<cwd>/.pi/rules`, then `<parent>/.pi/rules`, and so on up to
`<git-root>/.pi/rules` — the git root itself included, and nothing above it —
and then every `.pi/rules` found below the working directory (bounded depth,
`.git/` and `node_modules/` skipped). The git root comes from
`git rev-parse --show-toplevel`, resolved once per working directory; when git
has no answer (not a repository, git missing) the walk-up stops at
`<cwd>/.pi/rules`, which is exactly single-directory behavior. Nested discovery
does not depend on git: it only ever looks below the working directory.

Each rule's globs are relative to the directory that owns its `.pi/` folder, so
a rule in the repo root describes repo paths, a package rule describes package
paths, and a nested package rule describes its own package paths:

```text
repo/                        <- git root, current working directory
├── .pi/rules/root.md        globs: "packages/b/src/**/*.ts"  (repo-relative)
└── packages/
    ├── a/.pi/rules/pkg.md   globs: "src/**/*.ts"             (package-relative)
    └── b/.pi/rules/app.md   globs: "src/**/*.ts"             (package-relative)
```

Here `root.md` matches `/repo/packages/b/src/x.ts`, `app.md` matches it too (as
`packages/b/src/x.ts`), and `pkg.md` does not — while from `packages/a` as the
working directory the same `pkg.md` matches `src/x.ts` and `root.md`'s pattern
never claims `packages/b`. Nesting is bounded: a `.pi/rules` dir at most six
directory segments below the working directory is discovered (so
`packages/b` at depth 2 and `apps/web/packages/x` at depth 4 are found), and
`.git/` or `node_modules/` never hides a rule directory or a rule file.

Rules from every level are project rules: they share one id namespace (nearest
directory wins the bare stem, later collisions get `-2`, `-3`, … in the order
cwd → ancestors → nested → imported → global), they are all ordered before
global rules, and all of them stay behind the project trust gate — an untrusted
project lists and enumerates no rules directory at all, and git is not
consulted. The full
contract, including how rebased globs are evaluated, why `/rules` may name a
rebased pattern, and the exact ordering and depth bound, is in
[RULE-SPEC.md §1](RULE-SPEC.md#1-file-placement-and-identity).

## Importers (Copilot instructions)

Rules written for another tool are read in place — never copied, moved, or
rewritten — so the original tool keeps working. The Copilot importer reads
`.github/instructions/**/*.instructions.md` and turns each file into an ordinary
project rule: it is trust-gated like `.pi/rules`, cached by mtime like any rule
file, ordered after the nested `.pi/rules` dirs and before the global dir,
shares the same id namespace, and appears in `/rules` under its real path.

```text
.github/instructions/typescript.instructions.md
---
applyTo: src/**/*.ts,docs/**
description: TypeScript conventions
---
Use explicit types.
```

- `applyTo` holds comma-separated globs, trimmed, with empty entries dropped.
  The entry `**` means "every file" → the rule always applies.
- An absent `applyTo` — or a file with no frontmatter at all — also means
  "applies everywhere" (`applyTo: **`), matching Copilot's own semantics.
- `description` is optional; the fallback is the file stem
  (`typescript.instructions.md` → `typescript`).
- Every other frontmatter key (`version`, `excludeAgent`, …) is ignored: this
  format belongs to Copilot, so its schema is read leniently instead of through
  the strict native rule schema. Unknown keys never fail an import; only real
  document damage does (broken YAML, an unterminated block, a non-string
  `description`, a non-string or empty `applyTo`).
- `applyTo` globs are relative to the working directory, exactly as authored, so
  `src/**` matches `src/**` — the importer's own directory never prefixes them.
- The whole rule is a touched-path, pinned, inform-level project rule; imported
  files cannot declare a different `match`, `load`, or `enforcement`.
- Parse errors are not silent: `/rules` reports them under the real file path, so
  an invalid `applyTo` is visible where it lives.

Importers are on for trusted projects. Disable all of them for the Pi process
with:

```sh
PI_RULES_IMPORT=none pi
```

Only a trimmed, case-insensitive `none` disables import; absent or unrecognized
values keep them on. With import disabled no importer file is listed, stat-ed,
or read, so the behavior is identical to a repository that has no such files.
Claude `.claude/rules` support is planned next (T14) and ships as a second
importer through the same seam; until then, only the Copilot importer is active.

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

## Mid-run attachment

Rules can also reach the model between turns: the extension appends one small
block to a `read`, `edit`, or `write` tool result.

- Only those three tool results attach; every other result — including an
errored one — is left exactly as pi produced it.
- Each rule is delivered once per session. The ids the injected section already
carries count as delivered, so nothing is sent twice; the record is cleared by
compaction and by a session switch/fork, which is what allows a rule to reach
the model again after the transcript it was part of is gone.
- The block is rendered by the same code as the section, so a rule reads
identically in both places. It is appended as one extra content part; the tool
output pi produced is never replaced.
- Attachment evaluates the session as it stands at the tool result, so the rules
  that just became active — including because of the path this call touched — are
  the ones delivered. The remaining budget is what the section's own pinned
  bodies leave over, so a newly active rule can degrade to a `read_rule`
  reference instead of its body.
- That evaluation only reads: it never rewrites the injected section (that stays
  `before_agent_start`'s job), and `/rules` keeps reporting the last real cycle.

Attachment is on by default. Set `PI_RULES_ATTACH=off` to disable it — the
exists-scan invalidation and the section injection are unaffected. The full
contract (candidates, remaining budget, degradation to a `read_rule` reference,
on-demand index lines) is in
[RULE-SPEC.md §6](RULE-SPEC.md#mid-run-attachment).

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
(pi's `isProjectTrusted()`); global rules always load. In a monorepo that
covers every rules directory the walk-up and the nested enumeration find — an
untrusted project lists neither the working directory's, an ancestor's, nor a
nested `.pi/rules`, is never globbed for nested rule directories, and no git
query is made for it. Nothing above the enclosing git root is ever read, and a
nested rule directory can never be outside the working directory. An
unlistable or unreadable rule source (including a failed nested enumeration) is
reported via `/rules` and never breaks the session.

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
