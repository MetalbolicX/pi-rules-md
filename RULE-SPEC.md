# Rule Format v1.2 (RULE-SPEC)

Normative specification for pi-rules-md rule files and runtime behavior.
Frontmatter shape and value constraints are enforced by the parser
(`src/frontmatter.ts`); the discovery, matching, selection, and rendering
pipeline applies the remaining semantics.

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
model: "*sonnet*"
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
| `branch` | string | ✘ | — | Active only when the session's git branch name matches this picomatch glob pattern (§5); an exact name is the degenerate pattern. The branch is resolved per turn from `git rev-parse --abbrev-ref HEAD`. |
| `model` | string | ✘ | — | Active only when the session model id matches this picomatch glob pattern; an exact id is the degenerate pattern (§5). |
| `priority` | integer | ✘ | `0` | Higher wins in selection; ties keep discovery order (stable). |
| `enforcement` | `enforce` \| `recommend` \| `inform` | ✘ | `inform` | Breaks budget-admission ties at equal `priority` (`enforce` → `recommend` → `inform`) and adds a level line to the rendered entry (`> Level: MUST` / `> Level: SHOULD`); `inform` adds nothing. See §6. |
| `load` | `pinned` \| `on-demand` | ✘ | `pinned` | Loading policy metadata; materialized by parsing and does not itself alter condition matching. |
| `keywords` | string[] | ✘ | — | Intent-donation metadata; trimmed on parse and does not itself gate matching. When a keyword matches a whole word in the current turn prompt (case-insensitive), this rule's positive globs are donated to intent pre-loading. Empty arrays are allowed. |
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

- `touched` — active when an agent tool's pre-execution arguments name a path
  matching the globs this session. Paths are captured from `tool_execution_start`
  events; first occurrence wins, order preserved.
- `exists` — active when any path matching the globs exists on disk
  (checked via the scan seam each evaluation).
- `both` — touched **OR** exists (the default).
- Condition keys (`tools`, `branch`, `model`) are AND-ed on top of the
  activation mode; absent means "any".
- `model` is a **picomatch glob pattern over the session model id**, evaluated
  case-sensitively. `*sonnet*` and `claude-opus-*` select a model family; an
  exact id such as `claude-opus-4-5` is the degenerate pattern and matches only
  itself, so v1.1 rules keep their behavior. Patterns are matched against the
  id as one flat token: no path normalization, and a pattern that cannot
  compile (including the empty string) matches nothing rather than raising.
  picomatch's own semantics still apply: a leading `!` negates the pattern, and
  `*` never crosses a `/` (use a `**/` prefix if an id ever contains one).
  Quote patterns that start with `*` — unquoted `*sonnet*` is a YAML alias, not
  a string.
- `branch` is a **picomatch glob pattern over the session's git branch name**,
  with the same semantics as `model`: case-sensitive, evaluated against the
  branch name as one flat token, with exact names remaining the degenerate
  pattern so v1.1 rules keep their behavior. The session branch is resolved
  once per turn by running `git rev-parse --abbrev-ref HEAD` in the session
  working directory. Branch names routinely contain `/` and `*` never crosses
  one, so `release/*` matches `release/1.0` but not `release/v1/1.0`; use
  `release/**` for the deeper case. Outside a git repository, on a detached
  HEAD, on a non-zero git exit, or when the command cannot run, the session
  branch is **absent** — never an error — and a `branch` condition simply does
  not match.
- When a declared `model` pattern does not match, the `/rules` report and the
  trace reason name both the pattern and the session model id
  (`model mismatch: session model <id> does not match the rule's model pattern
  <pattern>`), or `absent` when the session reports no model. A failing
  `branch` condition is reported the same way
  (`branch mismatch: session branch <name> does not match the rule's branch
  pattern <pattern>`), with `absent` when the session has no branch.
- `alwaysApply: true` skips activation and conditions entirely.
- Before evaluation, the current turn prompt is checked for whole-word, case-insensitive language names: python/pytest → `*.py`, rust → `*.rs`, typescript → `*.ts`, javascript → `*.js`, golang → `*.go`, kotlin → `*.kt`, java → `*.java`, csharp → `*.cs`, ruby → `*.rb`. There is intentionally no bare `go` language trigger.
- The current turn prompt is also checked for whole-word, case-insensitive matches against each rule's `keywords`; a hit donates that rule's positive globs to the intent set. Keyword metadata does not activate the rule by itself. Intent globs can satisfy a rule's `globs` condition independently of touched/existing path matches, but do not bypass other conditions.
- **Intent globs never enter the context path pool** (`touchedPaths` or `existingPaths`) and do not expand the filesystem scan. They are a separate input to the globs-condition check.

