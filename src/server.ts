import type { Config, Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  DEFAULT_MAX_LOOPS_PER_SESSION,
  DEFAULT_MIN_INTERVAL_SECONDS,
  MAX_PROMPT_CHARS,
  activeLoops,
  clearClosedLoops,
  createLoop,
  formatLoops,
  getLoop,
  listLoops,
  openLoops,
  parseInterval,
  pauseLoop,
  resumeLoop,
  scheduleNextRun,
  stopLoop,
  stopLoopsForSession,
  recordRunDeferred,
  recordRunFailed,
  recordRunSent,
  type LoopSnapshot,
} from "./state"
import { compactionContext, iterationPrompt, loopCommandTemplate, systemReminder } from "./prompts"

type Options = {
  register_command?: boolean
  command_name?: string
  min_interval_seconds?: number
  max_loops_per_session?: number
  busy_backoff_seconds?: number
  failure_backoff_seconds?: number
  max_loop_age_days?: number
  dynamic_max_delay_seconds?: number
  restricted_agents?: string[]
}

const DEFAULT_COMMAND_NAME = "loop"
const DEFAULT_BUSY_BACKOFF_SECONDS = 60
const DEFAULT_FAILURE_BACKOFF_SECONDS = 60
const DEFAULT_MAX_LOOP_AGE_DAYS = 7
const DEFAULT_DYNAMIC_MAX_DELAY_SECONDS = 24 * 60 * 60
const DEFAULT_RESTRICTED_AGENTS = ["plan"]
const LOOP_SYSTEM_MARKER = "OpenCode loop mode"

function commandNameFromOptions(options?: Options) {
  const name = options?.command_name?.trim() || DEFAULT_COMMAND_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return DEFAULT_COMMAND_NAME
  return name
}

function positiveNumberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function restrictedAgentSet(options?: Options) {
  const names = Array.isArray(options?.restricted_agents) ? options.restricted_agents : DEFAULT_RESTRICTED_AGENTS
  return new Set(names.map((name) => (typeof name === "string" ? name.trim().toLowerCase() : "")).filter(Boolean))
}

function registerDesktopCommand(config: Config, commandName: string, minIntervalSeconds: number) {
  config.command ??= {}
  if (config.command[commandName]) return
  config.command[commandName] = {
    description: "Run an instruction on a recurring interval while this session is idle",
    template: loopCommandTemplate(commandName, minIntervalSeconds),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sessionIDFromEvent(event: { properties?: Record<string, unknown> }) {
  const direct = event.properties?.sessionID
  if (typeof direct === "string") return direct
  const info = event.properties?.info
  if (isRecord(info) && typeof info.sessionID === "string") return info.sessionID
  return undefined
}

function isIdleEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  if (event.type === "session.idle") return true
  const status = event.properties?.status
  return event.type === "session.status" && isRecord(status) && status.type === "idle"
}

function isBusyEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  const status = event.properties?.status
  return event.type === "session.status" && isRecord(status) && status.type === "busy"
}

async function toolResult(sessionID: string, extra: Record<string, unknown> = {}) {
  const loops = await listLoops(sessionID)
  return JSON.stringify({ ...extra, loops, report: formatLoops(loops) }, null, 2)
}

