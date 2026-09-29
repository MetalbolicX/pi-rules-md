# Feature: oxlint-deterministic-rules

Encode the deterministic subset of the global JS/TS rules
(`~/.pi/agent/rules/programming-languages/typescript/{generic,javascript,typescript}.md`)
into an `.oxlintrc.json` for this repo, so the linter applies the mechanical part
and review attention goes to the non-deterministic remainder.

## Decisions

- Mapping was verified against the oxlint 1.86.0 configuration schema
  (871 rules, 14 plugins) — not from memory. Full mapping table lives in the
  session conversation; summary of coverage below.
- Explicit rule list, no blanket category enablement: the config mirrors the
  markdown rules 1:1 instead of importing hundreds of unmapped pedantic rules.
- Plugins enabled: `typescript`, `oxc`, `unicorn`, `import`, `promise`, `jsdoc`.
- Formatting rules (`quotes`, `semi`) are gone from oxlint 1.x → formatter
  territory (oxfmt/Prettier), explicitly out of scope here.
- `import/no-nodejs-modules` NOT enabled: "web-standard APIs first" is a
  browser-context rule; this repo is a Node extension.
- `unicorn/filename-case` limited to kebab-case + camelCase (no dotCase in
  schema) with an override disabling it for dot-separated test files
  (`**/*.test.ts`, `**/*.spec.ts`, vitest config, golden dirs).
- Type-aware-only rules (`typescript/prefer-nullish-coalescing`,
  `typescript/no-unnecessary-condition`, `typescript/only-throw-error`)
  require `oxlint --type-aware` (experimental) — NOT included in the default
  config; documented here so a future opt-in knows where they land.
- JSDoc completeness rules (`jsdoc/require-param*`, `require-returns*`)
  scoped to `**/*.{js,mjs,cjs}` overrides — they are the deterministic part of
  javascript.md, and this is a TS repo where they would only be noise.
- `no-restricted-properties` bans `.innerHTML` access (property-only entry,
  schema-verified); escape hatch is a targeted `oxlint-disable` comment.
- oxlint added as devDependency; `pnpm lint` script wired.
- No work-unit commit without explicit user ask (safety rule) — offer at close.

## Tasks

- [x] T1 Add `oxlint` devDependency and `lint` script to package.json
- [x] T2 Write `.oxlintrc.json` with the verified rule mapping
- [x] T3 Run `pnpm lint`; triage findings (fix real violations vs tune over-firing rules)
- [x] T4 Confirm `pnpm typecheck` + `pnpm test` still pass
- [x] T5 Record evidence in this document

## Coverage summary (oxlint 1.86.0)

Full ✅: no-var, prefer-const, prefer-template, no-useless-concat,
logical-assignment-operators, prefer-destructuring, prefer-object-spread,
arrow-body-style (as-needed), prefer-arrow-callback, prefer-rest-params,
prefer-spread, guard-for-in, no-throw-literal, prefer-promise-reject-errors,
prefer-object-has-own, typescript/no-explicit-any, typescript/prefer-as-const,
typescript/ban-ts-comment (allow-with-description), typescript/no-require-imports,
typescript/prefer-optional-chain, import/no-commonjs, import/no-amd,
unicorn/prefer-at, unicorn/prefer-spread, unicorn/prefer-negative-index,
unicorn/prefer-default-parameters, unicorn/prefer-object-from-entries,
unicorn/prefer-node-protocol, unicorn/prefer-import-meta-properties,
unicorn/prefer-dom-node-text-content, unicorn/prefer-top-level-await,
unicorn/error-message, unicorn/throw-new-error, promise/prefer-await-to-then,
promise/prefer-await-to-callbacks, no-restricted-properties (innerHTML).

Partial ⚠️: unicorn/filename-case (no dotCase → test-file override),
unicorn/prefer-module (ESM migration only), jsdoc require-* (completeness of
existing blocks, JS files only).

Out of scope ❌ (formatter/tsc/process/design): quotes, semi, tsconfig strict,
satisfies preference, discriminated unions, classic-for-over-array building
(`unicorn/no-for-loop` and `no-restricted-syntax` absent from oxlint),
pnpm-only (`only-allow` package is the right guard), AbortController /
CSSStyleSheet.replaceSync / web-API preference.

## Evidence

- oxlint installed as devDependency: `oxlint ^1.85.0` (latest pnpm resolved).
- Two config-format corrections during bring-up (runtime is authoritative over
  schema docs): `env` is a map (`{"es2024": true}`), and `unicorn/filename-case`
  case keys are camelCase (`kebabCase`), not schema-enum style (`kebab-case`).
- First real run found 10 findings; all fixed, none suppressed:
  - `shell/collectors.ts`: `args: any` → `unknown` (MUST no-any; mapper already
    guards as untrusted; comment updated).
  - `shell/pipeline.ts`: unused `MatchReason` import removed; `trace.block`
    destructured.
  - `shell/pipeline.test.ts`: unused `EvaluationTrace` import removed;
    string concatenation → template literal.
  - `src/conditions/table.test.ts`: unused loop binding → hole destructure.
  - `src/match.ts`: `rule.globs` destructured; regex `[*?]` unescaped.
  - `src/frontmatter.ts`: `frontmatter["description"]` destructured.
- Final state: `pnpm lint` exit 0 (zero findings), `pnpm typecheck` exit 0,
  `pnpm test` 367/367 across 25 files.
- No work-unit commit: user has not asked for one (safety rule); changeset is
  staged-ready: `.oxlintrc.json`, `package.json`, `pnpm-lock.yaml`, plus the 6
  fixed source/test files and this doc.