### Pre-execution path capture

`tool_execution_start` is observed before tool execution. The event's `args` are
untrusted; missing, malformed, non-object, or non-string path arguments and
unknown tools are ignored. Recognized paths are normalized and deduplicated by
the session-state reducer.

| Pi built-in | Captured argument | Behavior |
| --- | --- | --- |
| `read`, `edit`, `write` | `path` | Captured as a file path. |
| `grep` | optional `path` | Captured as the search scope when present. |
| `find` | optional `path` | Captured as the glob-search scope when present. |
| `bash` | none | No capture: Pi's schema has only `command` and `timeout`. |

These keys are verified against the installed Pi schemas in
`dist/core/tools/{read,edit,write,grep,find,bash}.js`. Unlike OpenCode, Pi's
bash tool has no `workdir` argument. This is a deliberate runtime divergence:
we do not parse paths from shell command strings.

## 6. Selection, budget, rendering

- Every discovered rule receives a monotonic `index` in discovery order:
  project rules first, then global rules, retaining each source's order.
- Content-level dedupe: rules with byte-identical full content are
  deduplicated; higher `priority` wins, and equal priorities keep the later
  discovery `index`. Losers are dropped with cause `duplicate`. This
  supersedes v1's first-occurrence-wins behavior.
- Budget candidates are considered by `priority` DESC, then enforcement rank
  ASC (`enforce` → `recommend` → `inform`), then `index` ASC. Enforcement only
  breaks `priority` ties; it never outranks a higher priority.
  Greedy fill admits each candidate that fits and skips a non-fitting rule
  while continuing to later candidates. If candidates exist, the first is
  always kept even when it exceeds the budget; this supersedes v1's stop-at-
  first-non-fit behavior.
- After budget selection, presentation order is unconditional rules first
  (`alwaysApply: true` or no declared activation conditions), then
  `priority` DESC, then `index` ASC.
