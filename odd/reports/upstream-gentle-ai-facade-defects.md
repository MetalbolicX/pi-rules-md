# Upstream report draft: gentle-ai review facade defects (v3.7.0)

Status: DRAFT — user must review before filing upstream. Author: pi-rules-md maintainer session, 2026-09-30. Evidence: one extended feature session (10 review lineages total across two days; 3 parked/blocked).

## Summary

Three reproducible defects in the gentle-ai review facade (`gentle_review` tool + native CLI bridge) were hit during ordinary Pi work on an ordinary feature branch. Two are hard blockers that killed 2 of 8 work-unit reviews; the third recurs on every session but has a workaround. All reproduce on the standard path with no exotic setup: a plain Git repository, `gentle_review` operations only (no raw shell STATUS), byte-exact opaque bindings re-copied from fresh STATUS output.

## Defect 1 — consent-stale START on first attempt (workaround exists)

**Symptom**: `gentle_review` START immediately after a ready INSPECT returns `outcome: "consent-binding-stale"`, `diagnostics.code: "consent-binding-expired"`, message "consent binding ... expired after 10 minutes without an answer" — despite the binding having been minted seconds earlier in the same call chain, with no user prompt shown and no delay.

**Repro** (every session, first START):
1. `inspect` → ready, `next_transition.kind: execute review.start`.
2. `start` with fresh idempotencyKey, `input {"mode":"ordinary"}` → blocked, `consent-binding-stale`, `next_action: "restart-for-fresh-consent"`, `lineage_created: false`.
3. `start` again with a NEW idempotencyKey → succeeds immediately, lineage created, relay consent envelope delivered to the human, answered normally.

**Impact**: noisy, but recoverable via the documented retry. Side effect: the failed attempt resets any `intended-untracked` selection made at INSPECT, forcing a second INSPECT with `untrackedScope` before the retry START (observed 2026-09-30, T6 review).

**Suspected cause**: consent binding TTL check measures from a stale mint timestamp (possibly minted at INSPECT, or a clock/serialization bug), not from when the envelope is actually presented to the human.

## Defect 2 — capture-binding rejection flakiness kills lineages (hard blocker)

**Symptom**: `gentle_review_capture` / `gentle_review_capture_group` reject byte-exact opaque collect bindings copied verbatim from a fresh bound STATUS, with validation errors that then repeat on retry — sometimes deterministically (route dies), sometimes intermittently (next attempt passes with an identical binding).

**Instances**:
- 2026-09-30, T5 review (`review-d5212a36b9dda55c`, lineage `pi-rules-cli` T5 doctor+advisory, high tier): 5 consecutive rejections across BOTH the single-slot route and the group route, each after a fresh STATUS re-copy; capture after backoff; lineage never completed, remains `reviewing`. Candidate was verified separately (worker PASS evidence) and committed under the honest-fallback policy.
- Earlier T5 attempt: group capture with 4 fresh bindings rejected; one single-slot capture passed minutes later with the same content, subsequent slots rejected again.
- T1 review (`review-f09099165ae6fa35`): the lens captures succeeded but see Defect 3 for that lineage's blocker.

**Impact**: work-unit reviews become uncompletable on the mandated facade path; no recovery route exists from the facade. Forces either abandoning native review or committing without a closed review (we chose the latter with full evidence).

**Suspected cause**: binding validation state machine desyncs from STATUS (e.g., replay-detection window, or the binding's revision/subject fields being revalidated against a moved store revision between STATUS and capture).

## Defect 3 — correction-plan slots unconsumable from facade-born lineages (hard blocker, T1)

**Symptom**: after a review returns `correction_required`, the correction-plan collect binding offered by bound facade STATUS is rejected by `gentle_review_capture` (repeatedly, byte-exact re-copies), and the native CLI fallback (`gentle-ai review capture-correction-plan ...`) rejects the facade-minted `--repository-context rctx2_...` handle with an opaque-argument error — the handle is session-bound and cannot be consumed by the native binary.

**Instance**: 2026-09-30, T1 review `review-f09099165ae6fa35` (pi-rules-md, `feat/pi-rules-cli`, medium tier): correction-plan slot rejected ~4× via facade; native `capture-correction-plan` rejected the rctx2 handle; lineage parked in `correction_required` forever. The CRITICAL findings the correction plan targeted were fixed manually in the working tree (verified), but no native closure exists for that lineage.

**Impact**: any medium/high candidate that draws a correction finding can never close natively. This is the worst of the three: it silently converts every future finding-bearing review into a dead lineage.

## Repro context (common)

- Repository: plain Git repo, one branch, small diffs (76–438 changed lines per candidate).
- All lifecycle operations through the compact facade (`gentle_review`, `gentle_review_capture`, `gentle_review_capture_group`); no shell-side review CLI; opaque bindings always re-copied byte-exact from the most recent bound STATUS; new idempotencyKey per START; forecast acknowledged with `reviewerRunAcknowledged: true` before host-relay runs.
- Successful reviews under identical conditions: 4 lineages approved + acknowledged normally (including one 4-lens group capture that passed first try), so the failures are state- or attempt-dependent, not configuration-dependent.

## Requested upstream action

1. TTL bug for consent bindings (Defect 1).
2. Deterministic repro hunt for capture-binding rejection (Defect 2) — happy to provide full facade transcripts per attempt if useful.
3. Either facade-native correction-plan consumption for facade-born lineages, or a documented escape hatch that lets a session close a `correction_required` lineage natively (Defect 3).

## Lineage inventory at report time

| Lineage | Candidate | State |
| --- | --- | --- |
| review-f09099165ae6fa35 | T1 skeleton/build wiring | correction_required (parked) |
| review-d5212a36b9dda55c | T5 doctor/advisory | reviewing (parked) |
| review-04f06482178c93f1 | T2 settings/matcher | approved, burned |
| review-5bd079be260a16f2 | T3 install/uninstall/purge | approved, burned |
| review-a740aea94e62a9c6 | T4 registry/update/status | approved, burned |
| review-f4cee70500256697 | T6 packaging/README | approved, burned |
| review-ecc2ff0b7aafc3cf | F2+F3 hardening | approved, burned |
