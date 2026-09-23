# pi-rules-md

Pi extension that discovers markdown rule files and injects conditionally
matched ones into the system prompt — rules activate when the agent touches
files matching their globs, or when matching files exist in the project.

Functional core / imperative shell; pure functions and data, no classes.

## Status

Scaffold. Implementation tracked in [`odd/tasks/pi-rules-md.md`](odd/tasks/pi-rules-md.md)
(15 strict-TDD tasks). Rule format v1 and host-compatibility research are
summarized in the feature document.

## Install (local path)

```sh
pi install /home/metalbolicx/Documents/pi-rules-md
```

## Development

```sh
pnpm install
pnpm typecheck   # strict TS, no emit
pnpm test        # vitest (co-located tests, golden files, property tests)
```

## Rule directories (planned)

- Global: `~/.pi/agent/rules/`
- Project: `.pi/rules/` (loaded only when the project is trusted)