- Token budget defaults to 2000 estimated tokens (`ceil(chars/4)` of each
  pinned rule body's content). The shell parses `PI_RULES_MAX_TOKENS` with
  `parseInt`; an absent value, a value that parses to `NaN`, or a non-positive
  parsed value uses the default. A positive parsed integer overrides it.
- On-demand rules bypass pinned-rule dedupe and budget selection. Their bodies
  are never injected or counted against that budget. Instead, the rendered
  section appends an index headed exactly
  `## Reference rules available on demand`, with one `- <rules-relative-path>
  — <description> (fetch with the read_rule tool)` line per rule. No index is
  rendered when no on-demand rule
  matched. Each rule's `relativePath` is a POSIX path relative to its source's
  rules root, never an absolute path.
- `read_rule` looks up a discovered rule by exact `relativePath` and returns
  its parsed `content` body directly; it performs no filesystem read. Absolute
  paths (POSIX or Windows) and any name containing a `..` segment, as well as
  unknown names, return `Unknown rule: <name>`. The FROZEN tool description is:
  `Fetch the full content of a reference rule by its rules-relative path. Use
  when a "Reference rules available on demand" index entry is relevant to the
  current task.`
- The evaluation trace partitions matched rules into pinned `active` and
  `onDemand`, reports all matched rule file paths (including on-demand paths),
  and estimates tokens over the complete rendered block including its index.
- The `/rules` report appends `budget: <used>/<budget> estimated tokens` —
  `used` sums the estimated tokens of the **pinned active bodies only** —
  and, while a section is injected, `section: ~<estimatedTokens> tokens`
  covering the whole rendered section including the on-demand index.
- In UI modes (`ctx.hasUI`: TUI/RPC), the extension maintains the status-bar
  key `pi-rules-md` as `rules: <pinned-active> · ~<estimatedTokens> tok` after
  each evaluation and clears it (undefined) when nothing is active.
- `/rules` subcommands (v1.2): `show <id>` prints the rule's path, source,
  configured conditions, load, enforcement, and verbatim body; an unknown id
  answers exactly `Unknown rule: <id>`. `why <path>` explains, for that
  cwd-relative path treated as touched, which rules would activate and why —
  through the same `matchRule` the engine uses — with declared non-path
  conditions (tools/model/branch) shown as caveats; always-apply and non-path
  rules are reported as path-independent, and muted rules as session-excluded.
  Both are read-only and never mutate
  session state; bare `/rules` output is unchanged; any other argument form
  prints one usage line listing show, why, mute, and unmute.
- `/rules mute <id>` and `/rules unmute <id>` (v1.2) exclude one rule from the
  current session, or re-include it. Mute is unconditional: it wins over both
  `alwaysApply` and the trust gate, and a muted rule is skipped as unmatched
  with the reason `muted for this session` before its path/conditions are
  evaluated and before the exists-scan pool, budget selection, and the block.
  A muted rule therefore contributes nothing — not even to the on-demand
  index — and cannot appear as `dropped`. The `/rules` report shows it as
  exactly `inactive: <id> (muted for this session)`, with no `configured:`
  detail lines, because a mute is an explicit session action rather than a
  failed condition. An id that was never discovered answers exactly
  `Unknown rule: <id>` and changes nothing; an accepted command answers one
  confirmation line, `muted: <id>` or `unmuted: <id>`. Muting is by rule id,
  so a re-discovered unchanged rule stays muted, re-muting an already muted
  rule is a no-op, and mutes survive compaction. Mute state is session state:
  a session switch or fork clears it along with touched paths. `mute`/`unmute`
  without exactly one id prints the usage line.
- Rendered as one `pi-rules-md` system-prompt section: `# Rules` header,
  framing line, one entry per selected pinned rule (`## <description>`), optional
  `> Triggered by: <reasons>` when reasons exist, optional
  `> Level: MUST` / `> Level: SHOULD` for `enforce` / `recommend` (directly
  after the trigger line, or directly after the heading when there are no
  reasons; `inform` — the default — adds no level line), and `---` separators.
  Pinned rule bodies are injected verbatim with trailing blank-line
  normalization; the section ends with exactly one trailing newline.
- The section is re-applied on **every** agent turn while any pinned or
  on-demand rule is active (Pi rebuilds its prompt sections per turn); identical
  content produces no prompt diff (zero churn). When no rule is active and one
  was previously injected, the section is removed.

### v1 behavior superseded by v1.1

- Equal-content pinned rules no longer keep the first occurrence: the higher
  priority wins, with the later discovery index breaking priority ties.
- Budget selection no longer stops at the first non-fitting candidate. It skips
  that candidate and continues; the first priority-sorted candidate is retained
  even when it exceeds the budget.
- The pinned entry heading is `## <description>` (not `## <id>`), matching the
  renderer and its contract tests.

### v1.1 behavior superseded by v1.2

- `model` is no longer an exact string comparison. It is a picomatch glob
  pattern over the session model id, matched case-sensitively; exact ids remain
  valid patterns and keep matching exactly. Tools, globs, and `alwaysApply`
  semantics are unchanged in v1.2.
- The `model` mismatch reason now names the rule's pattern and the session model
  id together, instead of only the required value.
- `branch` is no longer reserved and no longer an exact string comparison. The
  session branch is resolved live from `git rev-parse --abbrev-ref HEAD` once
  per turn and matched as a picomatch glob with the same semantics as `model`.
  Exact branch names remain valid patterns; a missing branch (non-git
  directory, detached HEAD, git failure) means "no match".
- The `branch` mismatch reason names the rule's pattern and the session branch,
  matching the `model` wording.
- The specification's own example rule used `model: sonnet`, which matched no
  real model id; it is now `model: "*sonnet*"`.
- `enforcement` is no longer inert. It breaks budget-admission ties at equal
  `priority` (`enforce` before `recommend` before `inform`, with discovery
  `index` still deciding equal ranks) and adds a `> Level: MUST` (enforce) or
  `> Level: SHOULD` (recommend) line to the rendered entry, directly after the
  `> Triggered by` line and before the body. `inform` is the default and adds
  nothing, so v1.1 output stays byte-identical. Presentation order is
  unchanged: `enforcement` is a budget-admission key, not a display key.

## 7. Errors (visible via `/rules`)

Parse and discovery errors never break the session; they are collected
and reported: `yaml-syntax`, `missing-frontmatter`, `unknown-key`,
`invalid-version`, `missing-description`, `invalid-value` (field type),
`match-without-globs`, `no-activation-condition`, `read-failure`,
`source-unreadable`. Error entries carry the offending file (or
directory for `source-unreadable`) and are reused from the mtime cache
while the file is unchanged.
