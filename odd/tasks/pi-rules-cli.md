# Feature: pi-rules-cli

Port the pi-skills CLI pattern (repo: pi-agent-skills, published as `pi-skills`) to this repo: a `pi-rules` bin that installs/uninstalls/updates/status-checks/doctors the pi-rules-md Pi extension, enabling npm distribution (`npx pi-rules-md install`).

Status: PLANNED (tasks below, strict TDD). Base: `main` @ 2f87000. Branch: `feat/pi-rules-cli` (existing `feat/oxlint-deterministic-rules` is unrelated — do not touch).

## Objective and scope

In scope: `src/cli/*` modules + colocated vitest tests, rolldown 2-bundle build, `bin` wiring, packaging (`files`, `engines`, `prepublishOnly`), README CLI/install docs, npm publish prep.
Out of scope: extension behavior changes (index.ts/src/shell beyond build wiring), rule-engine changes, git remote setup, registry automation.

## Locked decisions (ported + adapted)

1. **Wrap the `pi` CLI — never write `~/.pi/agent/settings.json`.** All mutations via `pi install` / `pi remove` / `pi update` child processes (`shell:false`). Read-only settings parsing is allowed.
2. **Subcommands**: `install`, `uninstall`, `update`, `status`, `doctor`. Arg parsing exclusively `node:util parseArgs` (strict, `allowPositionals:false`).
3. **Names**: package `pi-rules-md`, bin `pi-rules` → `dist/cli.mjs` (shebang via rolldown banner), `PACKAGE_NAME = "pi-rules-md"`, prefix `[pi-rules]`, registry URL `https://registry.npmjs.org/pi-rules-md/latest`.
4. **Env vars**: `PI_RULES_AGENT_DIR` (agent-dir override), `PI_RULES_DEBUG`, test-record `PI_RULES_TEST_RECORD`.
5. **Runtime sandbox interlock (hardening over source repo)**: mutation flows (`install`/`uninstall`/`update`/purge) refuse with exit 3 when running under a test runtime (`VITEST`/`NODE_ENV=test`) and no explicit `--agent-dir`/`PI_RULES_AGENT_DIR` sandbox is set. Rationale: pi-skills' interlock was test-side only (verified in source); its incident (real settings mutated by a test) must be structurally impossible here. Fail-closed.
6. **Dedupe-first install**: remove existing matching entries (npm:, git:, local-path) in settings order before `pi install npm:pi-rules-md[@version] [--local]`; abort on first removal failure. Local-path identity = target `package.json#name === "pi-rules-md"` + realpath canonicalization; the live entry `../../Documents/pi-rules-md` is a first-class case.
7. **No install read-back** (pi exit code is trusted, parity with source); verification lives in `status`/`doctor` (store `package.json` version + dist files). Documented, deliberate.
8. **Uninstall**: continue after per-entry failures (exit 1 if any failed); zero matches → `✓ Not installed`; `--purge` guarded (realpath strictly nested under `<agentDir>/npm/node_modules`, basename === `pi-rules-md`, else refuse).
9. **Update**: unpinned npm entries → `pi update npm:pi-rules-md [--local]`; pinned → hint, never updated; local-path entries → "tracks the working tree". Dedupe key `scope:identity`.
10. **Registry probe**: injectable `fetch`, `AbortSignal.timeout(3000)` + `Promise.race` (body read inside race this time — fixes source advisory R2), fail-soft to `null`, `VERSION_PATTERN` semver gate, staleness fail-closed to "not stale".
11. **Doctor**: per-scope settings health, duplicates, `dist/extension.js` + `dist/cli.mjs` presence (store + local), node `>=22.19.0`, registry latest + pin advice; exit 1 iff structural issues.
12. **Build**: rolldown (new devDep), 2 bundles — `src/../index.ts` → `dist/extension.js` (ESM, externals `node:*` only, inline picomatch/tinyglobby/yaml/typebox; no runtime pi import exists — structural mirrors), `src/cli/main.ts` → `dist/cli.mjs` (externals `node:*`, banner `#!/usr/bin/env node`, no minify). Add `engines.node >=22.19.0`, `prepublishOnly: "pnpm typecheck && pnpm lint && pnpm test && pnpm build"`.
13. **Manifest switch**: `"pi": {"extensions": ["./dist/extension.js"]}` (built artifact, pi-skills-proven). Consequence: local-path installs need `pnpm build` first; dev flow keeps `pi --extension ./index.ts`. `files` = current + `dist`.
14. **Dual-mode deps**: keep the 4 runtime `dependencies` (used by source/dev mode); npm mode loads the self-contained dist. Never move them to satisfy bundling.

## Port deltas honored (from mapping)

- Runner: vitest (`expect`, globals on), tests under `src/cli/*.test.ts`, include already covers `src/**`. All ported tests translated from node:test.
- Build tool absent today → T1 introduces rolldown + `build` script.
- Test harness: per-test fake `pi` via temp `bin/pi` on scrubbed `PATH` (record file + exit env), temp cwd with fake `.git`/`.pi/settings.json`, `PI_RULES_AGENT_DIR` sandbox, restore in `finally`; interlock test (decision 5) is the FIRST red test of T3.
- Working tree cleanliness must be verified before branching (mapping could not run git status).
- Delivery: local-only commits (no remotes); npm publish does not require a remote.

