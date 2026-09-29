# Code Health Remediation (post-audit)

Apply the code-health-audit findings (2025 session audit, score 8/10) with the
recommended options: Decision A = basename-level intent compatibility; Decision
B = wire `describe` into the /rules report.

Rules to honor while editing (dogfooded from the live global rules, verified on
disk): tabs, double quotes, mandatory semicolons, `const`/arrow/functional
style, no `var`, no `any`, `node:` prefix imports, `strict` never disabled.

## Tasks

| # | Task | Finding | Status | Commit |
|---|---|---|---|---|
| 0 | Housekeeping: land dep bumps, ignore scratch, commit odd/tasks docs | L10 | done | (below) |
| 1 | Basename-level intent-glob compatibility + engine cleanup | H1, L9 | done | 5b9ba02 |
| 2 | Unified rules-path derivation + budget at composition root | M2, M5 | done | 95fd9d6 |
| 3 | Shared trigger vocabulary + wire `describe` into /rules report | M4, B | done | 0e9a694 |
| 4 | Prune dead surface + collapse RuleError union | M3, L6 | done | c1ad766 |
| 5 | Discovery stat: only ENOENT skips silently + intent.ts tabs | L8, L7 | done | 9c055af |
| 6 | Final full gate (typecheck + all tests) via verifier | — | done | see below |

## Evidence

- Step 0: `86011af` chore(deps), `7dc8577` chore gitignore/odd docs
- Step 1: `5b9ba02` fix(match): basename-level intent-glob compatibility (52/52 slice green)
- Step 2: `95fd9d6` fix(shell): unified rules paths + composition-root budget (395 green)
- Step 3: `0e9a694` refactor(render): shared trigger vocabulary + describe in /rules (398 green)
- Step 4: `c1ad766` refactor(types): pruned dead surface + collapsed RuleError (366 green; −32 tests of deleted dead exports)
- Step 5: `9c055af` fix(discovery): ENOENT-only stat skip + intent tabs (367 green)
- Gate (gentle-ai-verify): `pnpm typecheck` clean; `pnpm test` 25 files / 367 tests / 0 failures; tree clean.

## Notes

- Baseline delta math: 384 → 367 = +15 new pins, −32 dead-export tests removed. No behavior tests lost.
- Worker fallback: for step 4 the worker cannot delete files; parent executed the deletion refactor inline after two scoped worker continuations.
