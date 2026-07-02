# Agent Notes

## Project Shape

This package is an OpenCode plugin with separate server and TUI entrypoints:

- `src/server.ts` is the server plugin. It registers the `/loop` command, the loop tools, chat/session hooks, compaction context, and the scheduler that injects loop iterations while a session is idle.
- `src/state.ts` owns loop persistence and lifecycle state. It stores JSON at `OPENCODE_LOOP_STATE_PATH` when set, otherwise under the user's OpenCode data location. It also owns interval parsing/formatting.
- `src/tui.tsx` is the Solid/OpenTUI sidebar and command-palette UI. It is exported as source, so avoid adding heavy runtime dependencies here unless there is a strong reason.
- `src/prompts.ts` contains the `/loop` command template, the per-iteration synthetic prompt, the loop system reminder, and the compaction context.
- `test/` covers state, server hooks/tools/scheduler, and TUI helpers with Bun tests. Scheduler tests use 1-second intervals via the `min_interval_seconds` option.

## Scheduler Invariants

- Iterations are only injected while the session is idle; busy sessions defer with `min(intervalMs, busy_backoff_seconds)`.
- `sendingLoops` guards against concurrent iterations of the same loop; after a successful injection the session is optimistically marked busy so sibling loops defer.
- Dynamic loops live one iteration at a time: `dynamicPending` entries settle on idle, and a dynamic loop whose turn ended without `schedule_next_run` or `stop_loop` is stopped. `sawBusy` must start `false` for injected iterations (only the creating turn starts `true`) so a stale idle event cannot settle a just-injected loop.
- `runDue` must never throw: it runs from `setTimeout` callbacks, so errors are caught and logged.
- Timers are per-loop, always re-armed from persisted `nextRunAt`, and cancelled on stop/pause/dispose.

## Change Guidelines

- Preserve the public Promise-based state API (`createLoop`, `listLoops`, `stopLoop`, `recordRunSent`, etc.) because OpenCode hooks and tests call it directly.
- Keep `zod` pinned to the exact version `@opencode-ai/plugin` depends on; tool argument schemas fail typechecking across zod minor versions.
- Effect is intentionally used in the state/persistence boundary. Do not spread Effect into the TUI.
- State writes should remain atomic: write to a temp file, then `rename` into place.
- Use `OPENCODE_LOOP_STATE_PATH` for tests and smoke runs so you do not touch a real user's loop state.
- All loop tools return `{ ..., loops }` for the session; the TUI sidebar parses that shape from tool outputs, so keep it stable.

## Local Validation

Before treating a code change as complete, run the relevant checks. For release-level changes, run the full local gate:

```bash
bun run lint
bun run typecheck
bun test
bun run build
bun run pack:dry-run
```

`bun run build` writes `dist/server.js`. The package only publishes `dist`, `src/tui.tsx`, `LICENSE`, and `README.md`, so confirm `npm pack --dry-run` includes what runtime installation needs.

## Publishing Flow

This repo publishes from GitHub Actions on pushes to `main`. The workflow computes the next patch version from npm, builds, publishes, and creates a GitHub release.

After pushing a release change, monitor the workflow with `gh run list --branch main` and `gh run watch <run-id> --exit-status`. Verify the release and package metadata after success:

```bash
npm view @prevalentware/opencode-loop-plugin version dependencies
gh release view v<version>
```

## End-To-End Plugin Test

To test this plugin end to end, do not stop at unit tests. Run the local gates first, then install the published version in an isolated temp OpenCode project with `opencode plugin @prevalentware/opencode-loop-plugin@<version>`, run `opencode debug config` to confirm the package is loaded and the `loop` command is registered, then run a smoke test with an isolated state file, for example:

```bash
OPENCODE_LOOP_STATE_PATH="/tmp/opencode-loop-plugin-smoke/loops.json" opencode run "/loop 1m say exactly 'tick' and stop this loop after confirming it exists"
```

The smoke test should show `create_loop` (and possibly `stop_loop`) tool calls. Inspect the state file afterward to confirm JSON persistence, and clean up with `/loop stop <id>` or by deleting the smoke state file.