const server: Plugin = async ({ client }, options?: Options) => {
  const registerCommand = options?.register_command ?? true
  const commandName = commandNameFromOptions(options)
  const minIntervalSeconds = positiveNumberOr(options?.min_interval_seconds, DEFAULT_MIN_INTERVAL_SECONDS)
  const maxLoopsPerSession = positiveNumberOr(options?.max_loops_per_session, DEFAULT_MAX_LOOPS_PER_SESSION)
  const busyBackoffMs = positiveNumberOr(options?.busy_backoff_seconds, DEFAULT_BUSY_BACKOFF_SECONDS) * 1000
  const failureBackoffMs = positiveNumberOr(options?.failure_backoff_seconds, DEFAULT_FAILURE_BACKOFF_SECONDS) * 1000
  const maxLoopAgeMs = nonNegativeNumberOr(options?.max_loop_age_days, DEFAULT_MAX_LOOP_AGE_DAYS) * 24 * 60 * 60 * 1000
  const dynamicMaxDelaySeconds = positiveNumberOr(options?.dynamic_max_delay_seconds, DEFAULT_DYNAMIC_MAX_DELAY_SECONDS)
  const restrictedAgents = restrictedAgentSet(options)

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const sendingLoops = new Set<string>()
  const busySessions = new Set<string>()
  // Sessions this process has seen through events, prompts, or tool calls. Used
  // as an ownership proxy so a process sharing the state file with another
  // OpenCode instance does not mutate loops belonging to foreign sessions.
  const observedSessions = new Set<string>()
  const lastPromptAgentBySession = new Map<string, string>()
  // Dynamic loops whose latest injected (or creating) turn has not yet gone idle:
  // if that turn ends without schedule_next_run or stop_loop, the loop ends.
  const dynamicPending = new Map<string, { sessionID: string; sawBusy: boolean }>()

  const isRestrictedAgent = (agent: string | null | undefined) =>
    typeof agent === "string" && restrictedAgents.has(agent.trim().toLowerCase())

  async function log(level: "info" | "error", message: string, extra?: Record<string, unknown>) {
    await client.app
      ?.log?.({ body: { service: "opencode-loop-plugin", level, message, extra } })
      .catch(() => undefined)
  }

  function cancelTimer(loopID: string) {
    const timer = timers.get(loopID)
    if (timer) clearTimeout(timer)
    timers.delete(loopID)
  }

  function scheduleTimer(loop: LoopSnapshot) {
    cancelTimer(loop.id)
    if (loop.status !== "active" || loop.nextRunAt == null) return
    const delay = Math.max(0, loop.nextRunAt - Date.now())
    const timer = setTimeout(() => {
      timers.delete(loop.id)
      void runDue(loop.id)
    }, delay)
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    timers.set(loop.id, timer)
  }

  async function runDue(loopID: string) {
    if (sendingLoops.has(loopID)) return
    sendingLoops.add(loopID)
    try {
      await runDueLocked(loopID)
    } catch (error) {
      await log("error", "Loop iteration failed unexpectedly", {
        loopID,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      sendingLoops.delete(loopID)
    }
  }

  async function runDueLocked(loopID: string) {
    const loop = await getLoop(loopID)
    if (!loop || loop.status !== "active" || loop.nextRunAt == null) return
    if (loop.nextRunAt > Date.now()) {
      scheduleTimer(loop)
      return
    }
    if (maxLoopAgeMs > 0 && Date.now() - loop.createdAt >= maxLoopAgeMs) {
      await stopLoop(loopID, `expired after ${Math.round(maxLoopAgeMs / 86_400_000)} days`)
      return
    }
    if (busySessions.has(loop.sessionID)) {
      const deferred = await recordRunDeferred(loopID, "skipped_busy", Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      scheduleTimer(deferred)
      return
    }
    if (isRestrictedAgent(lastPromptAgentBySession.get(loop.sessionID))) {
      const deferred = await recordRunDeferred(loopID, "skipped_plan", Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      scheduleTimer(deferred)
      return
    }
    // Register before injecting: the injected turn's busy event can arrive while
    // recordRunSent is still awaiting, and a flip missed there would leave the
    // loop as an unsettleable zombie. sawBusy stays false until that busy event
    // arrives, so a stale idle event from the previous turn cannot settle early.
    if (loop.mode === "dynamic") {
      dynamicPending.set(loopID, { sessionID: loop.sessionID, sawBusy: false })
    }
    try {
      await client.session.promptAsync({
        path: { id: loop.sessionID },
        body: {
          ...(loop.agent ? { agent: loop.agent } : {}),
          parts: [{ type: "text", text: iterationPrompt(loop) }],
        },
      })
    } catch (error) {
      dynamicPending.delete(loopID)
      if (!observedSessions.has(loop.sessionID)) {
        // Likely a session owned by another OpenCode process sharing the state
        // file: leave its record alone and stop driving it from this process.
        await log("info", "Skipping loop for a session this process has not observed", { loopID, sessionID: loop.sessionID })
        return
      }
      const failed = await recordRunFailed(loopID, error instanceof Error ? error.message : String(error), failureBackoffMs)
      scheduleTimer(failed)
      await log("error", "Loop iteration prompt failed", { loopID, error: failed.lastError ?? undefined })
      return
    }
    busySessions.add(loop.sessionID)
    observedSessions.add(loop.sessionID)
    const sent = await recordRunSent(loopID)
    if (sent.mode !== "dynamic" || sent.status !== "active") dynamicPending.delete(loopID)
    scheduleTimer(sent)
  }

  async function runDueForSession(sessionID: string) {
    const loops = await activeLoops(sessionID)
    const now = Date.now()
    for (const loop of loops) {
      if (loop.nextRunAt == null || loop.nextRunAt > now) continue
      await runDue(loop.id)
      // Injecting one iteration makes the session busy; later due loops defer via their timers.
      if (busySessions.has(sessionID)) break
    }
  }

  async function settleDynamicLoops(sessionID: string) {
    for (const [loopID, pending] of dynamicPending) {
      if (pending.sessionID !== sessionID || !pending.sawBusy) continue
      dynamicPending.delete(loopID)
      const loop = await getLoop(loopID)
      if (!loop || loop.status !== "active" || loop.mode !== "dynamic") continue
      if (loop.nextRunAt != null) continue
      await stopLoop(loopID, "the iteration ended without scheduling the next run").catch(() => undefined)
      await log("info", "Dynamic loop ended because the turn did not schedule the next run", { loopID })
    }
  }

  async function rehydrate() {
    const loops = await activeLoops()
    for (const loop of loops) {
      if (loop.nextRunAt == null) {
        // A dynamic loop whose scheduling turn died with the previous process cannot recover on its own.
        if (loop.mode === "dynamic") await stopLoop(loop.id, "not rescheduled before OpenCode restarted")
        continue
      }
      scheduleTimer(loop)
    }
  }

  async function requireSessionLoop(loopID: string, sessionID: string) {
    observedSessions.add(sessionID)
    const loop = await getLoop(loopID)
    if (!loop) throw new Error(`no loop found with id "${loopID}"`)
    if (loop.sessionID !== sessionID) throw new Error(`loop "${loopID}" belongs to a different session`)
    return loop
  }

  await rehydrate().catch((error) =>
    log("error", "Failed to rehydrate loops", { error: error instanceof Error ? error.message : String(error) }),
  )

  return {
    async dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      dynamicPending.clear()
    },
    async config(config) {
      if (!registerCommand) return
      registerDesktopCommand(config, commandName, minIntervalSeconds)
    },
    tool: {
      create_loop: {
        description:
          "Create a recurring loop for this session only when explicitly requested (for example via the /loop command). The scheduler re-injects the instruction while the session is idle. Pass interval for fixed cadence (like \"10m\"); omit it for a dynamic loop where the agent schedules each next run with schedule_next_run.",
        args: {
          instruction: z.string().min(1).max(MAX_PROMPT_CHARS).describe("The instruction to perform on each iteration."),
          interval: z
            .string()
            .optional()
            .describe('Fixed cadence like "30s", "10m", "2h", or "1d". Omit for a dynamically paced loop.'),
          max_runs: z.number().int().positive().optional().describe("Optional maximum number of iterations before the loop completes."),
        },
        async execute(args, context) {
          const input = args as { instruction: string; interval?: string; max_runs?: number }
          observedSessions.add(context.sessionID)
          const dynamic = !input.interval?.trim()
          const loop = await createLoop(context.sessionID, {
            prompt: input.instruction,
            mode: dynamic ? "dynamic" : "interval",
            intervalMs: dynamic ? null : parseInterval(input.interval!, minIntervalSeconds),
            maxRuns: input.max_runs ?? null,
            agent: typeof context.agent === "string" ? context.agent : null,
            maxLoopsPerSession,
          })
          if (loop.mode === "dynamic") {
            dynamicPending.set(loop.id, { sessionID: loop.sessionID, sawBusy: true })
          } else {
            scheduleTimer(loop)
          }
          return toolResult(context.sessionID, { created: loop.id, loop })
        },
      },
      list_loops: {
        description: "List the loops for this OpenCode session, including status, cadence, run counts, and next scheduled run.",
        args: {},
        async execute(_args, context) {
          observedSessions.add(context.sessionID)
          return toolResult(context.sessionID)
        },
      },
      stop_loop: {
        description:
          "Stop a loop in this session. Call this when the loop's purpose has been achieved, it became obsolete, or the user asked to stop it.",
        args: {
          loop_id: z.string().min(1).describe("The loop id, like loop_7k3p9."),
          reason: z.string().max(400).optional().describe("Short reason the loop is stopping."),
        },
        async execute(args, context) {
          const input = args as { loop_id: string; reason?: string }
          await requireSessionLoop(input.loop_id, context.sessionID)
          const loop = await stopLoop(input.loop_id, input.reason ?? null)
          cancelTimer(loop.id)
          dynamicPending.delete(loop.id)
          return toolResult(context.sessionID, { stopped: loop.id })
        },
      },
      pause_loop: {
        description: "Pause an active loop in this session without deleting it. Paused loops do not run until resumed.",
        args: {
          loop_id: z.string().min(1).describe("The loop id, like loop_7k3p9."),
        },
        async execute(args, context) {
          const input = args as { loop_id: string }
          await requireSessionLoop(input.loop_id, context.sessionID)
          const loop = await pauseLoop(input.loop_id)
          cancelTimer(loop.id)
          dynamicPending.delete(loop.id)
          return toolResult(context.sessionID, { paused: loop.id })
        },
      },
      resume_loop: {
        description: "Resume a paused loop in this session. Interval loops schedule their next run one interval from now.",
        args: {
          loop_id: z.string().min(1).describe("The loop id, like loop_7k3p9."),
        },
        async execute(args, context) {
          const input = args as { loop_id: string }
          await requireSessionLoop(input.loop_id, context.sessionID)
          const loop = await resumeLoop(input.loop_id)
          scheduleTimer(loop)
          return toolResult(context.sessionID, { resumed: loop.id })
        },
      },
      run_loop: {
        description: "Force an immediate iteration of a loop in this session. The iteration runs as soon as the session is idle.",
        args: {
          loop_id: z.string().min(1).describe("The loop id, like loop_7k3p9."),
        },
        async execute(args, context) {
          const input = args as { loop_id: string }
          await requireSessionLoop(input.loop_id, context.sessionID)
          const loop = await scheduleNextRun(input.loop_id, 1, "manual run requested")
          scheduleTimer(loop)
          return toolResult(context.sessionID, {
            queued: loop.id,
            note: "The iteration will run as soon as the session is idle.",
          })
        },
      },
      schedule_next_run: {
        description:
          "Schedule the next iteration of a dynamically paced loop in this session. Call this before ending a dynamic loop iteration to keep the loop alive; omit it (or call stop_loop) to end the loop.",
        args: {
          loop_id: z.string().min(1).describe("The loop id, like loop_7k3p9."),
          delay_seconds: z.number().positive().describe("Seconds from now until the next iteration."),
          reason: z.string().max(400).describe("One short sentence on why this delay was chosen."),
        },
        async execute(args, context) {
          const input = args as { loop_id: string; delay_seconds: number; reason: string }
          const target = await requireSessionLoop(input.loop_id, context.sessionID)
          if (target.mode !== "dynamic") {
            throw new Error(`loop "${input.loop_id}" has a fixed interval; only dynamically paced loops use schedule_next_run`)
          }
          const clamped = Math.min(Math.max(input.delay_seconds, minIntervalSeconds), dynamicMaxDelaySeconds)
          const loop = await scheduleNextRun(input.loop_id, clamped * 1000, input.reason)
          dynamicPending.delete(loop.id)
          scheduleTimer(loop)
          return toolResult(context.sessionID, {
            scheduled: loop.id,
            next_run_at: loop.nextRunAt,
            clamped_delay_seconds: clamped,
            was_clamped: clamped !== input.delay_seconds,
          })
        },
      },
      clear_loops: {
        description: "Delete stopped and completed loops for this session. Active and paused loops are kept.",
        args: {},
        async execute(_args, context) {
          observedSessions.add(context.sessionID)
          const cleared = await clearClosedLoops(context.sessionID)
          return toolResult(context.sessionID, { cleared })
        },
      },
    },
    async "chat.message"(input, output) {
      const sessionID =
        typeof input?.sessionID === "string"
          ? input.sessionID
          : isRecord(output.message) && typeof output.message.sessionID === "string"
            ? output.message.sessionID
            : undefined
      const agent =
        typeof input?.agent === "string" && input.agent.trim()
          ? input.agent
          : isRecord(output.message) && typeof output.message.agent === "string"
            ? output.message.agent
            : undefined
      if (typeof sessionID !== "string") return
      observedSessions.add(sessionID)
      if (typeof agent !== "string" || !agent.trim()) return
      lastPromptAgentBySession.set(sessionID, agent.trim())
    },
    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return
      const loops = await openLoops(input.sessionID)
      const reminder = systemReminder(loops)
      if (!reminder) return
      if (output.system.some((block) => block.includes(LOOP_SYSTEM_MARKER))) return
      if (output.system.length === 0) output.system.push(reminder)
      else output.system[0] = `${output.system[0]}\n\n${reminder}`
    },
    async "experimental.session.compacting"(input, output) {
      const loops = await openLoops(input.sessionID)
      const context = compactionContext(loops)
      if (context) output.context.push(context)
    },
    async event({ event }) {
      const typed = event as { type?: string; properties?: Record<string, unknown> }
      const sessionID = sessionIDFromEvent(typed)
      if (!sessionID) return
      observedSessions.add(sessionID)
      if (isBusyEvent(typed)) {
        busySessions.add(sessionID)
        for (const pending of dynamicPending.values()) {
          if (pending.sessionID === sessionID) pending.sawBusy = true
        }
        return
      }
      if (typed.type === "session.deleted") {
        busySessions.delete(sessionID)
        lastPromptAgentBySession.delete(sessionID)
        const stopped = await stopLoopsForSession(sessionID, "session deleted")
        for (const loop of stopped) {
          cancelTimer(loop.id)
          dynamicPending.delete(loop.id)
        }
        return
      }
      if (isIdleEvent(typed)) {
        busySessions.delete(sessionID)
        await settleDynamicLoops(sessionID)
        await runDueForSession(sessionID)
      }
    },
  }
}

export default {
  id: "local.loop-mode.server",
  server,
}