## Workflow

- ODD. **Strict TDD (user-mandated override)**: every task starts red — write the failing tests for the pinned contract, run the scoped suite and observe failure, then implement minimal green, then refactor. No implementation before red. Evidence (red output + green gates) recorded in this ledger.
- Delegation: mapping done (gentle-ai-explore). Writers → `gentle-ai-worker` with `## Allowed edit surfaces` bounded to `src/cli/**` (+ exact extras per task); verification → `gentle-ai-verify`; parent reviews readback, runs native review (RDD on), and commits.
- Gates every task: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && git diff --check`.
- Commits: Conventional Commit work units on `feat/pi-rules-cli`; identity recorded here. Push/PR/publish are user decisions.

## Tasks

- [x] **T0 — Preflight.** Verified: tree clean (untracked only: `.codegraph/`, ledgers `js-rules-linter-split.md` + `pi-rules-cli.md`), `main` @ 2f87000, branch `feat/pi-rules-cli` created off it. No code. Rollback: delete branch.
- [x] **T1 — CLI skeleton + pi-runner + build wiring.** RED: `main.test.ts` (unknown subcommand → exit 2 + usage; `--help` → 0; no args → usage; `PI_RULES_AGENT_DIR` threading), `pi-runner.test.ts` (fake-`pi` argv record via `PI_RULES_TEST_RECORD`, exit propagation, ENOENT → exit 1 `pi CLI not found on PATH`, 30s timeout SIGKILL, `--dry-run` prints and never spawns, capture mode). GREEN: `src/cli/{main,pi-runner,constants,debug}.ts` + `rolldown.config.js` + `package.json` wiring (bin, build, prepublishOnly, engines). Gate extra: built `dist/cli.mjs` executable + shebang smoke (`node dist/cli.mjs --help`). Commit: `feat(cli): cli skeleton, pi runner and build wiring`.
- [x] **T2 — Paths + settings reader + entry matcher.** RED: `paths.test.ts` (explicit → env → `~/.pi/agent`; store path `<agentDir>/npm/node_modules/pi-rules-md`), `settings.test.ts` (missing file / no packages key / malformed JSON / string|object|malformed entries / never writes), `match.test.ts` (npm exact + pinned + no-match, git basename, local relative `../../Documents/pi-rules-md` resolved against settings dir with `package.json#name` identity, `~` expansion, unrelated dirs, duplicates). GREEN: `src/cli/{paths,settings,match}.ts`. Commit: `feat(cli): settings reader and package matcher`.
- [x] **T3 — install/uninstall/purge + runtime interlock.** RED (order matters): (1) interlock test per decision 5; (2) `install.test.ts` (dedupe-first argv order, abort-on-first-failure, `--local`, success message + doctor tip, settings-error → skip dedupe); (3) `uninstall.test.ts` (multi-entry continue-after-failure, zero-match, unmatched-local warning, purge guard refusal, `--purge` after removals, project-scope no-purge). GREEN: `src/cli/{install,uninstall}.ts`. Commit: `feat(cli): install uninstall and purge with sandbox interlock`.
- [x] **T4 — registry + update + status.** RED: `registry.test.ts` (injectable fetch, timeout incl. body read, non-OK/malformed → null, pattern gate, semver compare, fail-closed), `update.test.ts` (local → tracks-working-tree, pinned → hint, unpinned → `pi update` dispatch, dedupe key), `status.test.ts` (store version read-back, local version, latest + stale lines, both scopes). GREEN: `src/cli/{registry,update,status}.ts`. Commit: `feat(cli): registry probe, update and status`.
- [x] **T5 — doctor.** RED: `doctor.test.ts` (per-scope health, duplicate detection, dist presence store+local, node engine, registry advice, `summary: healthy` vs `N structural issues`, exit 1 iff structural). GREEN: `src/cli/doctor.ts`. Commit: `feat(cli): doctor and advisory pipeline`.
- [ ] **T6 — Packaging contract + README + publish prep.** RED: `packaging.test.ts` (contract: `bin.pi-rules === dist/cli.mjs`, files include dist + current set, engines, prepublishOnly chain, manifest points at `./dist/extension.js`). GREEN: apply `package.json`/README changes (`## Install`: `npx pi-rules-md install`, subcommand table, local dev `pi --extension ./index.ts`, local-path note "build first"). Gate extra: `npm pack --dry-run` file list review. Commit: `docs(cli): packaging contract, readme install and cli guide`.

## User gates (explicit authorization required)

1. `npm publish` (version 0.1.0, first publish) — after T6.
2. Dogfood switch: `pi-rules uninstall` (removes `../../Documents/pi-rules-md`) → `npx pi-rules-md install` → `doctor` + `pi list` verification → `/reload` live sessions.
3. Any push/remote setup (out of scope for now).

