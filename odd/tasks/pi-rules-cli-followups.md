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

## User gates (remaining)

1. F4: review/fill the upstream report draft, then file (user action; no remote here).
2. (Carried over) npm publish + dogfood switch — unchanged.

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
