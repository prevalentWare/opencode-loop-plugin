import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Data, Effect, Schema } from "effect"

export type LoopStatus = "active" | "paused" | "stopped" | "completed"
export type LoopMode = "interval" | "dynamic"
export type LoopRunResult = "sent" | "skipped_busy" | "skipped_plan" | "failed"

export type CreateLoopOptions = {
  prompt: string
  intervalMs?: number | null
  mode?: LoopMode
  maxRuns?: number | null
  agent?: string | null
  maxLoopsPerSession?: number | null
}

export type Loop = {
  id: string
  sessionID: string
  prompt: string
  mode: LoopMode
  intervalMs: number | null
  status: LoopStatus
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastResult: LoopRunResult | null
  lastError: string | null
  lastReason: string | null
  runCount: number
  maxRuns: number | null
  agent: string | null
  stopReason: string | null
}

type State = {
  version: 1
  loops: Record<string, Loop>
}

class StateReadError extends Data.TaggedError("StateReadError")<{
  readonly cause: unknown
}> {}

class StateDecodeError extends Data.TaggedError("StateDecodeError")<{
  readonly cause: unknown
}> {}

class StateWriteError extends Data.TaggedError("StateWriteError")<{
  readonly cause: unknown
}> {}

export const DEFAULT_MIN_INTERVAL_SECONDS = 30
export const DEFAULT_MAX_LOOPS_PER_SESSION = 5
export const MAX_PROMPT_CHARS = 4000
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)
const LoopSchema = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  prompt: Schema.String,
  mode: Schema.optionalWith(Schema.Literal("interval", "dynamic"), { default: () => "interval" as const }),
  intervalMs: NullableNumber,
  status: Schema.Literal("active", "paused", "stopped", "completed"),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  nextRunAt: NullableNumber,
  lastRunAt: Schema.optionalWith(NullableNumber, { default: () => null }),
  lastResult: Schema.optionalWith(Schema.NullOr(Schema.Literal("sent", "skipped_busy", "skipped_plan", "failed")), {
    default: () => null,
  }),
  lastError: Schema.optionalWith(NullableString, { default: () => null }),
  lastReason: Schema.optionalWith(NullableString, { default: () => null }),
  runCount: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  maxRuns: Schema.optionalWith(NullableNumber, { default: () => null }),
  agent: Schema.optionalWith(NullableString, { default: () => null }),
  stopReason: Schema.optionalWith(NullableString, { default: () => null }),
})
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  loops: Schema.Record({ key: Schema.String, value: LoopSchema }),
})

export type LoopSnapshot = Loop & {
  sampledAt: number
}

function defaultStateFile() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  return join(dataHome, "opencode-loop-plugin", "loops.json")
}

export function statePath() {
  return process.env.OPENCODE_LOOP_STATE_PATH || defaultStateFile()
}

function now() {
  return Date.now()
}

function emptyState(): State {
  return { version: 1, loops: {} }
}

function isMissingStateFile(error: unknown) {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function mutableState(state: Schema.Schema.Type<typeof StateSchema>): State {
  return JSON.parse(JSON.stringify(state)) as State
}

function decodeState(value: unknown) {
  return Schema.decodeUnknown(StateSchema)(value).pipe(
    Effect.map(mutableState),
    Effect.mapError((cause) => new StateDecodeError({ cause })),
  )
}

function readStateEffect() {
  return Effect.tryPromise({
    try: () => readFile(statePath(), "utf8"),
    catch: (cause) => new StateReadError({ cause }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => new StateDecodeError({ cause }),
      }),
    ),
    Effect.flatMap(decodeState),
    Effect.catchAll((error) =>
      error._tag === "StateReadError" && isMissingStateFile(error.cause) ? Effect.succeed(emptyState()) : Effect.fail(error),
    ),
  )
}

function writeStateEffect(state: State) {
  return Effect.tryPromise({
    try: async () => {
      const file = statePath()
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
      await rename(tmp, file)
      await chmod(file, 0o600).catch(() => undefined)
    },
    catch: (cause) => new StateWriteError({ cause }),
  })
}

async function readState(): Promise<State> {
  return Effect.runPromise(readStateEffect())
}

let mutationQueue: Promise<void> = Promise.resolve()

function enqueueMutation<T>(operation: () => Promise<T>) {
  const current = mutationQueue.then(operation, operation)
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  )
  return current
}

const MAX_MUTATION_ATTEMPTS = 5

async function readRawState() {
  try {
    return await readFile(statePath(), "utf8")
  } catch (error) {
    if (isMissingStateFile(error)) return null
    throw error
  }
}

