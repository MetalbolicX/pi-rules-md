# pi-rules-md

Pi extension that discovers markdown rule files and injects conditionally
matched ones into the system prompt — rules activate when the agent touches
files matching their globs, when matching files exist in the project, when
a tool/model matches, or always.

Functional core / imperative shell; pure functions and data, no classes.

## How it works

1. **Discovery** — every turn, rule files are discovered from
   `<project>/.pi/rules/**/*.md` (when the project is trusted) and
   `~/.pi/agent/rules/**/*.md` (always), parsed with a strict schema, and
   cached by mtime.
2. **Matching** — each rule's activation is evaluated against the live
   session: touched paths (observed from tool activity), existing files
   (glob scan), selected tools, and the current model.
3. **Selection** — content-deduped, sorted by `priority` (higher first,
   stable), folded under a token budget (default 2000).
4. **Injection** — the selected rules are rendered into a single
   `pi-rules-md` system-prompt section via `systemPromptOptions.sections`
   in `before_agent_start`. The section is re-applied every turn while
   rules are active; identical content produces no prompt diff, and the
   section is removed when nothing is active.

The rule file format is specified in [RULE-SPEC.md](RULE-SPEC.md).

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

An `alwaysApply: true` rule skips matching entirely (global "always on"
rules). `tools`/`model` conditions AND onto the glob activation.

## Install

```sh
pi install <path-to-this-repo>
```

or for development:

```sh
pi --extension ./index.ts
```

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
