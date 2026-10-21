# Rule Format v1.2 (RULE-SPEC)

Normative specification for pi-rules-md rule files and runtime behavior.
Frontmatter shape and value constraints are enforced by the parser
(`src/frontmatter.ts`); the discovery, matching, selection, and rendering
pipeline applies the remaining semantics.

## 1. File placement and identity

| Source | Directory | Loaded when |
| --- | --- | --- |
| Project rules (cwd) | `<project>/.pi/rules/**/*.md` | the project is trusted (`ctx.isProjectTrusted()`) |
| Project rules (ancestors) | every `<dir>/.pi/rules/**/*.md` for each `<dir>` between the working directory's parent and the enclosing git root (inclusive) | the project is trusted |
| Project rules (nested) | `<cwd>/<dir>/…/.pi/rules/**/*.md` for each `<dir>` below the working directory, at most 6 directory segments deep, never under `.git/` or `node_modules/` | the project is trusted |
| Project rules (Copilot import) | `<cwd>/.github/instructions/**/*.instructions.md` | the project is trusted and importers are enabled (`PI_RULES_IMPORT` is not `none`) |
| Project rules (Claude import) | `<cwd>/.claude/rules/**/*.md` | the project is trusted and importers are enabled (`PI_RULES_IMPORT` is not `none`) |
| Global rules | `~/.pi/agent/rules/**/*.md` | always |

The enclosing git root is resolved once per working directory from
`git rev-parse --show-toplevel`. When git reports no root (not a repository,
git unavailable, non-zero exit, malformed output) discovery behaves exactly as
a single-directory project: only `<project>/.pi/rules` is read. Nothing above
the git root is ever read, listed, stat-ed or queried — the root is the
walk-up bound, and an untrusted project reads no project directory at all
(neither cwd's nor an ancestor's).

- Discovery is recursive (`**/*.md`); non-`.md` files are ignored; VCS
  internals (`.git/**`) and dependency trees (`node_modules/**`) are never
  scanned.
- **Rule base.** A rule's globs are relative to the directory owning its `.pi/`
  folder: a rule at `/repo/.pi/rules` means `/repo/src/**`, one at
  `/repo/packages/a/.pi/rules` means `/repo/packages/a/src/**`. Rules in
  `<project>/.pi/rules` keep today's semantics unchanged (their base IS the
  working directory). Ancestor rules are evaluated on both scales the session
  actually carries — touched paths inside the working directory are relative to
  it, touched paths outside it are absolute — so an ancestor rule matches the
  files its authored globs describe, and it never claims a same-named file in a
  different package. `!`-negated globs rebase identically. Absolute and
  `..`-escaping globs are evaluated exactly as authored (no anchor is invented
  for them). Because a rebased rule can carry more than one evaluated form, the
  `/rules` report may name a rebased form of the pattern in its reason.
- **Rule id** = file stem, disambiguated across the whole merged pass:
  on collision the first file in deterministic order (cwd rules, then each
  ancestor from nearest to the git root, then nested rules, then imported
  rules, then global; sorted by path within each directory) keeps the bare
  stem; later collisions get `-2`, `-3`, … (e.g. cwd `a.md` → `a`, git-root
  `a.md` → `a-2`, nested `packages/b/.pi/rules/a.md` → `a-3`, imported
  `a.instructions.md` → `a-4`, global `a.md` → `a-5`).
- Project rules come first — cwd rules, then ancestor rules, then nested
  rules, then imported rules — and global rules last; within a directory,
  files are sorted by path.
  Nested directories are ordered shallow-first (nearest to cwd before deeper)
  and lexicographically within the same depth, so ordering never depends on
  filesystem enumeration order.
- A rule from an ancestor or nested directory is referenceable by its own
  rules-directory-relative path (`nested/rule.md`), like a cwd rule; a path that
  repeats across directories resolves to the earliest discovered rule (cwd
  first, then ancestors, then nested, then global).
- Exists matching for ancestor or nested `match: exists` / `both` rules scans
  the glob's own root and compares absolute paths, so it never widens the scan
  beyond the directories the globs name. Each distinct glob root costs one scan
  per cycle, cached like any other scan.
- **Nested descendant discovery.** Rules are also discovered from `.pi/rules`
  directories BELOW the working directory (`<cwd>/packages/b/.pi/rules` while
  the working directory is the repository root). The enumeration is one bounded
  search for `.pi/rules` below cwd: at most 6 directory segments deep (the rule
  base `packages/b` counts as 2), never descending into `.git/` or
  `node_modules/`, never following a symlinked subtree, and never accepting a
  directory outside the working directory — so nothing outside the git root can
  be reached this way either. A nested rule's globs are relative to its own base
  the same way, prepended instead of consumed: `src/**` under
  `<cwd>/packages/b/.pi/rules` matches the working-directory-relative
  `packages/b/src/**` and the absolute `<cwd>/packages/b/src/**`, and never a
  same-named path in `packages/a`. The enumeration runs once per discovery
  cycle, and only for a trusted project: an untrusted project is never globbed,
  and a project with no nested `.pi/rules` dirs behaves exactly as before.
