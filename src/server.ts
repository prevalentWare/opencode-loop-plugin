import type { Config, Plugin } from "@opencode-ai/plugin"
import type * as PluginV2 from "@opencode/plugin"
import type { Info as ToolV2Info } from "@opencode/plugin/promise/tool"
import type { Tool as ToolSchema } from "@opencode/schema/tool"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  DEFAULT_MAX_LOOPS_PER_SESSION,
  DEFAULT_MIN_INTERVAL_SECONDS,
  MAX_PROMPT_CHARS,
  activeLoops,
  acquireLoopOwner,
  acquireSessionLease,
  claimDueRunOwned,
  clearClosedLoops,
  confirmRunClaim,
  createLoop,
  formatLoops,
  getLoop,
  listLoops,
  openLoops,
  ownsSessionLease,
  parseInterval,
  pauseLoop,
  rescheduleDynamicIfUnchanged,
  resumeLoop,
  scheduleNextRun,
  stopLoop,
  stopLoopClaimed,
  stopLoopIfUnchanged,
  stopLoopsForSession,
  recordRunDeferredClaimed,
  recordRunFailedClaimed,
  recordRunSentClaimed,
  releaseSessionLease,
  renewSessionLease,
  type SessionLease,
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
  max_failure_backoff_seconds?: number
  max_consecutive_failures?: number
  max_loop_age_days?: number
  dynamic_max_delay_seconds?: number
  restricted_agents?: string[]
  dynamic_restart_mode?: string
  dynamic_restart_fallback_seconds?: number
}

type PendingDynamicTurn = { sessionID: string; sawBusy: boolean }
type LoopTimer = { handle: ReturnType<typeof setTimeout>; nextRunAt: number }

const KEEP_ALIVE_DESCRIPTION =
  "Keep this session scheduled across turns and exempt from age expiry. Requires a fixed interval. Explicit max_runs, session deletion, and the failure-pause threshold still apply. Use it in a background or subagent session whose work outlives the turn that started it: the scheduler keeps re-prompting the session on the cadence, and the loop is never ended automatically by age expiry. You remain responsible for calling stop_loop once the work is resolved or abandoned."

const DEFAULT_COMMAND_NAME = "loop"
const DEFAULT_BUSY_BACKOFF_SECONDS = 60
const DEFAULT_FAILURE_BACKOFF_SECONDS = 60
const DEFAULT_MAX_FAILURE_BACKOFF_SECONDS = 60 * 60
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5
const DEFAULT_MAX_LOOP_AGE_DAYS = 7
const DEFAULT_DYNAMIC_MAX_DELAY_SECONDS = 24 * 60 * 60
const DEFAULT_DYNAMIC_RESTART_FALLBACK_SECONDS = 20 * 60
const RUN_CLAIM_LEASE_MS = 30_000
const SESSION_LEASE_MS = 90_000
const SESSION_LEASE_HEARTBEAT_MS = 30_000
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

function dynamicRestartMode(options?: Options) {
  return typeof options?.dynamic_restart_mode === "string" && options.dynamic_restart_mode.trim().toLowerCase() === "stop" ? "stop" : "fallback"
}

