# Contributing to OpenCode Loop Plugin

Thanks for your interest in improving `@prevalentware/opencode-loop-plugin`. This guide explains how to set up the project, make changes, and get them merged.

## Prerequisites

- [Bun](https://bun.sh) (the project is built, tested, and bundled with Bun)
- An [OpenCode](https://opencode.ai) install if you want to try the plugin end to end

## Getting started

```bash
git clone https://github.com/prevalentWare/opencode-loop-plugin.git
cd opencode-loop-plugin
bun install
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `bun test` | Run the unit test suite |
| `bun test --coverage` | Run tests with a coverage report |
| `bun run lint` | ESLint over the repo |
| `bun run typecheck` | TypeScript `--noEmit` check |
| `bun run build` | Bundle `src/server.ts` into `dist/` |
| `bun run pack:dry-run` | Inspect the npm package contents |

## Project layout

- `src/server.ts` — OpenCode server hooks, loop tools, and the scheduler that injects iterations while a session is idle.
- `src/state.ts` — persistent loop state, interval parsing, lifecycle transitions.
- `src/prompts.ts` — the `/loop` command template, iteration prompt, system reminder, and compaction context.
- `src/tui.tsx` — terminal UI loop sidebar and command palette entry.
- `test/` — Bun test suites mirroring the source modules.
- `CONTEXT.md` — shared domain vocabulary for loop-mode behavior.

## Making changes

1. Create a topic branch from `main`.
2. Make your change, keeping the existing code style (no semicolons, 130-column lines, strict TypeScript).
3. Add or update tests — behavior changes need regression coverage. Scheduler tests use 1-second intervals through the `min_interval_seconds` option.
4. Run the local gates: `bun test && bun run lint && bun run typecheck && bun run build`.
5. Commit the rebuilt `dist/server.js` when `src/server.ts` (or its imports) changed — the built file is tracked on purpose.
6. Open a pull request against `main` describing the problem, the approach, and how you verified it. Link the related issue (`Closes #NN`) when one exists.

## CI and releases

- Every pull request runs typecheck, lint, tests with coverage, and a build via GitHub Actions. All checks must pass before merge.
- Every push to `main` re-runs the gates and, if green, automatically publishes a patch release to npm and creates a GitHub release. Merging a PR ships it — please keep `main` releasable.

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/prevalentWare/opencode-loop-plugin/issues/new/choose). Include your OpenCode version, plugin version, install method, and reproduction steps for bugs.

For security issues, do not open a public issue — see [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
