# Feature: catch-up-reference-parity

Status: **merged to main** (ff 2837e30 → 44314aa); stash@{0} popped clean (dep bumps restored uncommitted, as before the feature); main verified: typecheck ✓, 384/384. Remaining user decision: npm publish.
Baseline: `main` @ `2837e30`. Reference: `opencode-rules-md` @ `d601670` (v0.12.0).
Branch: `feat/catch-up-reference-parity` (from W0).

## Goal

Bring pi-rules-md to behavioral parity with the reference's post-baseline evolution
(29 commits since 684d41e), adapted to the pi runtime: on-demand reference tier,
`read_rule` tool, intent-based pre-loading, stability ordering, discovery hardening,
and aligned selection semantics. No CLI (pi auto-loads extensions; install machinery
is OpenCode-specific). No lint-toolchain ports.

## Dependency graph

```
W0 ──▶ W1 (schema) ──▶ W3 (selection) ──▶ W4 (on-demand core) ──▶ W5 (read_rule)
   └──▶ W2 (discovery hardening)  [independent of W1]
   └──▶ W7 (context capture)      [independent of W1..W6]
W1 ──▶ W6 (intent; needs keywords + prompt threading)
W1..W7 ──▶ W8 (docs finalize) ──(user go)──▶ W9 (activation, live ~/.pi)
```

Write order stays linear (single-threaded): W0→W1→W2→W3→W4→W5→W6→W7→W8→(W9).
W2 and W7 have no schema/core dependencies — safe to move earlier or split for
review batching if needed. W4/W5 land before W6 so the perf guard re-baselines once.

## Global Definition of Done (every WU)

1. RED observed first: failing test(s) named in the WU exist and fail for the right
   reason before implementation.
2. GREEN: `pnpm typecheck` + `pnpm test` (full suite) pass; T15 perf guard passes
   (mandatory re-check after W3/W4).
3. RULE-SPEC.md updated in the same WU as the behavior (never after the fact).
4. Native review burned (approved) before the WU commit — RDD on.
5. One conventional commit (message pre-agreed per WU below); commit hash recorded
   in the Evidence log + Engram mirror + visible todo transition.
6. No throw crosses the extension boundary: all new code paths are total
   (typed errors / no-ops) — pi extension errors are fatal.

## Closed decisions

1. **Scope**: broad catch-up; CLI + tooling commits excluded.
2. **On-demand retrieval**: parity `read_rule` tool via `pi.registerTool` (native read
   alternative rejected).
3. **Token budget**: always-on default 2000 + `PI_RULES_MAX_TOKENS` env override;
   on-demand index lines bypass the budget.
4. **Dedupe**: higher `priority` wins on equal stripped content; tie → later discovery
   index wins (supersedes v1 first-occurrence rule).
5. **Budget fill**: greedy skip-and-continue; first sorted entry always kept
   (supersedes v1 stop-at-first-non-fit).
6. **Intent pre-loading**: `detectIntentGlobs` over the current turn prompt + keyword
   donation; intent globs match rule globs but never enter the path pool; NO history
   seeding in this feature.
7. **Render surface**: stays port-style (`# Rules`, `## <description>` headings).
   RULE-SPEC §6 `## <id>` mismatch resolved in favor of the code + pinning test.
8. **Process**: strict TDD per WU (RED→GREEN→REFACTOR) via `gentle-ai-worker`;
   native review before each code commit; conventional commits; ODD doc + Engram
   mirror updated at every task transition.
9. **Runtime constraints (pi)**: `systemPromptOptions.sections` is rebuilt every turn
   (re-apply semantics already handled in shell/injection.ts); `BeforeAgentStartEvent`
   carries `prompt: string` (SDK types.d.ts:555-558); `registerTool` takes a TypeBox
   `ToolDefinition` (types.d.ts:343-368, 1018-1019) — NOT zod; custom tools are
   omitted from the system prompt's Available-tools section unless `promptSnippet`
   is provided (types.d.ts:352-353); `ToolExecutionStartEvent` =
   `{ toolCallId, toolName, args: any }` (types.d.ts:673-678) — extraction from
   `args: any` must be total.

