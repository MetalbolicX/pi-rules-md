# Rule Format v1.1 (RULE-SPEC)

Normative specification for pi-rules-md rule files. Everything here is
enforced by the parser (`src/frontmatter.ts`); the pipeline
(`src/engine.ts`) consumes the parsed data unchanged.

## 1. File placement and identity

| Source | Directory | Loaded when |
| --- | --- | --- |
| Project rules | `<project>/.pi/rules/**/*.md` | the project is trusted (`ctx.isProjectTrusted()`) |
| Global rules | `~/.pi/agent/rules/**/*.md` | always |

- Discovery is recursive (`**/*.md`); non-`.md` files are ignored; VCS
  internals (`.git/**`) and dependency trees (`node_modules/**`) are never
  scanned.
- **Rule id** = file stem, disambiguated across the whole merged pass:
  on collision the first file in deterministic order (project before
  global; sorted by path within each source) keeps the bare stem; later
  collisions get `-2`, `-3`, … (e.g. project `a.md` → `a`, global
  `a.md` → `a-2`).
- Project rules come first; within a source, files are sorted by path.
- An unlistable source (e.g. permission error) produces a
  `source-unreadable` error entry for `/rules` and contributes no rules;
  it never breaks the session. An unreadable file produces a
  `read-failure` entry. A file that vanishes mid-scan is skipped
  silently.

## 2. Document shape

A rule file is YAML frontmatter plus a markdown body:

```markdown
---
description: One line explaining what the rule enforces.
version: 1
globs:
  - "src/**/*.ts"
  - "!src/**/*.test.ts"
match: touched
tools: [edit, write]
branch: main
model: sonnet
priority: 10
enforcement: enforce
load: pinned
keywords: [typescript, style]
alwaysApply: false
---
The rule body: instructions injected verbatim into the system prompt
section when the rule is active.
```

## 3. Keys

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `description` | string | ✔ | — | Shown in `/rules`; never injected. |
| `version` | number | ✔ | — | **Exactly `1`** (YAML integer `1`; `1.0` is rejected by strict equality). |
| `globs` | string[] | see §4 | — | Glob patterns (OR semantics); `!`-prefixed entries are negations. |
| `match` | `touched` \| `exists` \| `both` | ✘ | `both` | Activation mode (§5). |
| `tools` | string[] | ✘ | — | Active only when the current tool selection intersects. |
| `branch` | string | ✘ | — | Active only on this git branch (v1: no live branch source in pi; reserved). |
| `model` | string | ✘ | — | Active only when the current model name matches. |
| `priority` | integer | ✘ | `0` | Higher wins in selection; ties keep discovery order (stable). |
| `enforcement` | `enforce` \| `recommend` \| `inform` | ✘ | `inform` | Parsed and validated; does NOT affect selection or rendering in v1 (reserved for future emphasis). |
| `load` | `pinned` \| `on-demand` | ✘ | `pinned` | Loading policy metadata; materialized by parsing and does not itself alter condition matching. |
| `keywords` | string[] | ✘ | — | Intent-donation metadata; trimmed on parse and does not itself gate matching. Empty arrays are allowed. |
| `alwaysApply` | boolean | ✘ | `false` | When true the rule bypasses ALL condition matching (still subject to the trust gate for project rules). |

**Unknown keys are rejected** (strict schema). Types must match exactly
(`globs` and `keywords` entries are strings; `load` is exactly `pinned` or
`on-demand`; `priority` is an integer; `version` is the number `1`).

## 4. Activation constraints

A rule must declare at least one activation trigger: non-empty `globs`,
non-empty `tools`, `branch`, `model`, or `alwaysApply: true`. Otherwise
the parse fails with `no-activation-condition`.

Special case: an explicit `match` key **requires** `globs`
(`match-without-globs`) — implicit default `match` without globs is fine
as long as another trigger exists.

Glob entries are picomatch patterns evaluated against cwd-relative,
`/`-separated, normalized paths. Positive patterns OR; negations
(`!pattern`) apply per-rule: a path is a candidate when it matches ≥1
positive pattern, then excluded if it matches any negation.

## 5. Activation semantics

- `touched` — active when any agent tool touched a path matching the
  globs this session (observed from `tool_result` events; first
  occurrence wins, order preserved).
- `exists` — active when any path matching the globs exists on disk
  (checked via the scan seam each evaluation).
- `both` — touched **OR** exists (the default).
- Condition keys (`tools`, `branch`, `model`) are AND-ed on top of the
  activation mode; absent means "any".
- `alwaysApply: true` skips activation and conditions entirely.

## 6. Selection, budget, rendering

- Content-level dedupe: rules with byte-identical full content are
  deduplicated, keeping the FIRST occurrence in discovery order
  (project-first).
- Sorted by `priority` DESC (stable sort keeps discovery order on ties).
- Token budget (default 2000, estimated `ceil(chars/4)`): selected
  top-down; the fold stops at the first rule that does not fit — every
  remaining rule is dropped with cause `budget` (no best-effort fill).
- Rendered as one `pi-rules-md` system-prompt section: `# Rules` header,
  framing line, one entry per selected rule (`## <description>`), optional
  `> Triggered by: <reasons>` when reasons exist, and `---` separators.
  Rule bodies are injected verbatim with trailing blank-line
  normalization; the section ends with exactly one trailing newline.
- The section is re-applied on **every** agent turn while any rule is
  active (pi rebuilds its prompt sections per turn); identical content
  produces no prompt diff (zero churn). When no rule is active and one
  was previously injected, the section is removed.

## 7. Errors (visible via `/rules`)

Parse and discovery errors never break the session; they are collected
and reported: `yaml-syntax`, `missing-frontmatter`, `unknown-key`,
`invalid-version`, `missing-description`, `invalid-value` (field type),
`match-without-globs`, `no-activation-condition`, `read-failure`,
`source-unreadable`. Error entries carry the offending file (or
directory for `source-unreadable`) and are reused from the mtime cache
while the file is unchanged.
