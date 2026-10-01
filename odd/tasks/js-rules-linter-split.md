# Feature: js-rules-linter-split

Strip the oxlint-enforced (deterministic) lines from the global JS/TS rules in
`~/.pi/agent/rules/programming-languages/typescript/` so the markdown rules
carry only non-lintable direction. Rationale: the user starts projects from a
template generator that ships the `.oxlintrc.json`, so the linter config
travels with new repos and the prompt does not need to restate enforced rules.
Approved plan: pointer-line strategy; non-goals: other language rules,
pinned→on-demand flips, generating configs for other repos.

## Decisions

- A line survives only if it (a) is not oxlint-enforceable, or (b) guides
  judgment the linter cannot see. Enforced items collapse into one pointer
  line telling the agent to run the repo's lint task.
- Body standard unchanged from `condense-language-rules`: imperative bullets
  under MUST/SHOULD(/AVOID) headers; no preamble prose; one-line parenthetical
  rationale for non-obvious quirks.
- Frontmatter byte-identical in all three files (globs, `match: touched`,
  `load: on-demand` for generic).
- Editorially kept despite partial lint coverage: `.mjs`/`.mts` preference and
  double-quotes/semicolons clause (formatter, not linter), `Iterator.from()`
  in the iteration bullet, and one security line on unsanitized `innerHTML`.
- Edit surface is outside any git repository (`~/.pi/agent/rules`): no
  work-unit commit exists; verification evidence recorded here instead
  (same model as `condense-language-rules`).

## Tasks

- [x] T1 typescript.md: drop no-any / as-const / @ts-expect-error lines; keep strict, satisfies, discriminated unions; lint note under Validation
- [x] T2 javascript.md: drop `"use strict"` line; keep JSDoc MUST + follow-generic
- [x] T3 generic.md: drop ~14 enforced bullets; keep pnpm, web-first, ESM+`.mjs`, formatter clause, iteration rules (gap), AbortController/replaceSync, innerHTML security line, pointer line
- [x] T4 Verified: parse OK via repo parser; token estimates recorded; globs/match/load intact
- [x] T5 Record evidence in this document

## Evidence

- Delegation fallback (reported): `gentle-ai-worker` rejected the task twice —
  its contract requires repository-relative edit surfaces, and
  `~/.pi/agent/rules/` is outside any git repository. Parent edited inline
  from the exact approved copy (same fallback as `condense-language-rules`).
- Verification: `node odd/scratch-verify-rules.mjs` — all 7 rules parse OK
  (real repo parser, source=global); the 3 edited files keep `match=touched`,
  globs (8/4/4), and `load: on-demand` on generic intact. The 4 untouched
  language rules parse unchanged.
- Token deltas (full-file estimate `ceil(chars/4)`, frontmatter included —
  the same basis as the condense feature's script):
  - typescript/generic.md: 445t → **305t** (−31%, on-demand body)
  - typescript/javascript.md: 110t → **86t** (−22%, pinned)
  - typescript/typescript.md: 167t → **169t** (+2t, pinned)
  - JS/TS set: 722t → **560t** (−22%)
  - Worst `.ts` co-activation (file-estimate basis): 612t → **474t** (−23%)
- Honest note: typescript.md nets +2t — the Validation pointer line (~36t)
  slightly outweighs the 3 dropped lines (~34t). Accepted deliberately: the
  pointer is the safety net telling the agent to run the repo linter instead
  of restating enforced rules. Plan-stage estimates (~150t pinned) ignored
  fixed frontmatter cost (~60–70t per file: description + globs lists), which
  is activation contract and cannot shrink.
- What survived and why: pnpm, web-standard-first, ESM+`.mjs`, formatter
  clause (quotes/semi are formatter territory), iteration rules (oxlint has
  no for-loop/array-building rule — the main gap), `Iterator.from()`,
  `fetch`+`AbortController`, `CSSStyleSheet.replaceSync()`, unsanitized
  `innerHTML` MUST (security), functional-over-OOP, `satisfies`,
  discriminated unions, strict-tsconfig, JSDoc-on-public-functions (JS).