- An unlistable source (e.g. permission error) produces a
  `source-unreadable` error entry for `/rules` and contributes no rules;
  it never breaks the session. An unreadable file produces a
  `read-failure` entry. A file that vanishes mid-scan is skipped
  silently.

### Imported rule formats

Instructions authored for another tool are read in place, never copied or
rewritten, so the original tool keeps working. Every import becomes an ordinary
project rule: `version: 1`, `match: touched`, `load: pinned`,
`enforcement: inform`, `priority: 0`, `source: project`, trust-gated exactly
like `.pi/rules`, cached by mtime exactly like any rule file, and reported in
`/rules` under its REAL file path. Imported files are listed after the nested
`.pi/rules` dirs and before the global dir — Copilot's `.github/instructions`
first, then Claude's `.claude/rules` — and join the same id namespace.

| Importer | Directory | Mapping |
| --- | --- | --- |
| Copilot | `<cwd>/.github/instructions/**/*.instructions.md` | `applyTo` (comma-separated globs); the entry `**` means always-apply; absent `applyTo` — or no frontmatter at all — means `applyTo: **` (always); `description` optional, fallback is the file stem; every other key is ignored |
| Claude | `<cwd>/.claude/rules/**/*.md` | `paths` optional, as one glob string, a comma-separated string, or a list of glob strings (brace expansion allowed); absent `paths` — or no frontmatter at all — means always-apply; `description` optional, fallback is the FIRST body heading, then the file stem; every other key is ignored |