async function mutate<T>(fn: (state: State) => T | Promise<T>) {
  // The promise queue serializes mutations within this process; the raw-content
  // compare before writing detects concurrent writers in other OpenCode
  // processes sharing the state file and retries on top of their changes.
  return enqueueMutation(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const before = await readRawState()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const state =
            before == null
              ? emptyState()
              : yield* Effect.try({
                  try: () => JSON.parse(before) as unknown,
                  catch: (cause) => new StateDecodeError({ cause }),
                }).pipe(Effect.flatMap(decodeState))
          const value = yield* Effect.tryPromise({
            try: () => Promise.resolve(fn(state)),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          })
          return { state, value }
        }),
      )
      const current = await readRawState()
      if (current !== before) {
        lastError = new Error("state file changed by a concurrent writer")
        continue
      }
      await Effect.runPromise(writeStateEffect(result.state))
      return result.value
    }
    throw lastError instanceof Error ? lastError : new Error("state mutation failed after concurrent-writer retries")
  })
}

const INTERVAL_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

export function parseInterval(text: string, minSeconds = DEFAULT_MIN_INTERVAL_SECONDS) {
  const match = INTERVAL_PATTERN.exec(text.trim())
  if (!match) {
    throw new Error(`invalid interval "${text}"; use a number followed by s, m, h, or d (for example "30s", "10m", "1h", "1d")`)
  }
  const amount = Number(match[1])
  const unit = match[2]!.charAt(0).toLowerCase()
  const ms = Math.round(amount * UNIT_MS[unit]!)
  const minMs = Math.max(0, minSeconds) * 1000
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid interval "${text}"; the amount must be greater than zero`)
  if (ms < minMs) throw new Error(`interval "${text}" is below the minimum of ${minSeconds} seconds`)
  if (ms > MAX_INTERVAL_MS) throw new Error(`interval "${text}" is above the maximum of 7 days`)
  return ms
}

export function formatInterval(ms: number | null) {
  if (ms == null) return "dynamic"
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1000, "s"],
  ]
  for (const [size, suffix] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${suffix}`
  }
  return `${Math.round(ms / 1000)}s`
}

export function generateLoopID() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  let suffix = ""
  for (let index = 0; index < 5; index += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `loop_${suffix}`
}

export function validatePrompt(prompt: string) {
  const value = prompt.trim()
  if (!value) throw new Error("loop instruction must not be empty")
  if ([...value].length > MAX_PROMPT_CHARS) throw new Error(`loop instruction must be at most ${MAX_PROMPT_CHARS} characters`)
  return value
}

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isOpen(status: LoopStatus) {
  return status === "active" || status === "paused"
}

export function snapshot(loop: Loop): LoopSnapshot {
  return { ...loop, sampledAt: now() }
}

function requireLoop(state: State, loopID: string) {
  const loop = state.loops[loopID]
  if (!loop) throw new Error(`no loop found with id "${loopID}"`)
  return loop
}

export async function createLoop(sessionID: string, options: CreateLoopOptions) {
  const prompt = validatePrompt(options.prompt)
  const mode: LoopMode = options.mode === "dynamic" ? "dynamic" : "interval"
  const intervalMs = mode === "interval" ? positiveIntegerOrNull(options.intervalMs) : null
  if (mode === "interval" && intervalMs == null) throw new Error("interval loops require a positive interval")
  const maxRuns = positiveIntegerOrNull(options.maxRuns)
  const maxLoops = positiveIntegerOrNull(options.maxLoopsPerSession) ?? DEFAULT_MAX_LOOPS_PER_SESSION
  const agent = typeof options.agent === "string" && options.agent.trim() ? options.agent.trim() : null
  return mutate((state) => {
    const open = Object.values(state.loops).filter((loop) => loop.sessionID === sessionID && isOpen(loop.status))
    if (open.length >= maxLoops) {
      throw new Error(`this session already has ${open.length} open loop(s); stop one before creating another (limit ${maxLoops})`)
    }
    let id = generateLoopID()
    while (state.loops[id]) id = generateLoopID()
    const timestamp = now()
    const loop: Loop = {
      id,
      sessionID,
      prompt,
      mode,
      intervalMs,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: mode === "interval" ? timestamp + intervalMs! : null,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      lastReason: null,
      runCount: 0,
      maxRuns,
      agent,
      stopReason: null,
    }
    state.loops[id] = loop
    return snapshot(loop)
  })
}

export async function getLoop(loopID: string) {
  const state = await readState()
  const loop = state.loops[loopID]
  return loop ? snapshot(loop) : null
}

export async function listLoops(sessionID?: string) {
  const state = await readState()
  return Object.values(state.loops)
    .filter((loop) => sessionID == null || loop.sessionID === sessionID)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(snapshot)
}

export async function openLoops(sessionID?: string) {
  const loops = await listLoops(sessionID)
  return loops.filter((loop) => isOpen(loop.status))
}

export async function activeLoops(sessionID?: string) {
  const loops = await listLoops(sessionID)
  return loops.filter((loop) => loop.status === "active")
}

export async function pauseLoop(loopID: string) {
  return mutate((state) => {
    const loop = requireLoop(state, loopID)
    if (loop.status !== "active") throw new Error(`loop "${loopID}" is ${loop.status}; only active loops can be paused`)
    loop.status = "paused"
    loop.nextRunAt = null
    loop.stopReason = "paused"
    loop.updatedAt = now()
    return snapshot(loop)
  })
}

