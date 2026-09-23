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
- [ ] 2. `src/frontmatter.ts` — strict parser → Result<Rule, RuleError>;
  fs/readFile injected as parameters
- [ ] 3. `src/conditions/` — predicate factories glob/tool/model/branch/always
  + `combinators.ts` (and/anyOf/not)
- [ ] 4. `src/conditions/table.ts` — data registry; unknown-key strict errors
- [ ] 5. `src/match.ts` — touched-match + exists-match (extension-targeted
  project scan derived from globs)
- [ ] 6. `src/select.ts` — dedupe(content hash) → sort(priority) → token
  budget fold (port opencode-rules-md tests where applicable)
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
