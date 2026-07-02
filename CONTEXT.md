# OpenCode Loop Plugin

This context defines the language for loop-mode behavior across OpenCode surfaces. It exists to keep the scheduler, the slash command, and UI expectations distinct.

## Language

**Loop**:
A recurring instruction bound to one session, re-injected by the scheduler while the session is idle, until it is stopped, completed, or expired.
_Avoid_: cron job, watcher, goal

**Interval Loop**:
A loop with a fixed cadence (`30s`–`7d`). The scheduler owns the time between iterations.
_Avoid_: timer task

**Dynamic Loop**:
A loop without a fixed cadence. The agent ends each iteration by scheduling the next run (`schedule_next_run`) or by stopping the loop; doing neither ends the loop.
_Avoid_: self-loop, auto mode

**Iteration**:
One synthetic prompt injected into the session for a loop, performing the instruction exactly once without sleeping or polling.
_Avoid_: tick, run (in prose; `runCount` is fine in code)

**Scheduler**:
The server-plugin component that owns timers, busy/idle tracking, deferral, and injection. Only the scheduler decides when an iteration happens.
_Avoid_: daemon, worker

## Relationships

- A **Loop** is executed as a series of **Iterations** driven by the **Scheduler**.
- A **Dynamic Loop** delegates pacing to the agent one **Iteration** at a time; an **Interval Loop** never does.
- The `/loop` slash command is the user entrypoint; the loop tools are the agent entrypoint; both mutate the same persisted state owned by the server plugin.

## Flagged Ambiguities

- "loop" vs. "goal": a goal defines when a task is done; a loop defines when to wake the agent again. They are separate plugins with separate state.
- "stop" vs. "pause": stop is terminal and requires a new loop to restart; pause keeps the loop resumable and does not run iterations.
