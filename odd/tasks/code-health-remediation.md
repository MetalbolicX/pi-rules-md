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
| 1 | Basename-level intent-glob compatibility + engine cleanup | H1, L9 | pending | — |
| 2 | Unified rules-path derivation + budget at composition root | M2, M5 | pending | — |
| 3 | Shared trigger vocabulary + wire `describe` into /rules report | M4, B | pending | — |
| 4 | Prune dead surface + collapse RuleError union | M3, L6 | pending | — |
| 5 | Discovery stat: only ENOENT skips silently + intent.ts tabs | L8, L7 | pending | — |
| 6 | Final full gate (typecheck + all tests) via verifier | — | pending | — |

## Evidence

- Step 0: `chore(deps): bump typescript, vitest, @types/node` + `chore: ignore scratch scripts, commit odd task docs`
- (workers append per-task commit ids here)
