# Feature: pi-rules-cli follow-ups (deferred issues remediation)

Status: COMPLETE (F1-F5) — pending user gates (F4 filing, publish, dogfood). Base: `feat/pi-rules-cli` @ 30f2c8a; final @ 12e5772.

## Objective and scope

Fix or disposition every deferred item from the pi-rules-cli feature: allowBuilds scaffold, 5 parked review advisories, untested purge branch, upstream facade defect report, parked lineage cleanup. No new features; behavior changes only where a deferred finding demands one (F3 semantics).

## Tasks

- [x] **F1 — allowBuilds scaffold fix (chore).** pnpm-workspace.yaml: explicit `false` for `@google/genai`, `esbuild`, `protobufjs` (pi-agent-skills parity). Commit `6aeba9a`. Evidence: `pnpm install` Done 76ms, lockfile unchanged, gates green.
- [x] **F2+F3 — advisory hardening + purge semantics (strict TDD, one worker pass).**
  Commit `7d398b3` (fix(cli): close parked review advisories). Worker RED observed for all 3 behavior changes; 8 new tests; verifier 6/6 PASS incl. runtime probes (blank-dir exit 2, valid status exit 0). Native review `review-ecc2ff0b7aafc3cf` APPROVED (4/4 lenses, high tier, 137 lines) + burned; 1 new informational advisory R2-001 doctor.ts:16 (readability) parked.
- [x] **F4 — Upstream facade defect report draft.** `odd/reports/upstream-gentle-ai-facade-defects.md`, commit `12e5772`. USER GATE: review draft before filing upstream.
- [x] **F5 — Parked lineage cleanup.** Native `inspect-authority`: store valid, 2 compact entries (the 6 completed lineages consumed). `review-f09099165ae6fa35` (T1) now reports **unrelated** (inert, action=start); `review-d5212a36b9dda55c` (T5) still current_target/reviewing. USER DECISION 2026-09-30: LEAVE both (upstream-report evidence; no runtime impact).
- [x] **F0/Close — books.** This ledger + Engram mirror 7188 updated.

## Workflow

ODD. F2+F3 delegated to one gentle-ai-worker pass (same area, bounded surfaces `src/cli/main.ts`, `src/cli/install.ts`, `src/cli/uninstall.ts`, `src/cli/update.ts`, `src/cli/status.ts`, `src/cli/doctor.ts` + colocated tests; registry.ts/match.ts read-only unless a disposition demands a comment). Strict TDD for every behavior change. Independent verification per work unit; native review before each code commit (fresh lineage; honest-fallback policy only if the facade bug blocks again). F1/F4 parent-inline. All commits on `feat/pi-rules-cli`.

## User gates executed (2026-09-30)

- Gate 4 merge: `feat/pi-rules-cli` ff-merged into `main` @ `dce45ea` (+2345/−6, 37 files).
- Gate 1 publish: name was placeholder-claimed by the user (`0.0.0-stage`, 333 B); real **pi-rules-md@0.1.0 published** from user's terminal (agent session had stale ~/.npmrc stub token, E401). Verified live: 72 files / 787 kB, bin wired, `latest` = 0.1.0.
- Gate 2 dogfood switch: `pi-rules uninstall` removed local-path entry (`../../Documents/pi-rules-md`, exit 0) → `npx --yes pi-rules-md@0.1.0 install` from ~ installed npm:pi-rules-md via pi (added 5 packages = extension + 4 runtime deps, exit 0) → `doctor`: `personal: npm:pi-rules-md (npm, installed 0.1.0)`, `latest: 0.1.0`, `summary: healthy`. User `/reload`s live sessions.
- Observation: pi's own node_modules reports 1 moderate audit finding (pre-existing, agent-dir tree, not this package).


## Results

- Dispositions (F2c/F2d): registry.ts:47 no defect (null propagation tested); update.ts:34-35 no defect (scope-skip policies tested); match.ts:75 no defect (invalid-pin negative test covers it).
- New informational advisory: R2-001 doctor.ts:16 readability (from review-ecc2ff0b7aafc3cf) — parked as later work.
- Final tests: 470/470 (38 files).
- Deferred from this batch: upstream filing, publish, dogfood, R2-001.

## Workflow (historical)

ODD. F2+F3 delegated to one gentle-ai-worker pass (bounded surfaces src/cli/{main,install,uninstall,status,update,doctor}.ts + tests). Strict TDD for every behavior change. Independent verification per work unit; native review before the code commit. F1/F4 parent-inline. Commits: 6aeba9a (F1), 7d398b3 (F2+F3), 12e5772 (F4) on `feat/pi-rules-cli`.

## Open questions (resolved by default unless overridden)

- F3 semantics default: absent store = clean no-op (doctor-aligned), existing-but-unsafe = refusal. APPLIED.
- F2 empty `--agent-dir`: usage error exit 2 (strict input validation), not silent default. APPLIED.

## Retro reviews (2026-10-20)

User request: "lets first execute the missing reviews". Every commit whose native review never ran or never closed was reviewed as a committed range (commit vs. parent); older commits ran in temporary detached worktrees, since removed. All four APPROVED and acknowledged (authority burned); no correction opened. b3d8b54 (T2 frontmatter) excluded: already reviewed and burned per 16e576d.

| Commit(s) | Lineage | Tier / lenses | Advisories (all informational) |
|---|---|---|---|
| 848daf4 typebox peerDependency | review-0a56a7b514d6df12 | medium, risk+reliability | 1 WARNING: R3-bundle-external-untested packaging.test.ts:41-43 |
| d98ef34 doctor (CLI T5; supersedes parked review-d5212a36b9dda55c) | review-33717cde71bd8ff6 | medium, resilience+readability+reliability | 2 WARNING (R3-001 doctor.ts:68-71, R3-002 doctor.test.ts:55), 6 SUGGESTION |
| ce06270 CLI skeleton (CLI T1; supersedes parked review-f09099165ae6fa35) | review-c3fef03d7e5fa40c | high, 4 lenses | 8 WARNING (R1-proto-chain-guard + R3-proto-command-membership main.ts:64-67, R2-dead-debug-facility debug.ts, R2-stdout-name-collision pi-runner.ts:21-25, R3-published-bin-target package.json:13-15, R4-buffered-output-loss main.ts:111-114, R4-dryrun-silent-success pi-runner.ts:22-25, R4-timeout-close-unbounded pi-runner.ts:44-59), 6 SUGGESTION |
| de5040b+2fcf4d2 empty globs + conditions (original T3) | review-debb5a9513d8f0eb | medium, risk+readability+reliability | 4 SUGGESTION (empty-string globs, glob double-bang, picomatch interop, combinators unconsumed) |

Confirmed live on main @ 848daf4 (dist 0.1.1): `pi-rules constructor|toString|hasOwnProperty` crashes with a Node stack trace, exit 1, instead of usage + exit 2 (`command in defaultFlows`, src/cli/main.ts:68, matches Object.prototype keys). Also still true: src/cli/debug.ts is imported nowhere; CLI output is buffered and printed only after runCli returns, so an unexpected throw loses it.

Fix (same day, user-authorized): `Object.hasOwn(defaultFlows, command)` replaces `in`; RED 4/4 (constructor, toString, hasOwnProperty, __proto__) → GREEN; 474/474 tests, typecheck and oxlint clean. Differential vs. 0.1.1 dist: only the inherited names change (exit 1 + stack → exit 2 + usage); bogus, --help, no-args, empty --agent-dir and unknown-flag output byte-identical. Native assess: medium, reviewDue false (under budget). Dead debug.ts and buffered-output loss remain follow-ups.
