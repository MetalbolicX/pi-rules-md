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
   directory, and — read in place, never copied — from Copilot's
   `.github/instructions` and Claude's `.claude/rules` (all of those only when
   the project is trusted — see [Monorepo rule discovery](#monorepo-rule-discovery)
   and [Importers](#importers-copilot-instructions-claude-rules)), and from
   `~/.pi/agent/rules/**/*.md` (always). Native rule files are parsed against a
   strict schema, imported files leniently, and every file is cached by mtime.
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

## Importers (Copilot instructions, Claude rules)

Rules written for another tool are read in place — never copied, moved, or
rewritten — so the original tool keeps working. Both importers turn each file
into an ordinary project rule: trust-gated like `.pi/rules`, cached by mtime
like any rule file, ordered after the nested `.pi/rules` dirs and before the
global dir, sharing the same id namespace, and reported in `/rules` under its
real path. Copilot's `.github/instructions` is read before Claude's
`.claude/rules`, so on an id collision the Copilot file keeps the earlier
suffix.

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

### Claude rules

The Claude importer reads `.claude/rules/**/*.md` (plain markdown, `.md` only):

```text
.claude/rules/typescript.md
---
paths: src/**/*.{ts,tsx}, docs/**
description: TypeScript conventions
---
Use explicit types.
```

- `paths` is optional and accepts three shapes: one glob string, a
  comma-separated string, or a YAML list of glob strings. Entries are trimmed,
  blank entries dropped, and duplicates collapsed.
- Brace expansion works (`src/**/*.{ts,tsx}`); the comma-separated form splits
  only on commas outside a `{…}` group, so a brace group is never cut in half.
- An absent `paths` — or a file with no frontmatter at all — means the rule
  always applies: that is Claude's own "no paths = always applied" default. A
  `paths` value that trims down to no glob at all is a parse error, not a silent
  always-apply.
- `**` is not special here (unlike Copilot's `applyTo`): it stays an ordinary
  glob matching every touched path.
- `!`-negated entries are passed through untouched, so they behave exactly like a
  native rule's negated glob.
- `description` precedence: an explicit non-blank `description`, else the FIRST
  body heading (`#`, `##`, … with its `#` run stripped), else the file stem
  (`typescript.md` → `typescript`).
- `paths` globs are relative to the working directory, exactly as authored; the
  whole rule is a touched-path, pinned, inform-level project rule; parse errors
  appear in `/rules` under the real file.

Importers are on for trusted projects. Disable all of them for the Pi process
with:

```sh
PI_RULES_IMPORT=none pi
```

Only a trimmed, case-insensitive `none` disables import; absent or unrecognized
values keep them on. With import disabled no importer file is listed, stat-ed,
or read, so the behavior is identical to a repository that has no such files.

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
| `pi-rules lint [dir...]` | Validate rule files and print one line per error. |
| `pi-rules new <name> [--global]` | Scaffold a valid rule file; never overwrites one. |
| `pi-rules explain <path>` | Explain which rules a path would activate, and why. |

Common options: `--local` uses project scope for install, uninstall, and
update; `--purge` removes the package directory during uninstall; `--global`
scaffolds a global rule with `new`; `--dry-run` prints actions without changing
anything; `--agent-dir <dir>` selects a Pi agent directory (for `lint`,
`new --global` and `explain` it also moves the global rules root).

For local development, load the source directly:

```sh
pi --extension ./index.ts
```

For a local-path install, run `pnpm build` first; the package manifest loads
`./dist/extension.js`. Source entries track the working tree; npm entries are
updated with `pi-rules update`.

## Linting rule files

`pi-rules lint [dir...]` parses native rule files and reports every problem
before you rely on them (otherwise a bad rule only shows up as a parse error
in `/rules` after an evaluation cycle):

```sh
pi-rules lint                  # .pi/rules and ~/.pi/agent/rules
pi-rules lint src/.pi/rules    # explicit directories instead
```

Each error prints as `<file>: <code>: <message>` on its own line, sorted by
file then code, followed by one summary line such as
`lint: 11 rule files, 2 errors`. The exit code is `1` when any error was
found and `0` otherwise, so the command composes in scripts and CI.

Defaults and scope:

- Without arguments, lint scans `<cwd>/.pi/rules` and the global rules
directory (`~/.pi/agent/rules`, or `<agent dir>/rules` with
`--agent-dir`/`PI_RULES_AGENT_DIR`). A missing default directory is not an
error — a project or machine without rules is a valid state.
- Directories passed on the command line must exist: a missing explicit
directory is reported as `source-unreadable` and exits `1`.
- Only the **native** rule format (`RULE-SPEC.md`, strict v1 schema) is
linted. Imported formats (`.github/instructions`, `.claude/rules`) are
lenient, use a different key set, and are validated by their own importers.
- Listing is recursive over `**/*.md`, skips `.git` and `node_modules`,
ignores non-markdown files, and never follows symlinks.
- A file that cannot be read is reported as a `read-failure` error line
rather than aborting the run.

## Scaffolding a rule

`pi-rules new <name> [--global]` writes a starter rule file you can edit
instead of remembering the frontmatter contract:

```sh
pi-rules new use-tabs              # .pi/rules/use-tabs.md
pi-rules new shared-baseline --global   # ~/.pi/agent/rules/shared-baseline.md
```

The generated rule is valid by construction: `description` derived from the
name, `version: 1`, one placeholder `globs` pattern with `match: touched`, and
the documented defaults (`priority: 0`, `enforcement: inform`, `load: pinned`)
spelled out, above a placeholder body. `pi-rules lint` accepts it and
`pi-rules explain` explains it as soon as it exists.

- The target rules directory is created when it is missing.
- An existing rule file is **never** overwritten: the write itself is an
exclusive create, so the command refuses, names the file, and exits `1` with
the file untouched.
- `<name>` is a file stem, not a path: no path separators, no whitespace, no
leading dot. A single trailing `.md` is stripped (`new use-tabs.md` still
writes `use-tabs.md`).
- It prints one line, `created <file>`, naming the absolute path written.

## Explaining a path

`pi-rules explain <path>` prints the same report as `/rules why <path>`, from
the command line and outside any session:

```sh
pi-rules explain src/app.ts
```

```text
why src/app.ts (treated as touched this session):
always: always active (path-independent)
docs: not activated by this path (no touched path matches globs: docs/**)
tabs: would activate — glob `src/**/*.ts`
  also requires tools: edit
```

Rules are listed in discovery order, one group of lines each. A path is read on
the working-directory scale that touched paths use, so an absolute path inside
the working directory is converted to its relative form first.

It answers the **path-condition** question only. There is no session, so
tools/model/branch conditions appear as caveats of a path decision and are
never evaluated; muting, budgets and injected sections do not apply. The read
set is `lint`'s default pair — `<cwd>/.pi/rules` and the global rules
directory — with native rule files only: ancestor and nested `.pi/rules`
directories and imported formats (`.github/instructions`, `.claude/rules`) are
not part of the report. Rule files that fail to parse are reported on stderr
as `<file>: <code>: <message>` and never change the exit code.

Exit codes: `0` for a completed report, including a path that matches no rule
(the report says why), `1` when the rules could not be read at all, `2` for a
usage error.

## Commands

- `/rules` — report of the last evaluation: active rules with reasons,
  inactive rules with reasons, budget drops with cause, parse/discovery
  errors, the injected content hash, and `budget:`/`section:` token
  visibility lines. In TUI/RPC modes a status-bar entry `pi-rules-md`
  shows `rules: <active> · ~<tokens> tok` while anything is active.
- `/rules show <id>` — one rule's path, source, configured conditions, load,
  enforcement, and body.
- `/rules why <path>` — which rules a given path would activate and why
  (read-only; non-path conditions appear as caveats). The same report is
  available outside a session as `pi-rules explain <path>`.
- `/rules mute <id>` / `/rules unmute <id>` — exclude or re-include one rule
  for the current session. A muted rule reports
  `inactive: <id> (muted for this session)` and stays out of the injected
  section; mutes reset on session switch/fork. Unknown ids answer
  `Unknown rule: <id>`.

## Trust model

Project rules — `.pi/rules/` at any discovered level, and every imported
Copilot/Claude file — load only when the project is trusted (pi's
`isProjectTrusted()`); global rules always load. In a monorepo that covers
every rules directory the walk-up and the nested enumeration find — an
untrusted project lists neither the working directory's, an ancestor's, nor a
nested `.pi/rules`, is never globbed for nested rule directories, reads no
importer directory, and no git query is made for it. Nothing above the
enclosing git root is ever read, and a nested rule directory can never be
outside the working directory. An unlistable or unreadable rule source
(including a failed nested enumeration) is reported via `/rules` and never
breaks the session.

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