export async function resumeLoop(loopID: string) {
  return mutate((state) => {
    const loop = requireLoop(state, loopID)
    if (loop.status !== "paused") throw new Error(`loop "${loopID}" is ${loop.status}; only paused loops can be resumed`)
    const timestamp = now()
    loop.status = "active"
    loop.stopReason = null
    loop.nextRunAt = loop.mode === "interval" ? timestamp + loop.intervalMs! : timestamp
    loop.updatedAt = timestamp
    return snapshot(loop)
  })
}

export async function stopLoop(loopID: string, reason?: string | null) {
  return mutate((state) => {
    const loop = requireLoop(state, loopID)
    if (!isOpen(loop.status)) throw new Error(`loop "${loopID}" is already ${loop.status}`)
    loop.status = "stopped"
    loop.nextRunAt = null
    loop.stopReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 400) : "stopped"
    loop.updatedAt = now()
    return snapshot(loop)
  })
}

export async function stopLoopsForSession(sessionID: string, reason: string) {
  return mutate((state) => {
    const stopped: LoopSnapshot[] = []
    for (const loop of Object.values(state.loops)) {
      if (loop.sessionID !== sessionID || !isOpen(loop.status)) continue
      loop.status = "stopped"
      loop.nextRunAt = null
      loop.stopReason = reason
      loop.updatedAt = now()
      stopped.push(snapshot(loop))
    }
    return stopped
  })
}

export async function clearClosedLoops(sessionID: string) {
  return mutate((state) => {
    let cleared = 0
    for (const [id, loop] of Object.entries(state.loops)) {
      if (loop.sessionID !== sessionID || isOpen(loop.status)) continue
      delete state.loops[id]
      cleared += 1
    }
    return cleared
  })
}

export async function scheduleNextRun(loopID: string, delayMs: number, reason?: string | null) {
  const delay = positiveIntegerOrNull(Math.round(delayMs))
  if (delay == null) throw new Error("delay must be a positive number of milliseconds")
  return mutate((state) => {
    const loop = requireLoop(state, loopID)
    if (loop.status !== "active") throw new Error(`loop "${loopID}" is ${loop.status}; only active loops can be scheduled`)
    const timestamp = now()
    loop.nextRunAt = timestamp + delay
    loop.lastReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 400) : loop.lastReason
    loop.updatedAt = timestamp
    return snapshot(loop)
  })
}

export async function recordRunSent(loopID: string) {
  return mutate((state) => {
    const loop = requireLoop(state, loopID)
    if (loop.status !== "active") return snapshot(loop)
    const timestamp = now()
    loop.runCount += 1
    loop.lastRunAt = timestamp
    loop.lastResult = "sent"
    loop.lastError = null
    loop.updatedAt = timestamp
    if (loop.maxRuns != null && loop.runCount >= loop.maxRuns) {
      loop.status = "completed"
      loop.nextRunAt = null
      loop.stopReason = `max runs reached (${loop.maxRuns})`
    } else if (loop.mode === "interval") {
      loop.nextRunAt = timestamp + loop.intervalMs!
    } else {
      loop.nextRunAt = null
    }
    return snapshot(loop)
  })
}

export async function recordRunDeferred(loopID: string, result: "skipped_busy" | "skipped_plan", retryDelayMs: number) {
  return mutate((state) => {
    const loop = requireLoop(state, loopID)
    if (loop.status !== "active") return snapshot(loop)
    const timestamp = now()
    loop.lastResult = result
    loop.nextRunAt = timestamp + Math.max(0, Math.round(retryDelayMs))
    loop.updatedAt = timestamp
    return snapshot(loop)
  })
}

export async function recordRunFailed(loopID: string, error: string, retryDelayMs: number) {
  return mutate((state) => {
    const loop = requireLoop(state, loopID)
    const timestamp = now()
    loop.lastResult = "failed"
    loop.lastError = error.slice(0, 400)
    loop.updatedAt = timestamp
    if (loop.status === "active") loop.nextRunAt = timestamp + Math.max(0, Math.round(retryDelayMs))
    return snapshot(loop)
  })
}

export function formatLoop(loop: LoopSnapshot) {
  const parts = [
    `${loop.id} [${loop.status}]`,
    loop.mode === "interval" ? `every ${formatInterval(loop.intervalMs)}` : "dynamic pacing",
    `runs ${loop.runCount}${loop.maxRuns == null ? "" : `/${loop.maxRuns}`}`,
  ]
  if (loop.nextRunAt != null) parts.push(`next ${new Date(loop.nextRunAt).toISOString()}`)
  else if (loop.status === "active" && loop.mode === "dynamic") parts.push("next run not scheduled yet")
  if (loop.lastResult) parts.push(`last ${loop.lastResult}`)
  if (loop.stopReason && loop.status !== "active") parts.push(`reason: ${loop.stopReason}`)
  const summary = loop.prompt.replace(/\s+/g, " ").slice(0, 120)
  return `${parts.join(", ")} - ${summary}`
}

export function formatLoops(loops: LoopSnapshot[]) {
  if (loops.length === 0) return "No loops exist for this session."
  return loops.map(formatLoop).join("\n")
}
