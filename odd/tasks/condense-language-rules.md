# Feature: condense-language-rules

Condense the 7 converted language rules in `~/.pi/agent/rules/programming-languages/`
so every rule fits the 2000-token budget, activates only on relevant edits, and reads
as terse applicable rules rather than tutorial material. Approved with the "richer
rescript" variant: full 12-row v12 migration table + EarlyExit code pattern kept.

## Decisions

- Body standard: imperative bullets under MUST/SHOULD/AVOID headers; no preamble
  prose, no good/bad example blocks, no Conflict & Precedence section, no doc links.
  One-line parenthetical rationale only for non-obvious quirks.
- All rules get `match: touched` (activate on edit, not on file existence).
- Priorities stay at 0: post-trim worst co-activation (~460t for a .ts edit) leaves
  ample budget; revisit only if `/rules` reports `budget` drops.
- ReScript keeps full migration table, EarlyExit snippet, FFI quirks (~1000t);
  everything else aggressively trimmed.
- Edit surface is outside any git repository (~/.pi/agent/rules): no work-unit
  commit exists; verification evidence recorded here instead.
- Stale `generic.mdc` references in javascript/typescript rules → `generic` rule.

## Tasks

- [x] T1 bash.md: 576 → 200t
- [x] T2 python.md: 674 → 234t
- [x] T3 rust.md: 634 → 301t
- [x] T4 rescript.md: 3960 → 1386t (rich variant: full table + EarlyExit)
- [x] T5 typescript/generic.md: 806 → 445t
- [x] T6 typescript/javascript.md: 178 → 110t (stale ref fixed)
- [x] T7 typescript/typescript.md: 239 → 167t (stale ref fixed)
- [x] T8 Verified: all 7 parse OK via src/frontmatter.ts

## Evidence

- Verification: `node odd/scratch-verify-rules.mjs` — all 7 rules parse OK
  (real parser, source=global), match=touched, globs intact.
- Token accounting (file-based estimate; engine estimates on body only, so
  real use is slightly lower): bash 200, python 234, rust 301, rescript 1386,
  generic 445, javascript 110, typescript 167.
- Worst realistic co-activations: .ts edit → 612t; .js edit → 555t;
  .res edit → 1386t; .res+.ts session → 1998t (fits exactly).
- All-7 co-activation (~2843t) only occurs in a session touching sh+py+res+rs+js+ts
  files; tail would drop with cause `budget` (acceptable, priorities left at 0).
- Edit surface outside git (~/.pi/agent/rules) → no work-unit commit; this doc
  plus the scratch script are the durable record.
