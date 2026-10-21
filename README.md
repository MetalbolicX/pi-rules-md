# pi-rules-md

Pi extension that discovers markdown rule files and injects conditionally
matched ones into the system prompt. Rules can activate when the agent touches
files matching their globs, matching files exist in the project, a selected
tool or model matches, prompt-derived intent satisfies its glob condition, or
the rule is always active.

Functional core / imperative shell; pure functions and data, no classes.

## How it works

1. **Discovery** — every turn, rule files are discovered from
   `<project>/.pi/rules/**/*.md` (when the project is trusted) and
   `~/.pi/agent/rules/**/*.md` (always), parsed with a strict schema, and
   cached by mtime.
2. **Matching** — each rule's activation is evaluated against the live
   session: touched paths, existing files, selected tools, current model, and
   prompt-derived intent.
3. **Selection** — pinned rule bodies are content-deduped, budgeted, and
   ordered for presentation. On-demand rules are listed by path instead of
   having their bodies injected.
4. **Injection** — the selected rules and on-demand index are rendered into a
   single `pi-rules-md` system-prompt section via
   `systemPromptOptions.sections` in `before_agent_start`. The section is
   re-applied every turn while rules are active; identical content produces no
   prompt diff, and the section is removed when nothing is active.

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
  errors, and the injected content hash.

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