function dynamicRestartFallbackMs(options?: Options, minIntervalSeconds?: number, dynamicMaxDelaySeconds?: number) {
  const fallbackSeconds = positiveNumberOr(
    options?.dynamic_restart_fallback_seconds,
    DEFAULT_DYNAMIC_RESTART_FALLBACK_SECONDS,
  )
  const minMs = (minIntervalSeconds ?? DEFAULT_MIN_INTERVAL_SECONDS) * 1000
  const maxMs = (dynamicMaxDelaySeconds ?? DEFAULT_DYNAMIC_MAX_DELAY_SECONDS) * 1000
  return Math.min(Math.max(Math.round(fallbackSeconds * 1000), minMs), Math.max(maxMs, minMs))
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

function enqueueSessionOperation<T>(
  queues: Map<string, Promise<void>>,
  sessionID: string,
  operation: () => Promise<T>,
) {
  const previous = queues.get(sessionID) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const settled = current.then(() => undefined, () => undefined)
  queues.set(sessionID, settled)
  void settled.then(() => {
    if (queues.get(sessionID) === settled) queues.delete(sessionID)
  })
  return current
}

async function toolResult(sessionID: string, extra: Record<string, unknown> = {}) {
  const loops = await listLoops(sessionID)
  return JSON.stringify({ ...extra, loops, report: formatLoops(loops) }, null, 2)
}

const server: Plugin = async ({ client, directory }, options?: Options) => {
  const registerCommand = options?.register_command ?? true
  const commandName = commandNameFromOptions(options)
  const minIntervalSeconds = positiveNumberOr(options?.min_interval_seconds, DEFAULT_MIN_INTERVAL_SECONDS)
  const maxLoopsPerSession = positiveNumberOr(options?.max_loops_per_session, DEFAULT_MAX_LOOPS_PER_SESSION)
  const busyBackoffMs = positiveNumberOr(options?.busy_backoff_seconds, DEFAULT_BUSY_BACKOFF_SECONDS) * 1000
  const failureBackoffMs = positiveNumberOr(options?.failure_backoff_seconds, DEFAULT_FAILURE_BACKOFF_SECONDS) * 1000
  const maxFailureBackoffMs =
    positiveNumberOr(options?.max_failure_backoff_seconds, DEFAULT_MAX_FAILURE_BACKOFF_SECONDS) * 1000
  const maxConsecutiveFailures = positiveNumberOr(options?.max_consecutive_failures, DEFAULT_MAX_CONSECUTIVE_FAILURES)
  const maxLoopAgeMs = nonNegativeNumberOr(options?.max_loop_age_days, DEFAULT_MAX_LOOP_AGE_DAYS) * 24 * 60 * 60 * 1000
  const dynamicMaxDelaySeconds = positiveNumberOr(options?.dynamic_max_delay_seconds, DEFAULT_DYNAMIC_MAX_DELAY_SECONDS)
  const restrictedAgents = restrictedAgentSet(options)
  const restartMode = dynamicRestartMode(options)
  const restartFallbackMs = dynamicRestartFallbackMs(options, minIntervalSeconds, dynamicMaxDelaySeconds)

  let disposed = false
  const timers = new Map<string, LoopTimer>()
  const sendingLoops = new Set<string>()
  const busySessions = new Set<string>()
  const deletedSessions = new Set<string>()
  const instanceID = randomUUID()
  const loopOwnerID = `server:${process.pid}:${randomUUID()}`
  const ownedSessions = new Map<string, SessionLease>()
  const ownershipQueues = new Map<string, Promise<void>>()
  // Sessions this process has seen through events, prompts, or tool calls. Used
  // as an ownership proxy so a process sharing the state file with another
  // OpenCode instance does not mutate loops belonging to foreign sessions.
  const observedSessions = new Set<string>()
  const keepAliveSessions = new Set<string>()
  // Dynamic records with no next run are only restart candidates until this
  // process proves that it owns their session. The captured timestamp also
  // prevents us from stopping a record changed by its actual owner meanwhile.
  const staleDynamicCandidates = new Map<string, { sessionID: string; updatedAt: number }>()
  const lastPromptAgentBySession = new Map<string, string>()
  // Dynamic loops whose latest injected (or creating) turn has not yet gone idle:
  // if that turn ends without schedule_next_run or stop_loop, the loop ends.
  const dynamicPending = new Map<string, PendingDynamicTurn>()
  const deferredDynamicSettlements = new Map<string, PendingDynamicTurn>()

  const isRestrictedAgent = (agent: string | null | undefined) =>
    typeof agent === "string" && restrictedAgents.has(agent.trim().toLowerCase())

  async function log(level: "info" | "error", message: string, extra?: Record<string, unknown>) {
    await client.app
      ?.log?.({ body: { service: "opencode-loop-plugin", level, message, extra } })
      .catch(() => undefined)
  }

  function cancelTimer(loopID: string) {
    const timer = timers.get(loopID)
    if (timer) clearTimeout(timer.handle)
    timers.delete(loopID)
  }

  async function loseOwnership(sessionID: string) {
    ownedSessions.delete(sessionID)
    for (const loop of await activeLoops(sessionID)) cancelTimer(loop.id)
    for (const [loopID, pending] of dynamicPending) {
      if (pending.sessionID === sessionID) dynamicPending.delete(loopID)
    }
  }

  async function recoveredSessionBusy(sessionID: string) {
    try {
      const response = await client.session.status()
      const status = response.data?.[sessionID]
      return !response.data || (status != null && status.type !== "idle")
    } catch {
      // A detached session must be known idle before restoring its heartbeat.
      return true
    }
  }

  async function keepAliveSessionAvailable(sessionID: string) {
    try {
      const response = await client.session.get({ path: { id: sessionID } })
      return response.data?.id === sessionID && (!directory || response.data.directory === directory)
    } catch {
      return false
    }
  }

  async function reconcileTimers(sessionID: string) {
    for (const loop of await activeLoops(sessionID)) {
      const timer = timers.get(loop.id)
      if (!sendingLoops.has(loop.id) && (!timer || timer.nextRunAt !== loop.nextRunAt)) scheduleTimer(loop)
    }
  }

  async function acquireOwnership(sessionID: string) {
    return enqueueSessionOperation(ownershipQueues, sessionID, async () => {
      if (disposed) return false
      if (!observedSessions.has(sessionID) && !(await keepAliveSessionAvailable(sessionID))) return false
      const current = ownedSessions.get(sessionID)
      if (current && current.expiresAt > Date.now() + SESSION_LEASE_HEARTBEAT_MS &&
        await ownsSessionLease(sessionID, instanceID, current.revision)) {
        await reconcileTimers(sessionID)
        return true
      }
      const lease = await acquireSessionLease(sessionID, instanceID, SESSION_LEASE_MS)
      if (!lease) {
        await loseOwnership(sessionID)
        return false
      }
      ownedSessions.set(sessionID, lease)
      await reconcileTimers(sessionID)
      return true
    })
  }

  async function renewOwnership(sessionID: string) {
    return enqueueSessionOperation(ownershipQueues, sessionID, async () => {
      if (disposed) return false
      const lease = ownedSessions.get(sessionID)
      if (!lease) return false
      const renewed = await renewSessionLease(sessionID, instanceID, lease.revision, SESSION_LEASE_MS, true)
      if (!renewed) {
        await loseOwnership(sessionID)
        return false
      }
      ownedSessions.set(sessionID, renewed)
      await reconcileTimers(sessionID)
      return true
    })
  }

  function scheduleTimer(loop: LoopSnapshot, minimumDelayMs = 0) {
    cancelTimer(loop.id)
    if (disposed || loop.status !== "active" || loop.nextRunAt == null || deletedSessions.has(loop.sessionID) || !ownedSessions.has(loop.sessionID) ||
      (!observedSessions.has(loop.sessionID) && !loop.keepAlive)) return
    const delay = Math.max(minimumDelayMs, loop.nextRunAt - Date.now())
    const timer = setTimeout(() => {
      timers.delete(loop.id)
      void runDue(loop.id)
    }, delay)
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    timers.set(loop.id, { handle: timer, nextRunAt: loop.nextRunAt })
  }

  async function runDue(loopID: string) {
    if (sendingLoops.has(loopID)) return
    sendingLoops.add(loopID)
    try {
      await runDueLocked(loopID)
    } catch {
      await log("error", "Loop scheduler operation failed", { loopID, category: "scheduler" })
    } finally {
      sendingLoops.delete(loopID)
      const pending = deferredDynamicSettlements.get(loopID)
      if (pending && !disposed) await settleDynamicLoop(loopID, pending).catch(() =>
        log("error", "Dynamic loop settlement failed", { loopID, category: "state" }),
      )
    }
  }

  async function runDueLocked(loopID: string) {
    let loop = await getLoop(loopID)
    if (!loop || loop.status !== "active" || loop.nextRunAt == null || deletedSessions.has(loop.sessionID)) return
    if (!(await renewOwnership(loop.sessionID))) return
    const lease = ownedSessions.get(loop.sessionID)
    if (!lease || !(await ownsSessionLease(loop.sessionID, instanceID, lease.revision))) {
      await loseOwnership(loop.sessionID)
      return
    }
    if (loop.nextRunAt > Date.now()) {
      scheduleTimer(loop)
      return
    }
    if (!observedSessions.has(loop.sessionID) && !loop.keepAlive) {
      // Ownership is checked before claiming or prompting so this process never
      // mutates a loop belonging to an unknown session. Keep polling without
      // changing persisted state so later observations through any hook/tool
      // allow the scheduler to take ownership instead of stranding the loop.
      scheduleTimer(loop, Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      await log("info", "Skipping loop because session ownership is unknown", { loopID, category: "ownership" })
      return
    }
    const owner = await acquireLoopOwner(loopID, loopOwnerID, RUN_CLAIM_LEASE_MS, lease)
    const claimed = owner ? await claimDueRunOwned(loopID, owner, RUN_CLAIM_LEASE_MS) : null
    if (!claimed) {
      loop = await getLoop(loopID)
      if (loop) scheduleTimer(loop)
      return
    }
    loop = claimed.loop
    if (!loop.keepAlive && maxLoopAgeMs > 0 && Date.now() - loop.createdAt >= maxLoopAgeMs) {
      await stopLoopClaimed(loopID, claimed, `expired after ${Math.round(maxLoopAgeMs / 86_400_000)} days`)
      return
    }
    if (busySessions.has(loop.sessionID) ||
      (loop.keepAlive && !observedSessions.has(loop.sessionID) && await recoveredSessionBusy(loop.sessionID))) {
      const deferred = await recordRunDeferredClaimed(loopID, claimed, "skipped_busy", Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      if (deferred) scheduleTimer(deferred)
      return
    }
    if (isRestrictedAgent(lastPromptAgentBySession.get(loop.sessionID))) {
      const deferred = await recordRunDeferredClaimed(loopID, claimed, "skipped_plan", Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      if (deferred) scheduleTimer(deferred)
      return
    }
    const injectionLease = ownedSessions.get(loop.sessionID)
    if (!injectionLease || !(await ownsSessionLease(loop.sessionID, instanceID, injectionLease.revision))) {
      await loseOwnership(loop.sessionID)
      return
    }
    // Register before injecting: the injected turn's busy event can arrive while
    // recordRunSent is still awaiting, and a flip missed there would leave the
    // loop as an unsettleable zombie. sawBusy stays false until that busy event
    // arrives, so a stale idle event from the previous turn cannot settle early.
    if (loop.mode === "dynamic") {
      dynamicPending.set(loopID, { sessionID: loop.sessionID, sawBusy: false })
    }
    if (!(await confirmRunClaim(loopID, claimed)) || disposed || deletedSessions.has(loop.sessionID)) {
      dynamicPending.delete(loopID)
      const current = await getLoop(loopID)
      if (current) scheduleTimer(current)
      return
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
      await acquireLoopOwner(loopID, loopOwnerID, RUN_CLAIM_LEASE_MS, lease)
      const failed = await recordRunFailedClaimed(
        loopID,
        claimed,
        error instanceof Error ? error.message : String(error),
        failureBackoffMs,
        maxConsecutiveFailures,
        maxFailureBackoffMs,
      )
      if (failed) scheduleTimer(failed)
      else {
        const current = await getLoop(loopID)
        if (current) scheduleTimer(current)
      }
      await log("error", "Loop iteration prompt failed", { loopID, error: failed?.lastError ?? undefined })
      return
    }
    busySessions.add(loop.sessionID)
    observedSessions.add(loop.sessionID)
    await acquireLoopOwner(loopID, loopOwnerID, RUN_CLAIM_LEASE_MS, lease)
    const sent = await recordRunSentClaimed(loopID, claimed)
    if (!sent) {
      const current = await getLoop(loopID)
      if (current) scheduleTimer(current)
      return
    }
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

  async function settleDynamicLoop(loopID: string, pending: PendingDynamicTurn) {
    if (dynamicPending.get(loopID) !== pending || !pending.sawBusy) {
      if (deferredDynamicSettlements.get(loopID) === pending) deferredDynamicSettlements.delete(loopID)
      return
    }
    const lease = ownedSessions.get(pending.sessionID)
    if (!lease) return
    deferredDynamicSettlements.set(loopID, pending)
    if (sendingLoops.has(loopID)) return
    const loop = await getLoop(loopID)
    if (dynamicPending.get(loopID) !== pending) {
      if (deferredDynamicSettlements.get(loopID) === pending) deferredDynamicSettlements.delete(loopID)
      return
    }
    if (sendingLoops.has(loopID)) return
    if (loop?.status === "active" && loop.mode === "dynamic" && loop.nextRunAt == null) {
      const stopped = await stopLoopIfUnchanged(
        loopID, loop.updatedAt, "the iteration ended without scheduling the next run", lease, loop.scheduleRevision,
      )
      if (!stopped) return
    }
    if (dynamicPending.get(loopID) === pending) dynamicPending.delete(loopID)
    if (deferredDynamicSettlements.get(loopID) === pending) deferredDynamicSettlements.delete(loopID)
  }

  function rememberTerminalTurn(sessionID: string) {
    for (const [loopID, pending] of dynamicPending) {
      if (pending.sessionID === sessionID && pending.sawBusy) deferredDynamicSettlements.set(loopID, pending)
    }
  }

  async function settleDynamicLoops(sessionID: string) {
    for (const [loopID, pending] of dynamicPending) {
      if (pending.sessionID === sessionID) await settleDynamicLoop(loopID, pending)
    }
  }

  async function retryDeferredState(sessionID: string) {
    if (deletedSessions.has(sessionID)) {
      for (const loop of await stopLoopsForSession(sessionID, "session deleted")) {
        cancelTimer(loop.id)
        dynamicPending.delete(loop.id)
        deferredDynamicSettlements.delete(loop.id)
      }
      deletedSessions.delete(sessionID)
      observedSessions.delete(sessionID)
      keepAliveSessions.delete(sessionID)
      return
    }
    for (const [loopID, pending] of deferredDynamicSettlements) {
      if (pending.sessionID === sessionID) await settleDynamicLoop(loopID, pending)
    }
  }

  async function rehydrate() {
    // Persisted loops are only observed here. A fresh process must receive an
    // authoritative lifecycle signal or an explicit tool invocation before it
    // may acquire the session lease and arm timers.
    const loops = await activeLoops()
    for (const loop of loops) {
      if (loop.keepAlive) keepAliveSessions.add(loop.sessionID)
      if (loop.nextRunAt == null) {
        if (loop.mode === "dynamic") {
          staleDynamicCandidates.set(loop.id, { sessionID: loop.sessionID, updatedAt: loop.updatedAt })
          await log("info", "Dynamic loop is an orphaned/stale restart candidate pending session ownership", {
            loopID: loop.id,
            sessionID: loop.sessionID,
          })
        }
        continue
      }
    }
    for (const sessionID of keepAliveSessions) await acquireOwnership(sessionID)
  }

  async function observeSession(sessionID: string) {
    observedSessions.add(sessionID)
    if (!(await acquireOwnership(sessionID))) return
    const wasDeleted = deletedSessions.has(sessionID)
    await retryDeferredState(sessionID)
    if (wasDeleted) return
    const lease = ownedSessions.get(sessionID)
    if (!lease) return
    for (const [loopID, candidate] of staleDynamicCandidates) {
      if (candidate.sessionID !== sessionID) continue
      if (restartMode === "fallback") {
        const rescheduled = await rescheduleDynamicIfUnchanged(
          loopID, candidate.updatedAt, restartFallbackMs, "restarted with fallback delay; reschedule or stop after this iteration", lease,
        )
        if (rescheduled) {
          scheduleTimer(rescheduled)
          await log("info", "Dynamic loop resumed with fallback delay after restart", { loopID })
        }
      } else {
        await stopLoopIfUnchanged(
          loopID, candidate.updatedAt, "not rescheduled before OpenCode restarted", lease,
        )
      }
      staleDynamicCandidates.delete(loopID)
    }
  }

  async function requireSessionLoop(loopID: string, sessionID: string) {
    await observeSession(sessionID)
    const loop = await getLoop(loopID)
    if (!loop) throw new Error(`no loop found with id "${loopID}"`)
    if (loop.sessionID !== sessionID) throw new Error(`loop "${loopID}" belongs to a different session`)
    return loop
  }

  await rehydrate().catch(() => log("error", "Failed to rehydrate loops", { category: "state" }))
  const leaseHeartbeat = setInterval(() => {
    for (const sessionID of new Set([...observedSessions, ...keepAliveSessions, ...deletedSessions])) {
      const operation = ownedSessions.has(sessionID) ? renewOwnership(sessionID) :
        observedSessions.has(sessionID) ? observeSession(sessionID) : acquireOwnership(sessionID)
      void operation.then(() => retryDeferredState(sessionID)).catch(() => log("error", "Loop lease heartbeat failed", { category: "state" }))
    }
  }, SESSION_LEASE_HEARTBEAT_MS)
  leaseHeartbeat.unref?.()

  return {
    async dispose() {
      disposed = true
      await Promise.all(ownershipQueues.values())
      clearInterval(leaseHeartbeat)
      for (const timer of timers.values()) clearTimeout(timer.handle)
      timers.clear()
      dynamicPending.clear()
      deferredDynamicSettlements.clear()
      deletedSessions.clear()
      await Promise.all(
        [...ownedSessions.values()].map((lease) => releaseSessionLease(lease.sessionID, instanceID, lease.revision)),
      )
      ownedSessions.clear()
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
          keep_alive: z.boolean().optional().describe(KEEP_ALIVE_DESCRIPTION),
        },
        async execute(args, context) {
          const input = args as { instruction: string; interval?: string; max_runs?: number; keep_alive?: boolean }
          await observeSession(context.sessionID)
          const dynamic = !input.interval?.trim()
          const loop = await createLoop(context.sessionID, {
            prompt: input.instruction,
            mode: dynamic ? "dynamic" : "interval",
            intervalMs: dynamic ? null : parseInterval(input.interval!, minIntervalSeconds),
            maxRuns: input.max_runs ?? null,
            agent: typeof context.agent === "string" ? context.agent : null,
            maxLoopsPerSession,
            keepAlive: input.keep_alive === true,
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
          await observeSession(context.sessionID)
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
      if (typeof agent === "string" && agent.trim()) lastPromptAgentBySession.set(sessionID, agent.trim())
      try {
        await observeSession(sessionID)
      } catch {
        // Passive hooks must never break normal dialogue: a transient state
        // lock failure is retried by the scheduler heartbeat.
        await log("error", "Loop session observation failed", { sessionID, category: "state" })
        return
      }
    },
    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return
      try {
        await observeSession(input.sessionID)
        const loops = await openLoops(input.sessionID)
        const reminder = systemReminder(loops)
        if (!reminder) return
        if (output.system.some((block) => block.includes(LOOP_SYSTEM_MARKER))) return
        if (output.system.length === 0) output.system.push(reminder)
        else output.system[0] = `${output.system[0]}\n\n${reminder}`
      } catch {
        await log("error", "Loop system reminder failed", { sessionID: input.sessionID, category: "state" })
      }
    },
    async "experimental.session.compacting"(input, output) {
      try {
        await observeSession(input.sessionID)
        const loops = await openLoops(input.sessionID)
        const context = compactionContext(loops)
        if (context) output.context.push(context)
      } catch {
        await log("error", "Loop compaction context failed", { sessionID: input.sessionID, category: "state" })
      }
    },
    async event({ event }) {
      const typed = event as { type?: string; properties?: Record<string, unknown> }
      const sessionID = sessionIDFromEvent(typed)
      if (!sessionID) return
      if (isBusyEvent(typed)) {
        busySessions.add(sessionID)
        for (const pending of dynamicPending.values()) {
          if (pending.sessionID === sessionID) pending.sawBusy = true
        }
      }
      if (isIdleEvent(typed)) {
        busySessions.delete(sessionID)
        rememberTerminalTurn(sessionID)
      }
      if (typed.type === "session.deleted") {
        deletedSessions.add(sessionID)
        busySessions.delete(sessionID)
        lastPromptAgentBySession.delete(sessionID)
      }
      try {
        await observeSession(sessionID)
        if (typed.type === "session.deleted") {
          await retryDeferredState(sessionID)
          return
        }
        if (isIdleEvent(typed)) {
          await settleDynamicLoops(sessionID)
          await runDueForSession(sessionID)
        }
      } catch {
        await log("error", "Loop event handling failed", { sessionID, category: "state" })
      }
    },
  }
}

function v2ObjectSchema(properties: Record<string, unknown>, required: string[] = []): ToolSchema.ValueSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as ToolSchema.ValueSchema
}

type V2EventLike = {
  type: string
  created: number
  data: Record<string, unknown>
}

function v2Log(level: "info" | "error", message: string, extra?: Record<string, unknown>) {
  try {
    const suffix = extra ? ` ${JSON.stringify(extra)}` : ""
    if (level === "info") console.info(`[opencode-loop-plugin] ${message}${suffix}`)
    else console.error(`[opencode-loop-plugin] ${message}${suffix}`)
  } catch {
    // Logging must never break plugin control flow.
  }
}

type LoopServices = {
  minIntervalSeconds: number
  maxLoopsPerSession: number
  dynamicMaxDelaySeconds: number
  observedSessions: Set<string>
  observeSession: (sessionID: string) => Promise<void>
  dynamicPending: Map<string, PendingDynamicTurn>
  scheduleTimer: (loop: LoopSnapshot) => void
  cancelTimer: (loopID: string) => void
  requireSessionLoop: (loopID: string, sessionID: string) => Promise<LoopSnapshot>
  acquireOwnership: (sessionID: string) => Promise<boolean>
}

async function setupV2(context: PluginV2.Plugin.Context): Promise<PluginV2.Plugin.Cleanup> {
  const abortController = new AbortController()
  const options = (context.options ?? {}) as Options
  const registerCommand = options.register_command ?? true
  const commandName = commandNameFromOptions(options)
  const minIntervalSeconds = positiveNumberOr(options.min_interval_seconds, DEFAULT_MIN_INTERVAL_SECONDS)
  const maxLoopsPerSession = positiveNumberOr(options.max_loops_per_session, DEFAULT_MAX_LOOPS_PER_SESSION)
  const busyBackoffMs = positiveNumberOr(options.busy_backoff_seconds, DEFAULT_BUSY_BACKOFF_SECONDS) * 1000
  const failureBackoffMs = positiveNumberOr(options.failure_backoff_seconds, DEFAULT_FAILURE_BACKOFF_SECONDS) * 1000
  const maxFailureBackoffMs = positiveNumberOr(options.max_failure_backoff_seconds, DEFAULT_MAX_FAILURE_BACKOFF_SECONDS) * 1000
  const maxConsecutiveFailures = positiveNumberOr(options.max_consecutive_failures, DEFAULT_MAX_CONSECUTIVE_FAILURES)
  const maxLoopAgeMs = nonNegativeNumberOr(options.max_loop_age_days, DEFAULT_MAX_LOOP_AGE_DAYS) * 24 * 60 * 60 * 1000
  const dynamicMaxDelaySeconds = positiveNumberOr(options.dynamic_max_delay_seconds, DEFAULT_DYNAMIC_MAX_DELAY_SECONDS)
  const restrictedAgents = restrictedAgentSet(options)
  const restartMode = dynamicRestartMode(options)
  const restartFallbackMs = dynamicRestartFallbackMs(options, minIntervalSeconds, dynamicMaxDelaySeconds)

  let disposed = false
  const timers = new Map<string, LoopTimer>()
  const sendingLoops = new Set<string>()
  const busySessions = new Set<string>()
  const deletedSessions = new Set<string>()
  const instanceID = randomUUID()
  const loopOwnerID = `server-v2:${process.pid}:${randomUUID()}`
  const ownedSessions = new Map<string, SessionLease>()
  const ownershipQueues = new Map<string, Promise<void>>()
  // Sessions this process has seen through events, prompts, or tool calls. Used
  // as an ownership proxy so a process sharing the state file with another
  // OpenCode instance does not mutate loops belonging to foreign sessions.
  const observedSessions = new Set<string>()
  const keepAliveSessions = new Set<string>()
  // Kept read-only until an event or hook establishes that this context owns
  // the session and the record is still the exact snapshot seen at startup.
  const staleDynamicCandidates = new Map<string, { sessionID: string; updatedAt: number }>()
  const lastPromptAgentBySession = new Map<string, string>()
  // Dynamic loops whose latest injected (or creating) turn has not yet gone idle:
  // if that turn ends without schedule_next_run or stop_loop, the loop ends.
  const dynamicPending = new Map<string, PendingDynamicTurn>()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  // A terminal event may precede delivery accounting. Retain the exact turn
  // so replaying that event cannot settle a newer iteration or a sibling.
  const deferredDynamicSettlements = new Map<string, PendingDynamicTurn>()
  const shuttingDownSessions = new Set<string>()

  const isRestrictedAgent = (agent: string | null | undefined) =>
    typeof agent === "string" && restrictedAgents.has(agent.trim().toLowerCase())

  const pendingIdleChecks = new Map<string, Promise<boolean>>()

  async function isSessionBusy(sessionID: string) {
    if (abortController.signal.aborted) return true
    let check = pendingIdleChecks.get(sessionID)
    if (!check) {
      // The stable adapter does not forward request-option signals. Reuse one
      // native wait per session while bounding our own scheduler's await.
      check = Promise.resolve().then(() => context.session.wait({ sessionID })).then(() => true, () => false)
      pendingIdleChecks.set(sessionID, check)
      const current = check
      void check.then(() => {
        if (pendingIdleChecks.get(sessionID) === current) pendingIdleChecks.delete(sessionID)
      })
    }
    const idle = await new Promise<boolean>((resolve) => {
      let finished = false
      const finish = (value: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        abortController.signal.removeEventListener("abort", aborted)
        resolve(value && !abortController.signal.aborted)
      }
      const aborted = () => finish(false)
      const timer = setTimeout(() => finish(false), 1000)
      abortController.signal.addEventListener("abort", aborted, { once: true })
      if (abortController.signal.aborted) finish(false)
      else void check.then(finish)
    })
    if (idle) busySessions.delete(sessionID)
    return !idle
  }

  function cancelTimer(loopID: string) {
    const timer = timers.get(loopID)
    if (timer) clearTimeout(timer.handle)
    timers.delete(loopID)
  }

  async function loseOwnership(sessionID: string) {
    ownedSessions.delete(sessionID)
    for (const loop of await activeLoops(sessionID)) cancelTimer(loop.id)
    for (const [loopID, pending] of dynamicPending) {
      if (pending.sessionID === sessionID) dynamicPending.delete(loopID)
    }
  }

  async function keepAliveSessionAvailable(sessionID: string) {
    try {
      const session = await context.session.get({ sessionID })
      const location = context.location
      return session.id === sessionID && (!location ||
        (session.location.directory === location.directory && session.projectID === location.project.id))
    } catch {
      return false
    }
  }

  async function reconcileTimers(sessionID: string) {
    for (const loop of await activeLoops(sessionID)) {
      const timer = timers.get(loop.id)
      if (!sendingLoops.has(loop.id) && (!timer || timer.nextRunAt !== loop.nextRunAt)) scheduleTimer(loop)
    }
  }

  async function acquireOwnership(sessionID: string) {
    return enqueueSessionOperation(ownershipQueues, sessionID, async () => {
      if (disposed) return false
      if (!observedSessions.has(sessionID) && !(await keepAliveSessionAvailable(sessionID))) return false
      const current = ownedSessions.get(sessionID)
      if (current && current.expiresAt > Date.now() + SESSION_LEASE_HEARTBEAT_MS &&
        await ownsSessionLease(sessionID, instanceID, current.revision)) {
        await reconcileTimers(sessionID)
        return true
      }
      const lease = await acquireSessionLease(sessionID, instanceID, SESSION_LEASE_MS)
      if (!lease) {
        await loseOwnership(sessionID)
        return false
      }
      ownedSessions.set(sessionID, lease)
      await reconcileTimers(sessionID)
      return true
    })
  }

  async function renewOwnership(sessionID: string) {
    return enqueueSessionOperation(ownershipQueues, sessionID, async () => {
      if (disposed) return false
      const lease = ownedSessions.get(sessionID)
      if (!lease) return false
      const renewed = await renewSessionLease(sessionID, instanceID, lease.revision, SESSION_LEASE_MS, true)
      if (!renewed) {
        await loseOwnership(sessionID)
        return false
      }
      ownedSessions.set(sessionID, renewed)
      await reconcileTimers(sessionID)
      return true
    })
  }

  function scheduleTimer(loop: LoopSnapshot, minimumDelayMs = 0) {
    cancelTimer(loop.id)
    if (disposed || loop.status !== "active" || loop.nextRunAt == null || deletedSessions.has(loop.sessionID) || !ownedSessions.has(loop.sessionID) ||
      shuttingDownSessions.has(loop.sessionID) ||
      (!observedSessions.has(loop.sessionID) && !loop.keepAlive)) return
    const delay = Math.max(minimumDelayMs, loop.nextRunAt - Date.now())
    const timer = setTimeout(() => {
      timers.delete(loop.id)
      void runDue(loop.id)
    }, delay)
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    timers.set(loop.id, { handle: timer, nextRunAt: loop.nextRunAt })
  }

  async function runDue(loopID: string) {
    if (sendingLoops.has(loopID)) return
    sendingLoops.add(loopID)
    try {
      await runDueLocked(loopID)
    } catch {
      v2Log("error", "Loop scheduler operation failed", { loopID, category: "scheduler" })
    } finally {
      sendingLoops.delete(loopID)
      const pending = deferredDynamicSettlements.get(loopID)
      if (pending && !disposed) {
        await settleDynamicLoop(loopID, pending).catch(() =>
          v2Log("error", "Dynamic loop settlement failed", { loopID, category: "scheduler" }),
        )
      }
    }
  }

  async function runDueLocked(loopID: string) {
    let loop = await getLoop(loopID)
    if (!loop || loop.status !== "active" || loop.nextRunAt == null || (shuttingDownSessions.has(loop.sessionID) || deletedSessions.has(loop.sessionID))) return
    if (!(await renewOwnership(loop.sessionID))) return
    const lease = ownedSessions.get(loop.sessionID)
    if (!lease || !(await ownsSessionLease(loop.sessionID, instanceID, lease.revision))) {
      await loseOwnership(loop.sessionID)
      return
    }
    if (loop.nextRunAt > Date.now()) {
      scheduleTimer(loop)
      return
    }
    if (!observedSessions.has(loop.sessionID) && !loop.keepAlive) {
      // Keep a bounded polling timer while ownership is unknown. The loop stays
      // untouched on disk, but can run after any later event or tool call makes
      // this process the observed owner of its session.
      scheduleTimer(loop, Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      v2Log("info", "Skipping loop because session ownership is unknown", { loopID, category: "ownership" })
      return
    }
    const owner = await acquireLoopOwner(loopID, loopOwnerID, RUN_CLAIM_LEASE_MS, lease)
    const claimed = owner ? await claimDueRunOwned(loopID, owner, RUN_CLAIM_LEASE_MS) : null
    if (!claimed) {
      loop = await getLoop(loopID)
      if (loop) scheduleTimer(loop)
      return
    }
    loop = claimed.loop
    if (!loop.keepAlive && maxLoopAgeMs > 0 && Date.now() - loop.createdAt >= maxLoopAgeMs) {
      await stopLoopClaimed(loopID, claimed, `expired after ${Math.round(maxLoopAgeMs / 86_400_000)} days`)
      return
    }
    if (await isSessionBusy(loop.sessionID)) {
      const deferred = await recordRunDeferredClaimed(loopID, claimed, "skipped_busy", Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      if (deferred) scheduleTimer(deferred)
      return
    }
    if (isRestrictedAgent(lastPromptAgentBySession.get(loop.sessionID))) {
      const deferred = await recordRunDeferredClaimed(loopID, claimed, "skipped_plan", Math.min(loop.intervalMs ?? busyBackoffMs, busyBackoffMs))
      if (deferred) scheduleTimer(deferred)
      return
    }
    const injectionLease = ownedSessions.get(loop.sessionID)
    if (!injectionLease || !(await ownsSessionLease(loop.sessionID, instanceID, injectionLease.revision))) {
      await loseOwnership(loop.sessionID)
      return
    }
    // Register before injecting: the injected turn's busy event can arrive while
    // recordRunSent is still awaiting, and a flip missed there would leave the
    // loop as an unsettleable zombie. sawBusy stays false until that busy event
    // arrives, so a stale idle event from the previous turn cannot settle early.
    if (loop.mode === "dynamic") {
      dynamicPending.set(loopID, { sessionID: loop.sessionID, sawBusy: false })
    }
    if (!(await confirmRunClaim(loopID, claimed)) || disposed || shuttingDownSessions.has(loop.sessionID) || deletedSessions.has(loop.sessionID)) {
      dynamicPending.delete(loopID)
      const current = await getLoop(loopID)
      if (current) scheduleTimer(current)
      return
    }
    try {
      await context.session.prompt({
        sessionID: loop.sessionID,
        text: iterationPrompt(loop),
        ...(loop.agent ? { agents: [{ name: loop.agent }] } : {}),
      })
    } catch (error) {
      dynamicPending.delete(loopID)
      await acquireLoopOwner(loopID, loopOwnerID, RUN_CLAIM_LEASE_MS, lease)
      const failed = await recordRunFailedClaimed(
        loopID,
        claimed,
        error instanceof Error ? error.message : String(error),
        failureBackoffMs,
        maxConsecutiveFailures,
        maxFailureBackoffMs,
      )
      if (failed) scheduleTimer(failed)
      else {
        const current = await getLoop(loopID)
        if (current) scheduleTimer(current)
      }
      v2Log("error", "Loop iteration prompt failed", { loopID, error: failed?.lastError ?? undefined })
      return
    }
    busySessions.add(loop.sessionID)
    observedSessions.add(loop.sessionID)
    await acquireLoopOwner(loopID, loopOwnerID, RUN_CLAIM_LEASE_MS, lease)
    const sent = await recordRunSentClaimed(loopID, claimed)
    if (!sent) {
      const current = await getLoop(loopID)
      if (current) scheduleTimer(current)
      return
    }
    if (sent.mode !== "dynamic" || sent.status !== "active") dynamicPending.delete(loopID)
    scheduleTimer(sent)
  }

  async function runDueForSession(sessionID: string) {
    if (shuttingDownSessions.has(sessionID)) return
    const loops = await activeLoops(sessionID)
    const now = Date.now()
    for (const loop of loops) {
      if (loop.nextRunAt == null || loop.nextRunAt > now) continue
      await runDue(loop.id)
      // Injecting one iteration makes the session busy; later due loops defer via their timers.
      if (busySessions.has(sessionID)) break
    }
  }

  async function settleDynamicLoop(loopID: string, pending: PendingDynamicTurn) {
    if (shuttingDownSessions.has(pending.sessionID)) return
    if (dynamicPending.get(loopID) !== pending || !pending.sawBusy) {
      if (deferredDynamicSettlements.get(loopID) === pending) deferredDynamicSettlements.delete(loopID)
      return
    }
    const lease = ownedSessions.get(pending.sessionID)
    if (!lease) return
    deferredDynamicSettlements.set(loopID, pending)
    if (sendingLoops.has(loopID)) return
    const loop = await getLoop(loopID)
    if (dynamicPending.get(loopID) !== pending) {
      if (deferredDynamicSettlements.get(loopID) === pending) deferredDynamicSettlements.delete(loopID)
      return
    }
    if (sendingLoops.has(loopID) || shuttingDownSessions.has(pending.sessionID)) return
    if (loop?.status === "active" && loop.mode === "dynamic" && loop.nextRunAt == null) {
      const stopped = await stopLoopIfUnchanged(
        loopID, loop.updatedAt, "the iteration ended without scheduling the next run", lease, loop.scheduleRevision,
      )
      if (!stopped) return
    }
    if (dynamicPending.get(loopID) === pending) dynamicPending.delete(loopID)
    if (deferredDynamicSettlements.get(loopID) === pending) deferredDynamicSettlements.delete(loopID)
  }

  function rememberTerminalTurn(sessionID: string) {
    for (const [loopID, pending] of dynamicPending) {
      if (pending.sessionID === sessionID && pending.sawBusy) deferredDynamicSettlements.set(loopID, pending)
    }
  }

  async function settleDynamicLoops(sessionID: string) {
    for (const [loopID, pending] of dynamicPending) {
      if (pending.sessionID === sessionID) await settleDynamicLoop(loopID, pending)
    }
  }

  async function retryDeferredState(sessionID: string) {
    if (deletedSessions.has(sessionID)) {
      for (const loop of await stopLoopsForSession(sessionID, "session deleted")) {
        cancelTimer(loop.id)
        dynamicPending.delete(loop.id)
        deferredDynamicSettlements.delete(loop.id)
      }
      deletedSessions.delete(sessionID)
      observedSessions.delete(sessionID)
      keepAliveSessions.delete(sessionID)
      return
    }
    for (const [loopID, pending] of deferredDynamicSettlements) {
      if (pending.sessionID === sessionID) await settleDynamicLoop(loopID, pending)
    }
  }

  async function rehydrate() {
    const loops = await activeLoops()
    for (const loop of loops) {
      if (loop.keepAlive) keepAliveSessions.add(loop.sessionID)
      if (loop.nextRunAt == null) {
        if (loop.mode === "dynamic") {
          staleDynamicCandidates.set(loop.id, { sessionID: loop.sessionID, updatedAt: loop.updatedAt })
          v2Log("info", "Dynamic loop is an orphaned/stale restart candidate pending session ownership", {
            loopID: loop.id,
            sessionID: loop.sessionID,
          })
        }
        continue
      }
    }
    for (const sessionID of keepAliveSessions) await acquireOwnership(sessionID)
  }

  async function observeSession(sessionID: string) {
    observedSessions.add(sessionID)
    if (!(await acquireOwnership(sessionID))) return
    const wasDeleted = deletedSessions.has(sessionID)
    await retryDeferredState(sessionID)
    if (wasDeleted) return
    const lease = ownedSessions.get(sessionID)
    if (!lease) return
    for (const [loopID, candidate] of staleDynamicCandidates) {
      if (candidate.sessionID !== sessionID) continue
      if (restartMode === "fallback") {
        const rescheduled = await rescheduleDynamicIfUnchanged(
          loopID, candidate.updatedAt, restartFallbackMs, "restarted with fallback delay; reschedule or stop after this iteration", lease,
        )
        if (rescheduled) {
          scheduleTimer(rescheduled)
          v2Log("info", "Dynamic loop resumed with fallback delay after restart", {
            loopID,
            sessionID,
          })
        }
      } else {
        await stopLoopIfUnchanged(
          loopID, candidate.updatedAt, "not rescheduled before OpenCode restarted", lease,
        )
      }
      staleDynamicCandidates.delete(loopID)
    }
  }

  async function requireSessionLoop(loopID: string, sessionID: string) {
    await observeSession(sessionID)
    const loop = await getLoop(loopID)
    if (!loop) throw new Error(`no loop found with id "${loopID}"`)
    if (loop.sessionID !== sessionID) throw new Error(`loop "${loopID}" belongs to a different session`)
    return loop
  }

  function markExecutionStarted(sessionID: string) {
    busySessions.add(sessionID)
    for (const pending of dynamicPending.values()) {
      if (pending.sessionID === sessionID) pending.sawBusy = true
    }
  }

  async function handleV2Event(event: V2EventLike) {
    const data = event.data
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return
    if (event.type === "session.execution.interrupted" && data.reason === "shutdown") {
      // Do this before observation can acquire a lease and arm due timers.
      shuttingDownSessions.add(sessionID)
      for (const loop of await activeLoops(sessionID)) cancelTimer(loop.id)
      return
    }
    const terminal = event.type === "session.idle" || event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" || event.type === "session.execution.interrupted" ||
      (event.type === "session.status" && isRecord(data.status) && data.status.type === "idle")
    if (terminal) {
      busySessions.delete(sessionID)
      rememberTerminalTurn(sessionID)
    }
    if (event.type === "session.deleted") {
      deletedSessions.add(sessionID)
      busySessions.delete(sessionID)
      lastPromptAgentBySession.delete(sessionID)
    }
    if (event.type === "session.execution.started") {
      shuttingDownSessions.delete(sessionID)
      markExecutionStarted(sessionID)
    }
    if ((event.type === "session.agent.selected" || event.type === "session.step.started") && typeof data.agent === "string") {
      lastPromptAgentBySession.set(sessionID, data.agent)
    }
    if (event.type === "session.status" && isRecord(data.status) && data.status.type === "busy") markExecutionStarted(sessionID)
    await observeSession(sessionID)
    switch (event.type) {
      case "session.execution.started": {
        markExecutionStarted(sessionID)
        return
      }
      case "session.status": {
        const status = data.status
        if (isRecord(status) && typeof status.type === "string") {
          if (status.type === "busy") {
            markExecutionStarted(sessionID)
          }
          if (status.type === "idle") {
            busySessions.delete(sessionID)
            await settleDynamicLoops(sessionID)
            await runDueForSession(sessionID)
          }
        }
        return
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle": {
        busySessions.delete(sessionID)
        await settleDynamicLoops(sessionID)
        await runDueForSession(sessionID)
        return
      }
      case "session.deleted": {
        await retryDeferredState(sessionID)
        return
      }
      case "session.agent.selected": {
        if (typeof data.agent === "string") lastPromptAgentBySession.set(sessionID, data.agent)
        return
      }
      case "session.step.started": {
        if (typeof data.agent === "string") lastPromptAgentBySession.set(sessionID, data.agent)
        return
      }
    }
  }

  const services: LoopServices = {
    minIntervalSeconds,
    maxLoopsPerSession,
    dynamicMaxDelaySeconds,
    observedSessions,
    observeSession,
    dynamicPending,
    scheduleTimer,
    cancelTimer,
    requireSessionLoop,
    acquireOwnership,
  }

  if (registerCommand) {
    registrations.push(
      await context.command.transform((draft) => {
        draft.add({
          name: commandName,
          description: "Run an instruction on a recurring interval while this session is idle",
          execute: async (input) => {
            const stripMention = <T extends { mention?: unknown }>({ mention: _mention, ...attachment }: T) => attachment
            await context.session.prompt({
              ...input.prompt,
              files: input.prompt.files?.map(stripMention),
              agents: input.prompt.agents?.map(stripMention),
              skills: input.prompt.skills?.map(stripMention),
              sessionID: input.sessionID,
              text: loopCommandTemplate(commandName, minIntervalSeconds).replaceAll(
                "$ARGUMENTS",
                () => input.prompt.text.trim(),
              ),
              delivery: input.delivery,
            })
          },
        })
      }),
    )
  }

  registrations.push(
    await context.tool.transform((draft) => {
      for (const tool of loopToolsV2(services)) draft.add(tool)
    }),
  )

  registrations.push(
    await context.session.hook("context", async (sessionContext) => {
      try {
        await observeSession(sessionContext.sessionID)
        const loops = await openLoops(sessionContext.sessionID)
        const reminder = systemReminder(loops)
        if (!reminder) return
        if (sessionContext.system.some((part) => part.type === "text" && part.text.includes(LOOP_SYSTEM_MARKER))) return
        sessionContext.system.push({ type: "text", text: reminder })
      } catch {
        // Passive hooks must never break normal dialogue; the scheduler
        // heartbeat retries the observation.
        v2Log("error", "Loop context hook failed", { sessionID: sessionContext.sessionID, category: "state" })
      }
    }),
  )

  registrations.push(
    await context.session.hook("compaction", async (sessionCompaction) => {
      try {
        await observeSession(sessionCompaction.sessionID)
        const loops = await openLoops(sessionCompaction.sessionID)
        const contextText = compactionContext(loops)
        if (!contextText) return
        if (sessionCompaction.system.some((part) => part.type === "text" && part.text.includes("OpenCode loop mode is tracking recurring loops for this session across compaction."))) return
        sessionCompaction.system.push({ type: "text", text: contextText })
      } catch {
        v2Log("error", "Loop compaction hook failed", { sessionID: sessionCompaction.sessionID, category: "state" })
      }
    }),
  )

  await rehydrate().catch(() => v2Log("error", "Failed to rehydrate loops", { category: "state" }))
  const leaseHeartbeat = setInterval(() => {
    for (const sessionID of new Set([...observedSessions, ...keepAliveSessions, ...deletedSessions])) {
      const operation = ownedSessions.has(sessionID) ? renewOwnership(sessionID) :
        observedSessions.has(sessionID) ? observeSession(sessionID) : acquireOwnership(sessionID)
      void operation.then(() => retryDeferredState(sessionID)).catch(() => v2Log("error", "Loop lease heartbeat failed", { category: "state" }))
    }
  }, SESSION_LEASE_HEARTBEAT_MS)
  leaseHeartbeat.unref?.()

  let eventIterator: AsyncIterator<unknown> | undefined
  const consumer = (async () => {
    const subscription = context.event.subscribe({ signal: abortController.signal })
    const iterator = subscription[Symbol.asyncIterator]()
    eventIterator = iterator
    try {
      while (true) {
        const { done, value } = await iterator.next()
        if (done) break
        try {
          await handleV2Event(value as V2EventLike)
        } catch {
          // One bad event must not kill the consumer: that would silently
          // disable all future event-driven scheduling until process restart.
          v2Log("error", "V2 event handling failed", { category: "event" })
        }
      }
    } catch {
      if (!abortController.signal.aborted) v2Log("error", "V2 event consumer stopped", { category: "event" })
    }
  })()

  return async () => {
    disposed = true
    await Promise.all(ownershipQueues.values())
    clearInterval(leaseHeartbeat)
    abortController.abort()
    pendingIdleChecks.clear()
    for (const timer of timers.values()) clearTimeout(timer.handle)
    timers.clear()
    dynamicPending.clear()
    deferredDynamicSettlements.clear()
    shuttingDownSessions.clear()
    deletedSessions.clear()
    sendingLoops.clear()
    await Promise.all(
      [...ownedSessions.values()].map((lease) => releaseSessionLease(lease.sessionID, instanceID, lease.revision)),
    )
    ownedSessions.clear()
    for (const registration of registrations) await registration.dispose()
    // Best-effort termination of the event consumer. Never block plugin
    // unload on a stream that does not close promptly.
    const termination = Promise.allSettled([consumer, eventIterator?.return?.()])
    await Promise.race([termination, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
}

function loopToolsV2(services: LoopServices): ToolV2Info[] {
  return [
    {
      name: "create_loop",
      description:
        "Create a recurring loop for this session only when explicitly requested (for example via the /loop command). The scheduler re-injects the instruction while the session is idle. Pass interval for fixed cadence (like \"10m\"); omit it for a dynamic loop where the agent schedules each next run with schedule_next_run.",
      input: v2ObjectSchema(
        {
          instruction: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PROMPT_CHARS,
            description: "The instruction to perform on each iteration.",
          },
          interval: {
            type: "string",
            description: 'Fixed cadence like "30s", "10m", "2h", or "1d". Omit for a dynamically paced loop.',
          },
          max_runs: {
            type: "integer",
            minimum: 1,
            description: "Optional maximum number of iterations before the loop completes.",
          },
          keep_alive: {
            type: "boolean",
            description: KEEP_ALIVE_DESCRIPTION,
          },
        },
        ["instruction"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => {
        const input = args as { instruction: string; interval?: string; max_runs?: number; keep_alive?: boolean }
        await services.observeSession(toolContext.sessionID)
        const dynamic = !input.interval?.trim()
        const loop = await createLoop(toolContext.sessionID, {
          prompt: input.instruction,
          mode: dynamic ? "dynamic" : "interval",
          intervalMs: dynamic ? null : parseInterval(input.interval!, services.minIntervalSeconds),
          maxRuns: input.max_runs ?? null,
          agent: typeof toolContext.agent === "string" ? toolContext.agent : null,
          maxLoopsPerSession: services.maxLoopsPerSession,
          keepAlive: input.keep_alive === true,
        })
        if (loop.mode === "dynamic") {
          services.dynamicPending.set(loop.id, { sessionID: loop.sessionID, sawBusy: true })
        } else {
          services.scheduleTimer(loop)
        }
        return { content: await toolResult(toolContext.sessionID, { created: loop.id, loop }) }
      },
    },
    {
      name: "list_loops",
      description: "List the loops for this OpenCode session, including status, cadence, run counts, and next scheduled run.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        return { content: await toolResult(toolContext.sessionID) }
      },
    },
    {
      name: "stop_loop",
      description:
        "Stop a loop in this session. Call this when the loop's purpose has been achieved, it became obsolete, or the user asked to stop it.",
      input: v2ObjectSchema(
        {
          loop_id: { type: "string", minLength: 1, description: "The loop id, like loop_7k3p9." },
          reason: { type: "string", maxLength: 400, description: "Short reason the loop is stopping." },
        },
        ["loop_id"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => {
        const input = args as { loop_id: string; reason?: string }
        await services.requireSessionLoop(input.loop_id, toolContext.sessionID)
        const loop = await stopLoop(input.loop_id, input.reason ?? null)
        services.cancelTimer(loop.id)
        services.dynamicPending.delete(loop.id)
        return { content: await toolResult(toolContext.sessionID, { stopped: loop.id }) }
      },
    },
    {
      name: "pause_loop",
      description: "Pause an active loop in this session without deleting it. Paused loops do not run until resumed.",
      input: v2ObjectSchema(
        {
          loop_id: { type: "string", minLength: 1, description: "The loop id, like loop_7k3p9." },
        },
        ["loop_id"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => {
        const input = args as { loop_id: string }
        await services.requireSessionLoop(input.loop_id, toolContext.sessionID)
        const loop = await pauseLoop(input.loop_id)
        services.cancelTimer(loop.id)
        services.dynamicPending.delete(loop.id)
        return { content: await toolResult(toolContext.sessionID, { paused: loop.id }) }
      },
    },
    {
      name: "resume_loop",
      description: "Resume a paused loop in this session. Interval loops schedule their next run one interval from now.",
      input: v2ObjectSchema(
        {
          loop_id: { type: "string", minLength: 1, description: "The loop id, like loop_7k3p9." },
        },
        ["loop_id"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => {
        const input = args as { loop_id: string }
        await services.requireSessionLoop(input.loop_id, toolContext.sessionID)
        const loop = await resumeLoop(input.loop_id)
        services.scheduleTimer(loop)
        return { content: await toolResult(toolContext.sessionID, { resumed: loop.id }) }
      },
    },
    {
      name: "run_loop",
      description: "Force an immediate iteration of a loop in this session. The iteration runs as soon as the session is idle.",
      input: v2ObjectSchema(
        {
          loop_id: { type: "string", minLength: 1, description: "The loop id, like loop_7k3p9." },
        },
        ["loop_id"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => {
        const input = args as { loop_id: string }
        await services.requireSessionLoop(input.loop_id, toolContext.sessionID)
        const loop = await scheduleNextRun(input.loop_id, 1, "manual run requested")
        services.scheduleTimer(loop)
        return {
          content: await toolResult(toolContext.sessionID, {
            queued: loop.id,
            note: "The iteration will run as soon as the session is idle.",
          }),
        }
      },
    },
    {
      name: "schedule_next_run",
      description:
        "Schedule the next iteration of a dynamically paced loop in this session. Call this before ending a dynamic loop iteration to keep the loop alive; omit it (or call stop_loop) to end the loop.",
      input: v2ObjectSchema(
        {
          loop_id: { type: "string", minLength: 1, description: "The loop id, like loop_7k3p9." },
          delay_seconds: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Seconds from now until the next iteration.",
          },
          reason: { type: "string", maxLength: 400, description: "One short sentence on why this delay was chosen." },
        },
        ["loop_id", "delay_seconds", "reason"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => {
        const input = args as { loop_id: string; delay_seconds: number; reason: string }
        const target = await services.requireSessionLoop(input.loop_id, toolContext.sessionID)
        if (target.mode !== "dynamic") {
          throw new Error(`loop "${input.loop_id}" has a fixed interval; only dynamically paced loops use schedule_next_run`)
        }
        const clamped = Math.min(Math.max(input.delay_seconds, services.minIntervalSeconds), services.dynamicMaxDelaySeconds)
        const loop = await scheduleNextRun(input.loop_id, clamped * 1000, input.reason)
        services.dynamicPending.delete(loop.id)
        services.scheduleTimer(loop)
        return {
          content: await toolResult(toolContext.sessionID, {
            scheduled: loop.id,
            next_run_at: loop.nextRunAt,
            clamped_delay_seconds: clamped,
            was_clamped: clamped !== input.delay_seconds,
          }),
        }
      },
    },
    {
      name: "clear_loops",
      description: "Delete stopped and completed loops for this session. Active and paused loops are kept.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        await services.observeSession(toolContext.sessionID)
        const cleared = await clearClosedLoops(toolContext.sessionID)
        return { content: await toolResult(toolContext.sessionID, { cleared }) }
      },
    },
  ]
}

export default {
  id: "local.loop-mode.server",
  server,
  setup: setupV2,
}
