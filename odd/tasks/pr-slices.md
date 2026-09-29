# pi-rules-md Stacked PR Slices

**Status:** Seven local slice refs created. `main` fast-forwarded locally to the feature tip. No remote configured; no push or PR creation performed.

## Decision

Use **Stacked PRs to main**, preserving the existing linear feature history and already-reviewed work-unit commits. Do not rewrite commits or split work units. Create one local branch ref at each existing slice boundary; each child PR targets the immediately preceding slice branch. The first slice targets `main`.

Each slice exceeds the 400-line review budget. Preserve cohesive work-unit boundaries and request/record `size:exception` on each PR rather than deleting tests/docs or compressing code. This is one bounded slicing pass; no further splitting is proposed.

## Dependency chain

```text
main
  └─ 📍 PR 1: foundation (eeca768)
       └─ PR 2: conditions (d3114b4)
            └─ PR 3: core pipeline (67cf988)
                 └─ PR 4: discovery + collectors (2357800)
                      └─ PR 5: injection + wiring (e2c7ed5)
                           └─ PR 6: dogfood fix + hardening (cb18417)
                                └─ PR 7: property/perf + public docs (2837e30)
```

`📍` denotes the first/current slice boundary in the chain diagram; subsequent slices depend on the prior slice.

## Slice boundaries and review budgets

Counts are measured with `git diff --shortstat <base> <head>`; changed-line budget is additions + deletions.

| # | Local branch | Base → head | Scope | Files | Additions | Deletions | Changed lines |
|---|---|---|---|---:|---:|---:|---:|
| 1 | `pr/pi-rules-md-01-foundation` | `831d563` → `eeca768` | Domain types, Result, strict frontmatter parser, initial evidence docs | 10 | 1307 | 6 | **1313** |
| 2 | `pr/pi-rules-md-02-conditions` | `eeca768` → `d3114b4` | Condition predicates/combinators and declarative registry | 11 | 991 | 63 | **1054** |
| 3 | `pr/pi-rules-md-03-core-pipeline` | `d3114b4` → `67cf988` | Match, selection, rendering, evaluation trace, state reducer | 17 | 1964 | 8 | **1972** |
| 4 | `pr/pi-rules-md-04-discovery-collectors` | `67cf988` → `2357800` | Filesystem discovery/cache/trust/scan and Pi-event collectors | 5 | 979 | 3 | **982** |
| 5 | `pr/pi-rules-md-05-injection-wiring` | `2357800` → `e2c7ed5` | Injection, extension composition root, `/rules`, pipeline wiring | 9 | 1127 | 12 | **1139** |
| 6 | `pr/pi-rules-md-06-dogfood-hardening` | `e2c7ed5` → `cb18417` | Per-turn re-apply defect fix, discovery totality, global ID uniqueness, null guard, render normalization | 15 | 488 | 67 | **555** |
| 7 | `pr/pi-rules-md-07-release` | `cb18417` → `2837e30` | Seeded property/perf tests, RULE-SPEC, README, package file whitelist | 13 | 1524 | 13 | **1537** |

## Verification evidence already available

- Slice 1: T1 41/41; T2 81/81; typecheck and independent verification recorded in `odd/tasks/pi-rules-md.md`.
- Slice 2: T3 113/113; T4 154/154; independent verification recorded.
- Slice 3: T5–T9 incrementally verified through 240/240; per-work-unit native review authority burned before commits.
- Slice 4: T10 256/256; T11 278/278; independent verification recorded.
- Slice 5: T12 294/294; T13 310/310; SDK shape and runtime import audit recorded.
- Slice 6: 310/310 after the T14 persistence fix; W1 hardening 324/324; cross-source-ID correction independently verified.
- Slice 7: 343/343 tests, typecheck clean, 300×300 performance guard measured at 38.6 ms against 2000 ms, packed tarball smoke probe passed with marker `PACK-OK-5591`.
- Full evidence and native review receipts remain in `odd/tasks/pi-rules-md.md` and the existing commit history.

## PR preparation contract

For every PR description include:

- Slice number, start/end commit, and exact changed-line count.
- Dependency/stack context from the diagram above.
- `size:exception` with rationale: existing pre-reviewed work units are indivisible; one bounded cohesive split was performed; further splitting would break review receipts or separate tests/docs from behavior.
- Checks relevant to that slice and any residual follow-ups from the feature task document.

No branch was pushed and no PR was opened. The user then authorized local maintenance and merge to `main`; that was performed as a fast-forward only.

## Completion

- [x] Record the approved boundaries, budgets, and stack plan.
- [x] Create the seven local branch refs at the recorded head commits (local-only; no history rewrite).
- [x] Verify branch targets, ancestry, and exact range stats. All seven bases are ancestors of their heads; each merge-base equals its declared base; `git diff --shortstat` matches the table.
- [x] Fast-forward local `main` from `831d563` to `2837e30` using `git merge --ff-only feat/pi-rules-md`.
- [x] Preserve all seven slice refs. `main` and `feat/pi-rules-md` both resolve to `2837e30`.
- [x] No remote configured; no push or PR creation performed. Worktree contains only this untracked planning document; feature files are committed.
