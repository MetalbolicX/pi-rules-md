# pi-rules-md — Feature Tasks

Conditional markdown rules injected into the pi system prompt, matched by
files (touched by the agent or existing in the project) and other
conditions. Functional core / imperative shell; FP paradigm; no classes.

Planning research: Engram `planning/pi-rules-md-v2-architecture` (pi-tier-router
project, revisions 1-2). Host comparison opencode-rules-md v0.10.3 vs pi 0.87
verified from source; key decisions recorded there.

## Invariants (verified against pi 0.87 docs/source)

- Injection ONLY via `systemPromptOptions.sections` mutation in
  `before_agent_start` — never `systemPrompt` (cache miss + clobbers other
  extensions), never persistent `message` (accumulates in transcript).
- Hash hysteresis: unchanged active set → mutate nothing (zero patch cost).
- `session_compact` → reset last-injected hash; `session_before_switch`/`fork`
  → reset session state.
- Project rules gated by `ctx.isProjectTrusted()`.
- pi throws on duplicate tool names; extension load errors are FATAL in
  non-interactive mode — the extension must load clean from day one.

## Rule format v1 (RULE-SPEC.md will be the public contract)

Frontmatter: `description`, `globs` (OR across patterns, `!` negation),
`match` (touched|exists|both), `tools`, `branch`, `model`, `priority`,
`enforcement` (enforce|recommend|inform), `alwaysApply`, `version` (1).
Unknown keys → strict validation error, never silent. Rules are data only —
no code escape hatches.

## Tasks (strict TDD, in order)

- [x] 1. `src/types.ts` + `src/result.ts` — domain data (Rule, EvaluationContext,
  MatchResult discriminated unions, Selection, InjectionBlock, branded RuleId/
  NormalizedPath) + hand-rolled Result<T,E> with combinators — c083df4
- [x] 2. `src/frontmatter.ts` — strict parser → Result<Rule, RuleError>;
  fs/readFile injected as parameters — 28a4b74
- [x] 3. `src/conditions/` — predicate factories glob/tool/model/branch/always
  + `combinators.ts` (and/anyOf/not) — df4492a+f49544c (incl. globs:[] fix)
- [x] 4. `src/conditions/table.ts` — data registry; unknown-key strict errors — ec18878
- [x] 5. `src/match.ts` — touched-match + exists-match; injected
  extension-targeted scan seam derived from globs — 20b5632. Production
  tinyglobby adapter/ignore policy remains for T10 shell wiring.
- [x] 6. `src/select.ts` — dedupe(content hash) → sort(priority) → token
  budget fold. Parent-pinned decisions implemented as contract: dedupe
  keeps FIRST occurrence (sha-256 of content via node:crypto), sort
  priority DESC stable on ties, fold stops at the first non-fitting rule
  and drops the remainder, token estimate ceil(chars/4).
- [ ] 7. `src/render.ts` — strong imperative framing + per-rule trigger
  metadata; golden-file tests
- [ ] 8. `src/engine.ts` — evaluate pipeline + immutable EvaluationTrace
- [ ] 9. `src/state.ts` — reducer: transition(state, PiEvent) → state
- [ ] 10. `shell/discovery.ts` — global ~/.pi/agent/rules/ + project .pi/rules/,
  trust gate, mtime cache
- [ ] 11. `shell/collectors.ts` — pi events → Signals (typed fake-event tests)
- [ ] 12. `shell/injection.ts` — sections mutation + hash hysteresis
- [ ] 13. `index.ts` wiring + `/rules` command + EvaluationLog
- [ ] 14. Dogfood: real rules in this environment + marker-token probes
  (section appears, patch discipline, /rules report)
- [ ] 15. RULE-SPEC.md + README + property tests (fast-check) + perf guard
  (500 rules × 50 paths under budget)

## Delivery strategy

- `ask-on-risk` resolved by the user to `stacked-to-main` PR slices; no
  push/PR/merge authorized. Running authored diff from main at T5:
  2710 additions + 10 deletions = 2720 lines (including tests/docs).
  Work-unit commits are review boundaries; slice composition/size exceptions
  for cohesive units exceeding ~400 lines remain pending PR preparation.

## Acceptance

- All unit/property/golden tests green; typecheck strict clean.
- Real-session probes: rule with `src/**/*.ts` activates only after touching
  a .ts file; second turn with unchanged set produces no new patch; `/rules`
  shows active/inactive with reasons.
- `pnpm pack` tarball installs into a clean ~/.pi and loads (pi -p exit 0).

## Evidence log

- T1 c083df4 `feat(core): add domain types and Result type` — 41/41 tests,
  typecheck 0, verifier PASS (4 files, only src/ touched). Decisions: match
  default "both" + priority default 0 materialized at parse time (T2); MatchResult
  discriminant field `matched`; `match` combinator takes `{ ok, err }` arms;
  `unwrapOrThrow(error => Error)` optional mapper.
- T2 28a4b74 `feat(core): strict frontmatter parser with injected fs` — 81/81
  tests, typecheck 0, verifier PASS. Decisions: defaults materialized at parse
  (enforcement default "inform"); description required; ≥1 activation condition
  required; YAML strict schema (anchors/aliases/duplicates rejected); `yaml`
  ^2.9.1 only new runtime dep. Known nits (deferred): `globs: []` + other
  condition slips past match-without-globs; `version: 1.0` accepted as 1.
  Native review: lineage review-4bcbc28fdc992857 frozen (medium tier,
  review-reliability lens, budget 200) but reviewer capture unreachable —
  gentle-pi 3.5.1 defects; incidents recorded in Engram
  (incident/gentle-pi-committed-range-start, incident/gentle-pi-capture-route-invisible).
  Upstream issues #992/#1154 commented (duplicates confirmed);
  implementation RESUMED at T3 by user decision — review capture still
  blocked upstream, no retry until a fixed release; T3 carries no review
  lineage (disclosed to user).
  Sync note: `gentle-ai sync --agent pi` fixed managed_assets_outdated.