## Tasks

### W0 — Setup: isolate dirty state, create branch
**Depends on**: nothing.
**Steps**:
- `git stash push -m "pre-catch-up dep bumps" -- package.json pnpm-lock.yaml`
  (record the stash ref in the Evidence log); leave untracked `odd/` scratch files
  (`condense-language-rules.md`, `pr-slices.md`, `scratch-verify-rules.mjs`) in place.
- `git switch -c feat/catch-up-reference-parity` from `main` `2837e30`; verify clean
  tracked tree.
- Stash pops back only after the feature merges to main AND the tree is clean
  (expected: version/deps hunks do not overlap feature commits).
**Acceptance**: branch active; `git status` shows only the known untracked odd files;
stash ref logged.
**Commit**: none (setup).

### W1 — Schema v1.1: `load` + `keywords` frontmatter fields
**Depends on**: W0.
**RED tests** (frontmatter.test.ts, types.test.ts):
- "accepts load: pinned" / "accepts load: on-demand" / "rejects unknown load value"
- "accepts keywords as string array" / "rejects keywords with non-string entries"
- "defaults load to pinned when absent"
- render.test.ts: "renders description as rule heading" (pins `## <description>`,
  resolving the §6 mismatch).
**Steps**:
- `METADATA_KEYS` (src/frontmatter.ts:38, currently `description, enforcement,
  priority, version`) gains `load` and `keywords`. `keywords` is **metadata consumed
  by intent donation, not a condition key** — it never gates matching by itself, so
  it does NOT enter `CONDITION_KEYS` (src/conditions/table.ts). A keywords-only rule
  without another activation condition still fails with `no-activation-condition`
  (reference parity: donation requires the rule's own `globs`).
- `load?: "pinned" | "on-demand"` and `keywords?: string[]` on `Rule` in
  src/types.ts; default pinned.
- RULE-SPEC v1.1: document both fields; fix §6 heading to `## <description>`.
**Gotcha**: strict schema rejects unknown keys — adding to METADATA_KEYS is the only
acceptance path; reject `load` values outside the enum (reference silently ignores;
port fails closed — keep port behavior, document it).
**Acceptance**: accept/reject matrix green; spec/code mismatch closed with pinning test.
**Commit**: `feat(schema): accept load and keywords frontmatter fields`

### W2 — Discovery hardening: symlinks + depth cap
**Depends on**: W0 (independent of W1; ordered here for review batching).
**RED tests** (shell/discovery.test.ts):
- "skips a symlinked rule file outside the rules dir"
- "skips rules inside a symlinked directory"
- "stops recursion at depth 10"
- "ignores hidden entries" (pins existing `dot:false` behavior)
**Steps**:
- Verify installed tinyglobby (^0.2.17) options first: if `followSymbolicLinks:false`
  and a depth option exist and work, use them; otherwise post-filter with
  `lstatSync` (skip `isSymbolicLink()`) and a depth-aware scan. Do not guess —
  write the fixture test first, then pick the mechanism that makes it pass.
- Cap = 10, mirroring reference `MAX_RULES_SCAN_DEPTH` (constants.ts:20).
- ENOENT stays benign; other IO errors become typed RuleErrors (existing convention).
**Reference anchors**: rule-discovery.ts:96-146, :118-122 (symlink skip), :103-105
(depth); tests rule-discovery.test.ts:177-237.
**Acceptance**: guard tests green with real symlink fixtures; no behavior change for
plain trees (suite green).
**Commit**: `fix(discovery): skip symlinks and cap recursion depth`

### W3 — Selection semantics: stability order + dedupe/fill alignment
**Depends on**: W1 (schema fields), W2 (ordering interacts with discovery indices).
**RED tests** (select.test.ts):
- "orders unconditional rules before conditional within the same priority"
- "orders by priority desc then discovery index asc within a stability group"
- "dedupe: higher priority wins on equal content; tie goes to later discovery"
- "budget fill skips non-fitting entries and continues"
- "budget always keeps the first sorted entry"
- "PI_RULES_MAX_TOKENS overrides the default budget; invalid values fall back to 2000"
**Steps**:
- `stabilityGroup(rule)`: unconditional (alwaysApply true / no declared conditions)
  → group 0, else 1; presentation comparator group → priority desc → discovery
  index asc. Applied AFTER budget selection (reference orderForPresentation,
  rule-filter.ts:349-356; docs/rules.md:274).
- Dedupe: replace first-occurrence with priority-wins / later-index tie.
- Fill: greedy skip-and-continue; first entry always kept; cannot yield zero.
- Shell reads `PI_RULES_MAX_TOKENS` (parseInt; NaN/<=0/absent → 2000).
- RULE-SPEC §6 rewritten to the aligned semantics; v1 divergences noted as superseded.
**Gotcha**: discovery index must be a stable total order across both sources
(project-first then global, already sorted) — re-verify id-suffix disambiguation
(`-2`, `-3`) does not corrupt index ordering.
**Acceptance**: ordering/dedupe/fill/env tests green; perf guard green (mandatory).
**Commit**: `feat(select): stability ordering and aligned dedupe/fill semantics`

### W4 — On-demand tier core: partition + index
**Depends on**: W3 (partition runs after selection semantics are final).
**RED tests** (select.test.ts, render.test.ts, engine.test.ts):
- "renders index line instead of body for load: on-demand"
- "appends the on-demand index after the pinned block"
- "on-demand index lines do not consume budget"
- "no index section when no on-demand rule matches"
- "matched paths still include on-demand rules"
- "trace records the partition"
**Steps**:
- Post-match partition in select: `load !== "on-demand"` → dedupe+budget path;
  `load === "on-demand"` → bypass dedupe and budget; bodies never rendered nor counted.
- render appends, last:
  `## Reference rules available on demand` +
  `- <relativePath> — <description> (fetch with the read_rule tool)`
  (description suffix only when present — port description is required, but keep the
  conditional shape for robustness).
- Token estimate recomputed over the final string incl. the index; `matchedPaths`
  includes on-demand files; trace gains the partition outcome.
**Reference anchors**: rule-filter.ts:325-345; pins rule-filter.test.ts:55-99, :83-91.
**Gotcha**: index text must match what W5's tool description tells the model to look
for — freeze the exact string "Reference rules available on demand" in both.
**Acceptance**: tier tests green; perf guard green (mandatory re-baseline here).
**Commit**: `feat(rules): on-demand reference tier partition and index`

### W5 — `read_rule` tool
**Depends on**: W4 (the index that references the tool).
**RED tests** (shell/read-rule.test.ts):
- "returns stripped body for a known rules-relative path"
- "returns Unknown rule for an unknown name"
- "rejects ../ traversal"
- "rejects absolute paths (posix and win32)"
- "re-checks containment after root resolution"
**Steps**:
- `shell/read-rule.ts`: pure contract factory + total execution (never throws).
  Arg `name` = rules-relative path; lookup by exact `relativePath` over discovered
  rules; guards: `path.isAbsolute || path.win32.isAbsolute || segments.includes("..")`
  → `Unknown rule: <name>`; re-resolve against the rule's root and re-check
  containment; return `stripFrontmatter(body)` (reuse src/frontmatter.ts).
- Wiring in index.ts: extend `PiExtensionApiLike` mirror with `registerTool` (structural
  mirror discipline — no runtime pi import). `parameters` uses **TypeBox** (pi SDK
  constraint), not zod (reference uses zod via @opencode-ai/plugin — do not copy).
- **Provide `promptSnippet`**: without it pi omits the tool from the Available-tools
  section (types.d.ts:352-353) and the model may never see `read_rule` despite the
  index referencing it.
- Description wording (adapted): "Fetch the full content of a reference rule by its
  rules-relative path. Use when a \"Reference rules available on demand\" index entry
  is relevant to the current task."
**Reference anchors**: rule-tools.ts (full contract), runtime.ts:67 (registration).
**Acceptance**: tool tests green; typecheck green with mirror extended; manual sanity:
tool visible in a scratch pi session (optional, logged if done).
**Commit**: `feat(tools): read_rule tool for on-demand retrieval`

### W6 — Intent pre-loading (prompt + keywords)
**Depends on**: W1 (keywords), W4/W5 (tier complete; perf re-baseline once).
**RED tests** (src/intent.test.ts, match.test.ts, engine.test.ts):
- "detects language globs from prompt words, case-insensitive, whole-word"
- "does not match bare 'go'"
- "donates a rule's globs when its keywords match the prompt"
- "intent globs satisfy a globs condition without any path in the pool"
- "intent globs never enter the context path pool"
**Steps**:
- New `src/intent.ts` (pure): lexicon python, pytest, rust, typescript, javascript,
  golang, kotlin, java, csharp, ruby (deliberately no bare `go`) → language globs
  (`*.py`, `*.rs`, …); `detectIntentGlobs(prompt, rules)`: lexicon hits + keyword
  donation (rule whose `keywords` match the prompt contributes its own `globs`).
- Thread `prompt` from `BeforeAgentStartEvent` (SDK types.d.ts:555-558) through
  `PipelineInput` into `EvaluationContext`; extend the mirror in index.ts.
- Matching: a rule's globs condition passes on real path match OR intent-glob
  coverage (matchBase semantics); intent globs are a separate input — never unioned
  into context paths.
**Reference anchors**: intent-lexicon.ts:18-32; rule-filter.ts:188-195; pin test
rule-filter.test.ts:93-99.
**Gotcha**: the port's `match` axis (touched/exists/both) is unrelated to the
reference's `match: any|all` — do not conflate; intent interacts only with the globs
condition.
**Acceptance**: intent tests green incl. the "no paths added" pin; engine end-to-end
case green.
**Commit**: `feat(intent): prompt-based intent pre-loading with keyword donation`

### W7 — Context capture: pre-execution alignment
**Depends on**: W0 (independent of W1..W6; ordered here to keep diffs reviewable).
**RED tests** (shell/collectors.test.ts):
- "captures file_path from read/edit/write at execution start"
- "captures path from glob/grep at execution start"
- "captures workdir from bash at execution start"
- "ignores malformed args without throwing"
- "does not double-count repeated identical paths"
**Steps**:
- Subscribe to `tool_execution_start` (SDK types.d.ts:673-678; payload
  `{ toolCallId, toolName, args: any }`) instead of `tool_result`; extraction stays
  total (`args` is `any` — guard every access).
- Map pi tool arg names (verify exact keys from pi's built-in tool definitions during
  TDD — e.g. `file_path` vs `filePath`): read/edit/write → file path, glob/grep →
  search path, bash → workdir.
- Keep existing normalization/dedupe; `tool_result` subscription removed only if
  redundant after the switch (keep if it still feeds other signals).
**Reference anchors**: runtime.ts:71-108 (arg map incl. bash workdir).
**Acceptance**: collector tests green; no regression in match:touched engine tests.
**Commit**: `fix(collectors): capture context from tool_execution_start`

### W8 — Docs finalize
**Depends on**: W1..W7.
**Steps**:
- RULE-SPEC v1.1 complete: load, keywords, stability order, greedy fill, dedupe
  tie-breaks, PI_RULES_MAX_TOKENS, on-demand tier + frozen index string, read_rule
  contract, intent pre-loading semantics; superseded v1 divergences listed.
- README: on-demand workflow, authoring guidance (when to pin vs on-demand,
  keywords usage), budget override.
- Full suite + typecheck + perf guard green on the branch tip.
**Acceptance**: docs match implemented behavior (spot-check each section against tests).
**Commit**: `docs: finalize RULE-SPEC v1.1 and README`

### W9 — (separate slice, explicit user go after W8) Activation + dogfood
**Depends on**: W8 + user go.
- Mark heavy local rules in `~/.pi/agent/rules/programming-languages/` as
  `load: on-demand`; restore the `keywords` stripped during the opencode→pi
  conversion; dogfood in real pi sessions; record payload numbers.
- Touches live `~/.pi` config — never executed without the explicit go.

## Risk register

| Risk | Mitigation |
|---|---|
| tinyglobby symlink/depth defaults unverified | W2 writes fixture tests first; lstat+manual walk fallback |
| pi tool schema is TypeBox, reference is zod | W5 uses TypeBox parameters; no copy of reference tool schema |
| Tool invisible without `promptSnippet` | W5 provides it; manual visibility sanity check |
| `args: any` at execution start | W7 guards every access; malformed args → no-op |
| `match` axis naming conflation | W6 design note: intent touches only the globs condition |
| Sections rebuilt per turn | Already handled (shell/injection.ts); no persistence logic anywhere |
| Extension errors are fatal in pi | Total code paths only; typed errors collected, never thrown |
| Perf guard drift after W3/W4 | Mandatory re-check in both WUs' DoD |
| Dirty stash conflicts on pop | W0 records stash ref; pop only after merge, clean tree expected |
| W9 touches live config | Separate user-gated slice |

## Verification

- Per WU: `pnpm typecheck` + `pnpm test` (full suite); perf guard after W3/W4.
- Reference parity spot-checks: frozen index string matches W4 render + W5 tool
  description; lexicon equals reference set.

## Evidence log

| Task | Commit | Outcome |
|---|---|---|
| W0 | stash@{0} "pre-catch-up dep bumps" | branch feat/catch-up-reference-parity @ 2837e30; clean tracked tree; untracked odd files untouched |
| W1 | d4d6814 | RED 6f→GREEN; 350 tests, 23 files; typecheck ✓; native review approved+burned (lineage review-2aed828d1bc8429f) |
| W2 | 25e491c | lstat guard (tinyglobby 0.2.17 lacks options); RED 3f→GREEN 28/28; 354 tests; review burned (review-6e5ccb5ec17aabf0) |
| W3 | 1a74171 | RED 8f→GREEN; 364 tests; 4 properties updated to new contract; §6 rewritten; review burned (review-909e4a6ec235af1a). ADVISORY follow-up: R3-001 WARNING shell/pipeline.ts:121 (informational) |
| W4 | e245782 | RED→372 tests; frozen index heading; relativePath materialized in shell; review burned (review-33ef9ae8d0a760af). ADVISORY follow-up: R3-001 WARNING src/render.ts:87 (informational) |
| W5 | 2d63028 | 378 tests; typebox@1.3.27 pinned (SDK transitive match); promptSnippet + frozen description; total execution; review burned (review-c1819c24e5f02219) |
| W6 | b29e340 | 388 tests; perf guard 124.2ms; lexicon + donation + path-pool separation; review burned (review-8e5a216a5625f015). ADVISORY follow-ups: R3-001 src/match.ts:98, R3-002 src/engine.ts:124 (informational) |
| W7 | 08a2db7 | aligned to installed pi built-ins (read/edit/write/grep/find → path; bash no workdir arg = documented divergence); 384 tests; review burned (review-46f3ebfce6d9c2a3) |
| W8 | 44314aa | docs-only (passive exception, no review); README + RULE-SPEC v1.1; tip verified: typecheck ✓, 384/384, perf 106.9ms |
| W9 | live ~/.pi (no repo commit) | 5 files edited (rescript+generic on-demand; keywords restored bash/python/rescript/rust); backups /tmp/w9-backup-*; 7/7 parse OK v1.1; dogfood: A touched .res+.ts → 291t vs 1872t (84% cut); B prompt-only → python pinned body via lexicon intent (zero paths), rescript index via keyword donation, 344t vs 1553t (78% cut); read_rule key=programming-languages/rescript.md, body stripped |
