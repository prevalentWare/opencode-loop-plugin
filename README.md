# OpenCode Loop Plugin

[![npm version](https://img.shields.io/npm/v/@prevalentware/opencode-loop-plugin.svg)](https://www.npmjs.com/package/@prevalentware/opencode-loop-plugin)
[![GitHub repository](https://img.shields.io/badge/GitHub-prevalentWare%2Fopencode--loop--plugin-blue?logo=github)](https://github.com/prevalentWare/opencode-loop-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenCode Loop Plugin adds Claude Code-style `/loop` recurring prompts to OpenCode. It gives AI coding agents a `/loop` slash command backed by a persistent scheduler that re-injects an instruction into the session on an interval — or at agent-chosen delays — but only while the session is idle. Use it to babysit CI, watch a deploy, poll PR reviews, triage new issues, or keep any external state under watch without driving every check yourself.

`/loop` is the complement to goal mode ([`@prevalentware/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin)): a goal defines when a task is *done*; a loop defines when to *wake the agent up again* to look at something that changes over time.

The OpenCode Loop Plugin adds:

- `/loop <interval> <instruction>` and `/loop <instruction>` (dynamic pacing) as an OpenCode command for TUI, desktop, and web.
- A server-side scheduler with per-loop timers that injects a synthetic iteration prompt only when the session is idle, with busy backoff.
- Dynamic loops where the agent itself picks the delay before each next iteration via `schedule_next_run`, mirroring Claude Code's self-paced `/loop`.
- Agent tools: `create_loop`, `list_loops`, `stop_loop`, `pause_loop`, `resume_loop`, `run_loop`, `schedule_next_run`, and `clear_loops`.
- Persistent loop state that survives OpenCode restarts, with atomic writes and owner-only file permissions.
- A TUI sidebar with live countdowns and a `Loops` command-palette entry to run, pause, resume, or stop loops.
- Plan-mode safety: iterations are deferred while the session's last prompt came from a restricted agent (default: `plan`).
- Compaction context so active loops are preserved when OpenCode summarizes a long session.
- Safety rails: minimum interval, per-session loop limit, optional max runs, and automatic expiry after 7 days.

## Install

Install locally for the current OpenCode project:

```bash
opencode plugin @prevalentware/opencode-loop-plugin
```

Install globally:

```bash
opencode plugin -g @prevalentware/opencode-loop-plugin
```

OpenCode detects both package entrypoints and writes the plugin into the server and TUI config targets.

## Manual Config

If you configure it manually, add the package to both config files.

`opencode.json`:

```json
{
  "plugin": ["@prevalentware/opencode-loop-plugin"]
}
```

`tui.json`:

```json
{
  "plugin": ["@prevalentware/opencode-loop-plugin"]
}
```

## Usage

Create a fixed-interval loop:

```text
/loop 10m review the current PR. If there are new comments, address them. If CI fails, diagnose the logs and fix it. If everything is green, report and stop this loop.
```

The interval can lead the instruction (`/loop 10m ...`) or trail it as an `every` clause (`/loop check the deploy every 20m`). Supported units are `s`, `m`, `h`, and `d`; the default minimum is 30 seconds.

Create a dynamic loop — the agent picks the delay between iterations based on what it observes, one iteration at a time:

```text
/loop watch the staging deploy and run smoke checks when it finishes
```

Manage loops:

```text
/loop list
/loop stop loop_7k3p9
/loop pause loop_7k3p9
/loop resume loop_7k3p9
/loop run loop_7k3p9
/loop clear
```

After creating a loop, the agent immediately performs the first iteration in the same turn — it does not wait for the first scheduled run. On each scheduled iteration the scheduler injects a synthetic prompt telling the agent to perform exactly one iteration, never to sleep or poll inside the turn, and to call `stop_loop` once the loop's purpose is achieved (or `pause_loop` if it is blocked on the user).

### Dynamic loops

A dynamic loop mirrors Claude Code's self-paced `/loop`: at the end of each iteration the agent calls `schedule_next_run` with a delay in seconds and a one-sentence reason ("watching CI run"), or calls `stop_loop` to end the loop. If an iteration ends without doing either, the loop ends — exactly like omitting `ScheduleWakeup` in Claude Code.

### How iterations are scheduled

- Iterations only run while the session is idle. If a loop comes due while the session is busy, it is deferred with a short backoff and retried when the session goes idle.
- If several loops in one session are due at once, one iteration is injected and the rest wait for the next idle.
- Failed injections are recorded in the loop's `lastError` and retried after a backoff; they never crash OpenCode.
- Loops are stopped automatically when their session is deleted, when `max_runs` is reached, or after 7 days (configurable).

## Options

Server options can be configured in `opencode.json`:

```json
{
  "plugin": [
    [
      "@prevalentware/opencode-loop-plugin",
      {
        "min_interval_seconds": 30,
        "max_loops_per_session": 5,
        "busy_backoff_seconds": 60,
        "failure_backoff_seconds": 60,
        "max_loop_age_days": 7,
        "dynamic_max_delay_seconds": 86400,
        "restricted_agents": ["plan"],
        "register_command": true,
        "command_name": "loop"
      }
    ]
  ]
}
```

Defaults:

- `min_interval_seconds`: `30`; the smallest accepted interval and the lower clamp for dynamic delays.
- `max_loops_per_session`: `5` open (active or paused) loops per session.
- `busy_backoff_seconds`: `60`; retry delay when an iteration comes due while the session is busy.
- `failure_backoff_seconds`: `60`; retry delay when injecting the iteration prompt fails.
- `max_loop_age_days`: `7`; loops stop automatically after this age. Set `0` to disable expiry.
- `dynamic_max_delay_seconds`: `86400`; upper clamp for `schedule_next_run` delays.
- `restricted_agents`: `["plan"]`; iterations are deferred while the session's last prompt came from one of these agents.
- `register_command`: `true`
- `command_name`: `"loop"`

## State

Loop state is stored at:

```text
$XDG_DATA_HOME/opencode-loop-plugin/loops.json
```

If `XDG_DATA_HOME` is not set, the default is:

```text
~/.local/share/opencode-loop-plugin/loops.json
```

Set `OPENCODE_LOOP_STATE_PATH` to use a custom file.

The state file is written atomically with owner-only permissions when the host filesystem supports it. Active interval loops are rehydrated and rescheduled when OpenCode restarts. Dynamic loops that were waiting on the agent to schedule their next run cannot recover on their own after a restart and are stopped with an explanatory reason.

## Credits

This plugin follows the semantics of Claude Code's `/loop` skill (interval parsing, immediate first iteration, dynamic self-pacing with an explicit schedule-or-stop contract, and 7-day auto-expiry) implemented on top of OpenCode plugin hooks. The package structure, persistence approach, and idle-continuation mechanics follow [`@prevalentware/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin).

## Development

```bash
bun install
bun test
bun run lint
bun run typecheck
bun run build
npm pack --dry-run
```

## Publishing

This package is set up for npm Trusted Publishing from GitHub Actions. On every push to `main`, CI runs typecheck, lint, and unit tests in parallel. If they all pass, the publish job computes the next patch version from the latest version on npm, builds the package, and runs `npm publish`.

Before the first automated publish, configure the package on npm:

1. Open the package settings on npmjs.com.
2. Add a Trusted Publisher for GitHub Actions.
3. Use repository `prevalentWare/opencode-loop-plugin`.
4. Use workflow file `publish.yml`.

The repository must be public for npm provenance to be generated automatically.

## Notes

OpenCode plugin modules are target-specific. This package exports separate modules for server hooks/tools and TUI UI:

```json
{
  "exports": {
    "./server": "./dist/server.js",
    "./tui": "./src/tui.tsx"
  }
}
```

Claude Code's `/loop` has deeper runtime integration (cron scheduling, cache-aware wake-ups, event monitors). This plugin implements the same workflow with OpenCode plugin hooks: timers on the server plugin, idle detection through `session.status` / `session.idle` events, and prompt injection through `session.promptAsync`. The TUI sidebar reads loop state from the plugin's tool outputs in the session, so it works without a private channel between the TUI and the server.