## Evidence log

### T1 (in flight — review blocker)
- Worker (strict TDD): RED = both suites import-fail (modules absent); GREEN scoped 10/10; full suite 377/377 (27 files); typecheck/lint PASS.
- Parent gates: build PASS (extension.js 392.41 kB / cli.mjs 2.59 kB), `node dist/cli.mjs --help` exit 0, shebang verified, dist/ gitignored, lockfile delta = rolldown only (+4 lines).
- Independent verifier: 5/5 PASS (real behavioral tests, contract conformance, build wiring, safety). Non-blocking: dist/cli.mjs exec bit applied by npm bin-links on install (working-tree file rw-rw-r--); ledger wording amended here.
- Native review lineage `review-f09099165ae6fa35` (tier high, 332 lines, budget 166): 4/4 lenses admitted (risk+resilience via single capture; readability+reliability via capture_group after intermittent single-slot rejections — provider bug, Engram topic rdd/correction-plan-route-blocked).
- Findings: R3-001 + R4-001 CRITICAL (deterministic, introduced): default `notImplemented` flows throw unhandled → advertised commands crash. CORRECTED in working tree: `NotImplementedFlowError` + graceful dispatch (exit 2 + actionable stderr), red test first, 12/12 scoped, 379 total, gates green, live smoke `pi-rules status` → exit 2 + message.
- BLOCKED: correction-plan submission (43 diff lines) rejected 3x via facade capture and 3x via native CLI (rctx2 facade-session-bound). Authority store valid; lineage state correction_required. User decision pending (retry / honest-fallback commit + fresh review on next candidate / native reroute / stop).
### T5 (closed — honest fallback)
- Worker (strict TDD): RED (module-load) → GREEN 14/14 doctor + 20/20 with status; full 461/461; gates green; --help smoke 0.
- Verifier: 7/7 PASS + LIVE doctor run against real env (detected local install ../../Documents/pi-rules-md v0.1.0, healthy, exit 0; registry unreachable → advisory only).
- Review lineage `review-d5212a36b9dda55c` (medium, 1 lens, 275 lines): capture route BLOCKED — 5 rejections across single+group routes after backoff (provider facade bug, same class as T1 correction slot). Honest-fallback close per user-approved policy; parked lineage in reviewing state.
- COMMITTED: `9fa8631` (4 files, +271/-4).

### T4 (closed)
- Worker (strict TDD): RED per suite (registry/update/status) → GREEN 33/33 scoped; full 446/446; gates green. One parent-approved surface expansion: main.test.ts repair (injected NotImplementedFlowError instead of placeholder dependence).
- Verifier: 6/6 PASS except one REAL defect — 5 update tests leaked to the live registry (no fetchImpl). Parent fixed inline: offlineFetch throwing stub defaulted in the fixture (deterministic, no 3s hangs); scoped 79/79 in 3.5s. Non-blocking gap noted: status fetch→null path untested.
- Native review lineage `review-a740aea94e62a9c6` (high, 4 lenses, 501 lines): APPROVED via single 4-lens group capture + authority burned BEFORE commit. 2 WARNING advisories (registry.ts:47, update.ts:34-35 — informational).
- COMMITTED: `9d18ddd` (8 files, +495/-6).

### T3 (closed)
- Worker (strict TDD, staged red): RED-1 interlock (missing module + exit-3 assertions), RED-2 install, RED-3 uninstall → GREEN 32/32 scoped; full 413/413; gates green.
- Independent verifier: 7/7 PASS. Non-blocking notes: `--agent-dir ""` edge passes interlock (explicit value; invariant holds); nonexistent-store/basename purge branches defense-in-depth without dedicated tests.
- Native review lineage `review-5bd079be260a16f2` (medium, 1 lens, 441 lines): APPROVED + authority burned BEFORE commit. 2 WARNING advisories (interlock.ts:2, uninstall.ts:22-24 — informational, later work).
- COMMITTED: `e2920a7` (9 files, +438/-3).

### T2 (closed)
- Worker (strict TDD): RED = import-fail on missing modules; GREEN scoped 26/26 (5 files); full suite 393/393; gates green.
- Independent verifier: 6/6 PASS (behavioral tests, contract conformance incl. live-entry classification, safety/write-scan, T3-consumable signatures). Non-blocking gap: no negative test for invalid semver pin (`npm:pi-rules-md@abc` → no match) — fold into T3 test additions.
- Native review lineage `review-04f06482178c93f1` (medium, 1 lens, 398 lines): APPROVED + authority burned BEFORE commit. 1 WARNING advisory R3-001 (match.ts:75, informational). Provider bugs worked around: consent-stale on first START (retry-once remedy), one transcription-corrupted binding rejected (lesson: byte-exact relay).
- COMMITTED: `b01767c` (6 files, +398).

## Open items

- LICENSE file presence unverified (affects `files`/publish) — check in T6.
- `uninstall --purge` project-scope edge (personal-store purge with zero project matches) — port as-is; add covering test (source repo lacked one).