- T3 df4492a `fix(frontmatter): reject explicitly empty globs` + f49544c
  `feat(conditions): predicate factories and combinators` — 113/113 tests,
  typecheck 0, verifier PASS (run on openai-codex/gpt-6-luna per user
  config change). Decisions: empty globs → invalid-value (field-types
  stage precedes match-without-globs; globs-absent keeps that code);
  picomatch ORs negations in arrays → globMatcher splits positive/
  negative and composes; branch v1 exact equality; and([])=true,
  anyOf([])=false; @types/picomatch devDep (picomatch 4.0.7 untyped,
  esModuleInterop off → single sanctioned .default unwrap).
  version:1.0 nit still deferred to T15.
- T4 ec18878 `feat(conditions): declarative condition registry` — 154/154 tests
  (113 pre-existing unchanged), typecheck 0, verifier PASS (after one cast-hygiene
  fix round: parseMatch narrowing + CONDITION_KEYS literal tuple with mutual-
  extends compile-time binding; exactly one sanctioned cast in conditionSpec).
  Decisions: kind-discriminated spec union (mode/ctx/path); CONDITION_KEYS order
  mirrors original validation precedence (globs, match, tools, branch, model,
  alwaysApply); tools:[] accepted (pinned), globs:[] rejected (pinned);
  cross-field invariants stay in frontmatter in original order; metadata keys
  (version/description/priority/enforcement) outside the table. Verifier: gpt-6-luna.
  INSTRUMENTATION: gentle-pi patched log-only (seams: session-key,
  retain-skip/done, capture-lookup) writing /tmp/rdd-debug.log; backup at
  ~/.pi/rdd-debug/gentle-ai.ts.backup; pending post-restart probe of frozen
  lineage review-4bcbc28fdc992857. POST-RESTART PROBE RESULT: route system
  works (same instance, same session key, registration landed, mapSize 1);
  rejections were MY transcription corruption of the ~2750-char collectBinding
  (offline diff via facade decoder pinpointed char 1473). Unblock: mechanical
  canonical binding (make-binding.mjs, ~/.pi/rdd-debug/) -> capture ACCEPTED ->
  forecast -> acknowledged run -> reviewer APPROVED the T2 candidate.
  Second blocker: reviewer model must live in ~/.pi/gentle-ai/models.json
  (NOT subagents.json) -> review-reliability -> gpt-6-luna. Third: burn
  preflight rejected post-commit workspace drift (intended-untracked now
  tracked) -> user-approved surgery: backup/pre-burn branch, reset --hard
  651234b, restore frozen tree 53d830db content (4 tracked-modified + 2
  untracked), rm src/conditions -> acknowledge-approved BURNED
  (gentle-ai.review-acknowledged/v1, mutation committed) -> reset --hard
  backup/pre-burn -> tree clean 66b93c1. Harness unpatched from backup.
  T2 native review COMPLETE end-to-end.
- T5 route: delegated direct via gentle-ai-worker; 2+ non-trivial files and
  dependency manifest/lock. Strict TDD from feature plan, runner `pnpm vitest
  run` (focused file runner during RED/GREEN). Parent reconciled task file
  against Engram observation 6951; prior Engram mirror was a summary, so it
  is being replaced by the full recovery document. Branch feat/pi-rules-md
  clean at d3114b4 before the T5 writer.
- T5 20b5632 `feat(match): evaluate touched and existing rule paths` —
  strict TDD RED (missing `./match.ts` module), GREEN 19/19,
  TRIANGULATE negation/modes/reasons/scan failures; full 173/173 and
  typecheck 0. Independent verifier PASS (19/19, 173/173, typecheck 0,
  diff --check, clean tree). Native workspace review lineage
  review-8b73e41cc0029629: medium tier, review-reliability approved and
  acknowledged (authority burned) BEFORE commit. Post-commit committed-
  range ASSESS returned unassessable/schema-incompatible (known #992);
  separate verifier ran per high-risk fallback. Dependency tinyglobby
  ^0.2.17 installed despite pnpm add exit 1 on ignored unrelated builds;
  adapter deferred to T10. No real filesystem/ignore integration tested
  yet; T10 must cover that behavior. Next: T6 selection pipeline.
- T6 `feat(select): dedupe, priority-sort and budget-fold rule selection` —
  strict TDD RED (missing `./select.ts` module), GREEN 15/15 then 20/20
  after triangulation; full 193/193 (173 pre-existing unchanged), typecheck
  0. Stages exported individually (dedupeByContent, sortByPriority,
  foldBudget, estimateTokens, contentHash) composed by selectRules; drops
  stage-ordered (duplicates in input order, then budget drops in priority
  order). Native workspace review lineage review-d122c277d9b71d45: medium
  tier, review-reliability APPROVED and acknowledged (authority burned)
  BEFORE commit, one non-blocking advisory finding R3-001
  (src/select.ts:77, WARNING, informational) recorded as T15 follow-up
  nit. Worker fixture bugs fixed in-test during GREEN (content-identical
  fixtures) — implementation unchanged.