- **Glob scale.** An importer's globs are relative to the working directory
  (the rule base, not the importer's directory), so a Copilot
  `applyTo: src/**` matches the cwd-relative `src/**` exactly as authored — no
  prefix is prepended for the importer root.
- **Reference path.** An imported rule is referenceable by its
  importer-root-relative path (`typescript.instructions.md` for Copilot,
  `typescript.md` for Claude), just as a nested rule is relative to its own
  `.pi/rules`.
- **Ordering.** Both importers run in a fixed order — `.github/instructions`
  before `.claude/rules` — after the nested `.pi/rules` dirs and before the
  global dir. Imported ids compete in the SAME namespace as every other source,
  so `typescript.md` in `.pi/rules`, `typescript.instructions.md` in
  `.github/instructions` and `typescript.md` in `.claude/rules` resolve to
  `typescript`, `typescript-2`, `typescript-3`, with a colliding global rule
  taking `typescript-4`.
- **Lenient parsing.** Imports do NOT use the strict native schema: unknown
  frontmatter keys are ignored (never `unknown-key` errors), the native
  `version`/`description`/activation-condition requirements do not apply, and
  the markdown body is kept verbatim (no blank-edge trimming). Only real
  document damage is an error and still surfaces in `/rules` under the real
  file: broken YAML, a non-mapping frontmatter root, an unterminated `---`
  block, a non-string `description`, a non-string or empty `applyTo` list, and a
  `paths` value that is neither a string nor a list of strings (or that trims
  down to no glob at all).
- **`applyTo` splitting.** Entries are comma-separated, trimmed,
  empty entries dropped, and duplicates collapsed to first-seen order. Only the
  bare entry `**` is the all-matching form; `**/*.md`, `src/**` and friends stay
  ordinary touched-path globs.
- **`paths` forms (Claude).** Claude's key is optional and accepts one glob
  string, a comma-separated string, or a YAML list of glob strings; all three
  normalize to the same touched-path glob list. Entries are trimmed, blank
  entries dropped, and duplicates collapsed to first-seen order. A `paths` value
  that ends up with NO glob (`paths: ''`, `paths: ' , '`, `paths: []`) is a
  parse error rather than a silent always-apply. `**` is NOT special here — it
  stays an ordinary glob that matches every touched path — and only its absence
  means always-apply, matching Claude's own "no paths = always applied" rule.
- **Brace expansion (Claude).** `paths: src/**/*.{ts,tsx}` reaches the glob
  engine verbatim; picomatch expands braces natively, so no expansion happens in
  the importer. The comma-separated form splits only on commas OUTSIDE a `{…}`
  group, so `src/**/*.{ts,tsx}, docs/**` is exactly two globs.
- **Negation (Claude).** Claude does not document negation; `!` entries are
  passed through untouched and therefore behave exactly like a native rule's
  negated glob (they subtract from the positive set). A `paths` list of ONLY
  negations matches nothing, like every other rule.
- **Description precedence (Claude).** An explicit non-blank `description`
  wins; otherwise the FIRST body heading (an ATX line `#`…`######` followed by
  whitespace, its `#` run stripped and trimmed); otherwise the file stem
  (`typescript.md` → `typescript`). A blank explicit `description` counts as
  absent. Headings are not parsed inside fenced code blocks: the first line that
  looks like an ATX heading wins.
- **Disabling.** `PI_RULES_IMPORT=none` (trimmed, case-insensitive) disables
  EVERY importer: no importer root is listed, stat-ed or read, and a repository
  without importer files behaves identically in both modes.

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
  (checked through the [exists-scan cache](#exists-scan-cache)).
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

### Session persistence of touched paths

Touched paths survive resume, reload, and tree navigation. Every newly touched
path batch is appended to the session as a custom entry — `type: "custom"`,
`customType: "pi-rules-md/touched"`, `data: { paths: [...] }` — carrying only
the paths that batch added. A repeat of an already-touched path writes nothing,
so a session never records the same path twice. These entries are session
bookkeeping: they never participate in the LLM context and are never rendered.

On `session_start` (every reason: startup, reload, new, resume, fork) and on
`session_tree`, the touched set is **rebuilt** from the current branch
(`ctx.sessionManager.getBranch()`): the branch's `pi-rules-md/touched` entries
are read in order, normalized, deduplicated first-seen, and that result
replaces the in-memory set. Resuming therefore restores exactly the paths the
resumed branch recorded, and navigating to a different branch drops paths that
only an abandoned branch recorded. A rebuild writes no entries and leaves the
injected-block hash untouched.

Only touched paths persist. `/rules mute` state is in memory: a session switch
or fork starts unmuted, and a resumed session does not restore earlier mutes.
If the branch cannot be read at all, the rebuild is a no-op — the session keeps
the paths it already folded instead of assuming the branch is empty.

### Exists-scan cache

The project scan behind `exists` matching is cached per
`(working directory, pattern set)`. A repeated evaluation with the same working
directory and the same deduplicated first-seen-order glob set reuses the
previous scan instead of walking the project again. The stored value is a
frozen snapshot of what the scanner returned, and a scan that fails propagates
its error unchanged and caches nothing — so matching sees exactly what an
uncached scan would have produced (pinned by a differential test).

The cache is invalidated by:

- a completed `write`, `edit`, or `bash` tool result — the only tool results
  that can have changed which paths exist. `read`, `grep`, `find`, `ls`, and
  unknown tools keep the cache, and a pre-execution `tool_execution_start`
  never invalidates, because the mutation has not happened yet;
- a pattern-set change — new, removed, or reordered globs, or a different
  working directory — which simply misses by key.

Invalidation and caching are not session state: no result of either is folded
into the reducer, and nothing about a tool result is treated as a touched path.
The accepted tradeoff is staleness for changes nothing announced: a file
created or removed by an external process stays invisible until an invalidating
tool result or a pattern-set change arrives.

`.gitignore` handling is untouched (D1). The cache stores only what the scanner
returned, so which files ignore rules hide is still decided solely by the
scanner; the cache never reinterprets, extends, or rewrites ignore lists.

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
- The `exists` scan behind matching is cached per
  `(working directory, pattern set)` and invalidated by `write`/`edit`/`bash`
  tool results and by pattern-set changes; it changes scan frequency only, so
  selection and rendering are unaffected and `.gitignore` semantics are
  unchanged (see [Exists-scan cache](#exists-scan-cache)).
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
  a session switch or fork clears it along with touched paths (which are then
  rebuilt from the new branch's entries, see
  [Session persistence of touched paths](#session-persistence-of-touched-paths)).
  `mute`/`unmute`
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

### Mid-run attachment

Mid-run delivery appends rules that only became active because of a tool result
to that result, instead of waiting for the next turn. The pure core
(`src/attach.ts`) is specified here together with the wiring that drives it
(`index.ts`, `PI_RULES_ATTACH`).

- **Candidates.** `newlyActivated(trace, delivered)` returns the trace's
  selected rules, in selection order (pinned `active`, then `onDemand`), whose
  id is not in `delivered`. Callers seed `delivered` with the ids rendered by
  the current section plus every id attached earlier, so a rule already
  delivered once is never re-attached. Budget-dropped rules are not candidates
  and muted rules cannot appear (mute precedes selection).
- **Remaining budget.** `remaining = budget − Σ estimateTokens` over
  `trace.selection.active`, i.e. the pinned bodies the fresh evaluation would
  render in the section. A rule that fits the fresh selection can still degrade
  to a reference line when the section leaves less room than its own body needs,
  which is why the arithmetic is conservative rather than a second admission pass.
  On-demand index lines consume no budget. The arithmetic is plain, so a
  section that overran its budget leaves zero or negative room.
- **Pinned attachment.** A pinned rule whose `estimateTokens` fits the running
  remaining budget contributes its full entry — the same bytes the section
  renderer emits for that rule and its reasons (`## <description>`, optional
  `> Triggered by:` line, optional `> Level:` line, body verbatim) — and
  decrements the remaining budget.
- **Degradation.** A pinned rule that does not fit contributes the one-line
  reference `- <relativePath> — <description> (fetch with the read_rule tool)`
  instead, the same format as the on-demand index. It charges no budget and
  still counts as delivered, because re-sending a pointer conveys nothing new.
  A rule without `relativePath` has no fetchable reference: it is skipped and
  not counted as delivered.
- **On-demand attachment.** An on-demand rule contributes its reference line
  only, never its body, and charges no budget.
- **Block shape.** One batch renders as `\n\n---\n\n## Rules newly activated
  by this tool result\n\n` followed by the parts joined with `\n\n---\n\n` and
  exactly one trailing newline, so the block is clearly separate from the tool
  output it is appended to and is byte-stable for equal inputs. An empty batch,
  or a batch where nothing can be honestly rendered, produces no block at all.
- **Delivery event.** The block is appended to the tool result as one extra
  text part: the handler returns the result's existing content parts plus the
  block, never a replacement and never an in-place mutation of the array. Pi
  applies a returned `content` (`ToolResultEventResult.content`,
  `dist/core/extensions/types.d.ts:1114`), which is how a `tool_result` handler
  may modify a result.
- **Which results attach.** Only `read`, `edit`, and `write` results. `grep`,
  `find`, `ls`, `bash`, and any custom tool result are left byte-identical.
  An errored result (`isError: true`, the SDK's own marker) is left untouched and
  delivers nothing.
- **Delivered set.** The session keeps the ids already handed to the model: the
  rules of every section the cycle patched, plus every id an attachment batch
  delivered. Ids are added once, kept in first-delivery order, and never
  re-attached. The set is cleared on compaction (the transcript the model
  carries is gone, so a re-injected section may deliver the rule again) and on a
  session switch or fork (new session).
- **Re-evaluation at the tool result.** `before_agent_start` fires once per
  run, so its trace predates the path the tool call folded. The handler therefore
  evaluates current session state through the non-folding evaluation seam
  (`evaluateCurrent`): discovery is mtime-cached and the exists scan is cached
  (invalidated first by the results that can change the filesystem), so the
  second evaluation is cheap. It uses the session facts of the last
  `before_agent_start` (tool names, model, branch), the current cwd, trust, and
  clock, and an EMPTY prompt — a tool result has no user prompt of its own, so
  turn-prompt intent keywords do not apply mid-run.
- **No section mutation.** The re-evaluation returns data only: it never patches
  or removes a section, never folds `block_injected`/`block_removed`, and never
  mutates the state object. `before_agent_start` owns the injected-block hash and
  the patch/remove lifecycle. The re-evaluation also does not replace the trace or
  the discovery errors `/rules` reports, which stay those of the last real cycle.
- **Toggle.** Attachment is on by default. `PI_RULES_ATTACH=off` (trimmed,
  case-insensitive) disables it at the composition root; an absent or
  unrecognized value keeps it enabled. Disabling it never affects the
  exists-scan invalidation, which stays a separate effect of the same event.
- **Totality.** The handler never throws: a foreign, truncated, or hostile
  result shape produces no attachment, because a `tool_result` handler runs
  inside pi's event dispatch.
- **Enriched rules.** `read_rule`, `/rules show`, and the attachment renderer
  resolve rules from the enriched list the cycle produced
  (`PipelineResult.rules`): discovery returns raw rules without a
  rules-root-relative path, so the wiring must not read the discovery seam
  directly or every reference would answer `Unknown rule: <id>`.

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
- Touched paths are no longer session-memory only. Each newly touched path
  batch is persisted as a `pi-rules-md/touched` custom session entry, and
  `session_start`/`session_tree` rebuild the touched set from the current
  branch, so a resumed session keeps its paths while tree navigation drops the
  abandoned branch's. Session mutes stay in memory and are not persisted.

## 7. Errors (visible via `/rules`)

Parse and discovery errors never break the session; they are collected
and reported: `yaml-syntax`, `missing-frontmatter`, `unknown-key`,
`invalid-version`, `missing-description`, `invalid-value` (field type),
`match-without-globs`, `no-activation-condition`, `read-failure`,
`source-unreadable`. Error entries carry the offending file (or
directory for `source-unreadable`) and are reused from the mtime cache
while the file is unchanged.

An unreadable source is cached the same way (v1.2): the `source-unreadable`
outcome for a directory is recorded on the discovery cache, so a later pass
re-reports the identical error — `/rules` output does not change — without
listing that directory again, until the directory's own mtime changes (or,
when it could not be stat-ed at the failure, the first stat that succeeds).
Only the repetition cost changes, never what is reported.
