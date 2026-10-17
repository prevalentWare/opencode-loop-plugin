import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/server"
import { activeLoops, createLoop, getLoop, listLoops } from "../src/state"

const TOOL_NAMES = [
  "clear_loops",
  "create_loop",
  "list_loops",
  "pause_loop",
  "resume_loop",
  "run_loop",
  "schedule_next_run",
  "stop_loop",
].sort()

type ToolDraft = {
  add(tool: {
    name: string
    description: string
    input: unknown
    options?: { codemode?: boolean }
    execute: (args: unknown, context: unknown) => Promise<unknown>
  }): void
}

type MockMention = { start: number; end: number; text: string }
type MockPrompt = {
  text: string
  files?: Array<{ uri: string; mention?: MockMention }>
  agents?: Array<{ name: string; mention?: MockMention }>
  skills?: Array<{ id: string; mention?: MockMention }>
}

type MockCommandDraft = {
  add(command: {
    name: string
    description?: string
    execute: (input: {
      sessionID: string
      prompt: MockPrompt
      delivery: "steer" | "queue"
    }) => Promise<void>
  }): void
}

type Registration = { dispose: () => Promise<void> }

function controlledStream() {
  const queue: Array<{ done: boolean; value?: unknown }> = []
  const waiters: Array<() => void> = []
  let ended = false
  let processed = 0
  return {
    get processed() { return processed },
    push(value: unknown) {
      if (ended) return
      queue.push({ done: false, value })
      waiters.shift()?.()
    },
    end() {
      if (ended) return
      ended = true
      queue.push({ done: true })
      waiters.shift()?.()
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = queue.shift()
        if (item) {
          if (item.done) return
          yield item.value
          processed += 1
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

type MockContext = {
  options: Record<string, unknown>
  location?: { directory: string; project: { id: string } }
  activeSessions: Set<string>
  unavailableSessions: Set<string>
  promptCalls: Array<{
    sessionID: string
    delivery?: "steer" | "queue"
  } & MockPrompt>
  tools: Array<ToolDraft["add"] extends (tool: infer T) => void ? T : never>
  commands: Array<MockCommandDraft["add"] extends (command: infer T) => void ? T : never>
  hooks: Record<string, (input: unknown) => void>
  stream: ReturnType<typeof controlledStream>
  disposals: string[]
  command: {
    transform: (callback: (draft: MockCommandDraft) => void) => Promise<Registration>
  }
  tool: {
    transform: (callback: (draft: ToolDraft) => void) => Promise<Registration>
  }
  session: {
    get: (input: { sessionID: string }) => Promise<{ id: string; projectID?: string; location?: { directory: string } }>
    hook: (name: string, callback: (input: unknown) => void) => Promise<Registration>
    wait: (input: { sessionID: string }, options?: { signal?: AbortSignal }) => Promise<void>
    prompt: (input: {
      sessionID: string
      delivery?: "steer" | "queue"
    } & MockPrompt) => Promise<unknown>
  }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

function makeMockContext(options: Record<string, unknown> = {}): MockContext {
  const tools: MockContext["tools"] = []
  const commands: MockContext["commands"] = []
  const hooks: MockContext["hooks"] = {}
  const activeSessions = new Set<string>()
  const unavailableSessions = new Set<string>()
  const promptCalls: MockContext["promptCalls"] = []
  const disposals: string[] = []
  const stream = controlledStream()
  const registration = (name: string): Registration => ({
    dispose: async () => {
      disposals.push(name)
    },
  })
  return {
    options: { min_interval_seconds: 1, busy_backoff_seconds: 1, failure_backoff_seconds: 1, ...options },
    activeSessions,
    unavailableSessions,
    promptCalls,
    tools,
    commands,
    hooks,
    stream,
    disposals,
    command: {
      transform: async (callback) => {
        callback({ add: (command) => commands.push(command) })
        return registration("command.transform")
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.push(tool) })
        return registration("tool.transform")
      },
    },
    session: {
      get: async ({ sessionID }) => {
        if (unavailableSessions.has(sessionID)) throw new Error("session unavailable")
        return { id: sessionID }
      },
      hook: async (name, callback) => {
        hooks[name] = callback
        return registration(`session.hook:${name}`)
      },
      wait: async ({ sessionID }) => {
        if (activeSessions.has(sessionID)) throw new Error("session still busy")
      },
      prompt: async (input) => {
        promptCalls.push(input)
        return { id: "pending_1" }
      },
    },
    event: {
      subscribe: () => stream,
    },
  }
}

function toolContext(sessionID = "ses_v2", agent = "build") {
  return { sessionID, agent, messageID: "msg_1", id: "call_1" }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(await predicate()).toBe(true)
}

function loopTool(mock: MockContext, name: string) {
  const tool = mock.tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`expected V2 tool ${name} to be registered`)
  return tool
}

function contentOf(result: unknown) {
  const value = result as { content?: string }
  return typeof value.content === "string" ? value.content : String(result)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-loop-plugin-v2-"))
  process.env.OPENCODE_LOOP_STATE_PATH = join(dir, "loops.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_LOOP_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("default export exposes both V1 server and V2 setup", () => {
  expect(typeof plugin.server).toBe("function")
  expect(typeof plugin.setup).toBe("function")
  expect(plugin.id).toBe("local.loop-mode.server")
})

test("V2 setup registers loop tools with JSON Schema inputs, codemode:false, and {content} executors", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  expect(mock.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)

  for (const tool of mock.tools) {
    expect(tool.options?.codemode).toBe(false)
    expect(typeof tool.input).toBe("object")
    expect(tool.input).not.toBeNull()
    expect(tool.input).toMatchObject({ type: "object", properties: expect.any(Object), additionalProperties: false })
  }

  const createTool = loopTool(mock, "create_loop")
  expect((createTool.input as { required?: string[] }).required).toEqual(["instruction"])
  const created = JSON.parse(
    contentOf(await createTool.execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string; loop: { mode: string }; loops: unknown[] }
  expect(created.created).toMatch(/^loop_/)
  expect(created.loop.mode).toBe("interval")
  expect(created.loops).toHaveLength(1)

  const stopped = JSON.parse(
    contentOf(await loopTool(mock, "stop_loop").execute({ loop_id: created.created, reason: "done" }, toolContext())),
  ) as { stopped: string }
  expect(stopped.stopped).toBe(created.created)

  mock.stream.end()
  await cleanup()
  expect(mock.promptCalls).toHaveLength(0)
})

test("V2 setup registers the /loop command via command transform", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  const command = mock.commands.find((candidate) => candidate.name === "loop")
  expect(command).toBeDefined()
  expect(command?.description).toBe("Run an instruction on a recurring interval while this session is idle")

  await command?.execute({
    sessionID: "ses_command",
    prompt: {
      text: "5m check $& and $ARGUMENTS",
      files: [{ uri: "file:///tmp/context.txt", mention: { start: 9, end: 11, text: "$&" } }],
      agents: [{ name: "build", mention: { start: 9, end: 11, text: "$&" } }],
      skills: [{ id: "review", mention: { start: 9, end: 11, text: "$&" } }],
    },
    delivery: "queue",
  })
  expect(mock.promptCalls).toHaveLength(1)
  expect(mock.promptCalls[0]).toMatchObject({
    sessionID: "ses_command",
    delivery: "queue",
  })
  expect(mock.promptCalls[0]?.files).toEqual([{ uri: "file:///tmp/context.txt" }])
  expect(mock.promptCalls[0]?.agents).toEqual([{ name: "build" }])
  expect(mock.promptCalls[0]?.skills).toEqual([{ id: "review" }])
  expect(mock.promptCalls[0]?.text).toContain('OpenCode loop mode command "/loop" was invoked')
  expect(mock.promptCalls[0]?.text).toContain("5m check $& and $ARGUMENTS")
  expect(mock.promptCalls[0]?.text).toContain("create_loop")
  expect(mock.promptCalls[0]?.text.match(/\$ARGUMENTS/g)).toHaveLength(1)

  await command?.execute({ sessionID: "ses_empty", prompt: { text: "" }, delivery: "steer" })
  expect(mock.promptCalls[1]).toMatchObject({ sessionID: "ses_empty", delivery: "steer" })
  expect(mock.promptCalls[1]?.text).toContain('If the arguments are empty, "list", or "status", call list_loops')

  mock.stream.end()
  await cleanup()
})

test("V2 setup skips command registration when register_command is false", async () => {
  const mock = makeMockContext({ register_command: false })
  const cleanup = await plugin.setup(mock as never)

  expect(mock.commands).toHaveLength(0)
  expect(mock.disposals).not.toContain("command.transform")

  mock.stream.end()
  await cleanup()
})

test("V2 context hook injects a session-specific loop reminder", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  const created = JSON.parse(
    contentOf(await loopTool(mock, "create_loop").execute({ instruction: "watch CI", interval: "1m" }, toolContext())),
  ) as { created: string }

  const contextHook = mock.hooks["context"]!
  expect(contextHook).toBeTypeOf("function")
  const sessionContext = {
    sessionID: "ses_v2",
    agent: "build",
    system: [] as Array<{ type: string; text: string }>,
    messages: [],
    tools: {},
  }
  await contextHook(sessionContext)
  expect(sessionContext.system.some((part) => part.type === "text" && part.text.includes("OpenCode loop mode reminder"))).toBe(true)
  expect(sessionContext.system.some((part) => part.type === "text" && part.text.includes(created.created))).toBe(true)

  // The reminder is scoped to the hook's session: another session gets nothing.
  const otherContext = {
    sessionID: "ses_other",
    agent: "build",
    system: [] as Array<{ type: string; text: string }>,
    messages: [],
    tools: {},
  }
  await contextHook(otherContext)
  expect(otherContext.system).toHaveLength(0)

  // The reminder is not duplicated on a second hook invocation.
  await contextHook(sessionContext)
  expect(sessionContext.system).toHaveLength(1)

  mock.stream.end()
  await cleanup()
})

test("V2 busy/idle events defer and then inject loop iterations", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  mock.stream.push({ type: "session.status", created: Date.now(), data: { sessionID: "ses_v2", status: { type: "busy" } } })
  mock.activeSessions.add("ses_v2")
  const created = JSON.parse(
    contentOf(await loopTool(mock, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string }

  await waitFor(async () => (await getLoop(created.created))?.lastResult === "skipped_busy")
  expect(mock.promptCalls).toHaveLength(0)

  mock.activeSessions.delete("ses_v2")
  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await waitFor(() => mock.promptCalls.length >= 1)
  expect(mock.promptCalls[0]?.sessionID).toBe("ses_v2")
  expect(mock.promptCalls[0]?.text).toContain(created.created)
  expect(mock.promptCalls[0]?.agents).toEqual([{ name: "build" }])

  // Wait until the run is recorded and the next timer is armed so cleanup can
  // cancel it; otherwise the re-armed timer leaks past cleanup.
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
  mock.stream.end()
  await cleanup()
})

test("V2 authoritative session state overrides a stale busy event", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  mock.stream.push({ type: "session.status", created: Date.now(), data: { sessionID: "ses_v2", status: { type: "busy" } } })
  await sleep(20)
  const created = JSON.parse(
    contentOf(await loopTool(mock, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string }

  // The idle event was lost, but OpenCode's native idle barrier is authoritative
  // and now resolves for this session.
  await waitFor(() => mock.promptCalls.length >= 1)
  expect(mock.promptCalls[0]?.sessionID).toBe("ses_v2")
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)

  mock.stream.end()
  await cleanup()
})

test("V2 dynamic loops settle when the turn does not schedule the next run", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  const created = JSON.parse(
    contentOf(await loopTool(mock, "create_loop").execute({ instruction: "watch CI" }, toolContext())),
  ) as { created: string; loop: { mode: string } }
  expect(created.loop.mode).toBe("dynamic")

  // schedule_next_run keeps the loop alive across the idle turn.
  const scheduled = JSON.parse(
    contentOf(
      await loopTool(mock, "schedule_next_run").execute(
        { loop_id: created.created, delay_seconds: 1, reason: "watching CI" },
        toolContext(),
      ),
    ),
  ) as { clamped_delay_seconds: number }
  expect(scheduled.clamped_delay_seconds).toBe(1)
  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await sleep(20)
  expect((await getLoop(created.created))?.status).toBe("active")

  // The injected iteration runs, then a turn that does not schedule ends the loop.
  await waitFor(() => mock.promptCalls.length >= 1)
  // Wait until the injected run is recorded (nextRunAt cleared for dynamic
  // loops); settling before that commit would read the stale nextRunAt and
  // treat the loop as already scheduled.
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
  mock.stream.push({ type: "session.status", created: Date.now(), data: { sessionID: "ses_v2", status: { type: "busy" } } })
  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await waitFor(async () => (await getLoop(created.created))?.status === "stopped")
  expect((await getLoop(created.created))?.stopReason).toContain("without scheduling")

  mock.stream.end()
  await cleanup()
})

test("V2 native execution completion closes an unscheduled dynamic creating turn", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "watch CI" }, toolContext(),
    ))) as { created: string }
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(created.created))?.status === "stopped")
  } finally {
    mock.stream.end()
    await cleanup()
  }
})

test("V2 native execution completion closes an unscheduled injected dynamic turn", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "watch CI" }, toolContext(),
    ))) as { created: string }
    await loopTool(mock, "schedule_next_run").execute({ loop_id: created.created, delay_seconds: 1 }, toolContext())
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
    mock.stream.push({ type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_v2" } })
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(created.created))?.status === "stopped")
  } finally {
    mock.stream.end()
    await cleanup()
  }
})

for (const outcome of ["failed", "interrupted"] as const) {
  test(`V2 native execution ${outcome} closes an unscheduled dynamic turn`, async () => {
    const mock = makeMockContext()
    const cleanup = await plugin.setup(mock as never)
    try {
      const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
        { instruction: "watch CI" }, toolContext(),
      ))) as { created: string }
      mock.stream.push({ type: `session.execution.${outcome}`, created: Date.now(), data: { sessionID: "ses_v2", reason: "user" } })
      await waitFor(async () => (await getLoop(created.created))?.status === "stopped")
    } finally {
      mock.stream.end()
      await cleanup()
    }
  })
}

test("V2 fixed loops honor the native idle barrier across two execution transitions", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "tick", interval: "1s", max_runs: 2 }, toolContext(),
    ))) as { created: string }
    await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
    mock.activeSessions.add("ses_v2")
    mock.stream.push({ type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(created.created))?.lastResult === "skipped_busy")
    expect(mock.promptCalls).toHaveLength(1)
    mock.activeSessions.delete("ses_v2")
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(created.created))?.status === "completed")
    expect(mock.promptCalls).toHaveLength(2)
  } finally {
    mock.stream.end()
    await cleanup()
  }
})

test("V2 native completion arriving before delivery accounting still closes a dynamic turn", async () => {
  const mock = makeMockContext()
  mock.session.prompt = async (input) => {
    mock.promptCalls.push(input)
    const processed = mock.stream.processed
    mock.stream.push({ type: "session.execution.started", created: Date.now(), data: { sessionID: input.sessionID } })
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: input.sessionID } })
    await waitFor(() => mock.stream.processed >= processed + 2)
    return { id: "pending_fast" }
  }
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "watch CI" }, toolContext(),
    ))) as { created: string }
    await loopTool(mock, "schedule_next_run").execute({ loop_id: created.created, delay_seconds: 1 }, toolContext())
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(created.created))?.status === "stopped")
    expect((await getLoop(created.created))?.runCount).toBe(1)
  } finally {
    mock.stream.end()
    await cleanup()
  }
})

test("V2 fast native completion preserves an explicit next dynamic schedule", async () => {
  const mock = makeMockContext()
  let loopID = ""
  mock.session.prompt = async (input) => {
    mock.promptCalls.push(input)
    const processed = mock.stream.processed
    mock.stream.push({ type: "session.execution.started", created: Date.now(), data: { sessionID: input.sessionID } })
    await loopTool(mock, "schedule_next_run").execute({ loop_id: loopID, delay_seconds: 60 }, toolContext())
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: input.sessionID } })
    await waitFor(() => mock.stream.processed >= processed + 2)
    return { id: "pending_rescheduled" }
  }
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "watch CI" }, toolContext(),
    ))) as { created: string }
    loopID = created.created
    await loopTool(mock, "schedule_next_run").execute({ loop_id: loopID, delay_seconds: 1 }, toolContext())
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(loopID))?.runCount === 1)
    const loop = await getLoop(loopID)
    expect(loop?.status).toBe("active")
    expect(loop?.nextRunAt).toBeGreaterThan(Date.now() + 50_000)
  } finally {
    mock.stream.end()
    await cleanup()
  }
})

test("V2 a deferred creating-turn completion cannot close a newly injected turn", async () => {
  const mock = makeMockContext()
  let releaseWait: () => void = () => {}
  let waitEntered = false
  mock.session.wait = async () => {
    waitEntered = true
    await new Promise<void>((resolve) => { releaseWait = resolve })
  }
  mock.session.prompt = async (input) => {
    mock.promptCalls.push(input)
    const processed = mock.stream.processed
    mock.stream.push({ type: "session.execution.started", created: Date.now(), data: { sessionID: input.sessionID } })
    await waitFor(() => mock.stream.processed > processed)
    return { id: "pending_next_turn" }
  }
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "watch CI" }, toolContext(),
    ))) as { created: string }
    await loopTool(mock, "run_loop").execute({ loop_id: created.created }, toolContext())
    await waitFor(() => waitEntered)
    const processed = mock.stream.processed
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(() => mock.stream.processed > processed)
    releaseWait()
    await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
    expect((await getLoop(created.created))?.status).toBe("active")
    mock.stream.push({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "ses_v2" } })
    await waitFor(async () => (await getLoop(created.created))?.status === "stopped")
  } finally {
    releaseWait()
    mock.stream.end()
    await cleanup()
  }
})

test("V2 shutdown preserves a due interval loop without injecting into a draining host", async () => {
  const loop = await createLoop("ses_v2", { prompt: "tick", intervalMs: 1 })
  const mock = makeMockContext({ max_consecutive_failures: 1 })
  mock.session.prompt = async (input) => {
    mock.promptCalls.push(input)
    throw new Error("host shutting down")
  }
  const cleanup = await plugin.setup(mock as never)
  try {
    mock.stream.push({ type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "ses_v2", reason: "shutdown" } })
    await sleep(200)
    expect(mock.promptCalls).toHaveLength(0)
    expect((await getLoop(loop.id))?.status).toBe("active")
    expect((await getLoop(loop.id))?.consecutiveFailures).toBe(0)
  } finally {
    mock.stream.end()
    await cleanup()
  }
})

test("V2 shutdown fences an iteration already waiting for native idle", async () => {
  const mock = makeMockContext()
  let releaseWait: () => void = () => {}
  let waitEntered = false
  mock.session.wait = async () => {
    waitEntered = true
    await new Promise<void>((resolve) => { releaseWait = resolve })
  }
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "tick", interval: "1s" }, toolContext(),
    ))) as { created: string }
    await waitFor(() => waitEntered)
    const processed = mock.stream.processed
    mock.stream.push({ type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "ses_v2", reason: "shutdown" } })
    await waitFor(() => mock.stream.processed > processed)
    releaseWait()
    await sleep(150)
    expect(mock.promptCalls).toHaveLength(0)
    expect((await getLoop(created.created))?.status).toBe("active")
    expect((await getLoop(created.created))?.consecutiveFailures).toBe(0)
  } finally {
    releaseWait()
    mock.stream.end()
    await cleanup()
  }
})

test("V2 restricted agents defer loop iterations", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  mock.stream.push({ type: "session.agent.selected", created: Date.now(), data: { sessionID: "ses_v2", agent: "plan" } })
  const created = JSON.parse(
    contentOf(await loopTool(mock, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string }

  await sleep(1300)
  expect(mock.promptCalls).toHaveLength(0)
  expect((await getLoop(created.created))?.lastResult).toBe("skipped_plan")

  mock.stream.push({ type: "session.agent.selected", created: Date.now(), data: { sessionID: "ses_v2", agent: "build" } })
  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await waitFor(() => mock.promptCalls.length >= 1)
  expect(mock.promptCalls[0]?.sessionID).toBe("ses_v2")
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)

  mock.stream.end()
  await cleanup()
})

test("V2 session deletion stops the session's loops", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  await loopTool(mock, "create_loop").execute({ instruction: "a", interval: "1m" }, toolContext())
  await loopTool(mock, "create_loop").execute({ instruction: "b", interval: "1m" }, toolContext())

  mock.stream.push({ type: "session.deleted", created: Date.now(), data: { sessionID: "ses_v2" } })
  await waitFor(async () => (await activeLoops("ses_v2")).length === 0)
  const loops = await listLoops("ses_v2")
  expect(loops.every((loop) => loop.stopReason === "session deleted")).toBe(true)

  mock.stream.end()
  await cleanup()
})

test("V2 rehydrated loops resume after an authoritative idle event", async () => {
  const first = makeMockContext()
  const cleanup1 = await plugin.setup(first as never)
  const created = JSON.parse(
    contentOf(await loopTool(first, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string }
  first.stream.end()
  await cleanup1()

  const second = makeMockContext()
  const cleanup2 = await plugin.setup(second as never)
  await Bun.sleep(1100)
  expect(second.promptCalls).toHaveLength(0)
  second.stream.push({
    type: "session.status",
    created: Date.now(),
    data: { sessionID: "ses_v2", status: { type: "idle" } },
  })
  await waitFor(() => second.promptCalls.length >= 1)
  expect(second.promptCalls[0]?.text).toContain(created.created)
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)

  second.stream.end()
  await cleanup2()
})

test("V2 rehydrate leaves a foreign unscheduled dynamic loop unchanged", async () => {
  const owner = makeMockContext()
  const cleanupOwner = await plugin.setup(owner as never)
  const created = JSON.parse(
    contentOf(await loopTool(owner, "create_loop").execute({ instruction: "watch CI" }, toolContext("ses_foreign"))),
  ) as { created: string }
  const before = await getLoop(created.created)

  const foreign = makeMockContext()
  const cleanupForeign = await plugin.setup(foreign as never)
  foreign.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_foreign" } })
  await sleep(100)
  const after = await getLoop(created.created)

  expect(after?.status).toBe(before?.status)
  expect(after?.stopReason).toBe(before?.stopReason)
  expect(after?.updatedAt).toBe(before?.updatedAt)
  foreign.stream.end()
  await cleanupForeign()
  owner.stream.end()
  await cleanupOwner()
})

test("V2 concurrent plugin contexts claim a persisted run only once", async () => {
  const creator = makeMockContext()
  const cleanupCreator = await plugin.setup(creator as never)
  await loopTool(creator, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())
  creator.stream.end()
  await cleanupCreator()

  const first = makeMockContext()
  const second = makeMockContext()
  const cleanupFirst = await plugin.setup(first as never)
  const cleanupSecond = await plugin.setup(second as never)
  first.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  second.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })

  first.stream.push({ type: "session.status", created: Date.now(), data: { sessionID: "ses_v2", status: { type: "idle" } } })
  second.stream.push({ type: "session.status", created: Date.now(), data: { sessionID: "ses_v2", status: { type: "idle" } } })

  await waitFor(() => first.promptCalls.length + second.promptCalls.length >= 1)
  await sleep(100)
  expect(first.promptCalls.length + second.promptCalls.length).toBe(1)

  first.stream.end()
  second.stream.end()
  await cleanupFirst()
  await cleanupSecond()
})

test("V2 cleanup disposes registrations, clears timers, and stops the event consumer", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  const created = JSON.parse(
    contentOf(await loopTool(mock, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string }

  mock.stream.end()
  await cleanup()

  expect(mock.disposals).toEqual(
    expect.arrayContaining(["command.transform", "tool.transform", "session.hook:context"]),
  )
  // Events pushed after cleanup must not throw, and timers are cleared so no
  // iteration is injected even after the interval elapses.
  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await sleep(1400)
  expect(mock.promptCalls).toHaveLength(0)
  expect((await getLoop(created.created))?.status).toBe("active")
})


test("V2 slow accepted delivery retains run accounting after its owner lease expires", async () => {
  const mock = makeMockContext()
  const originalNow = Date.now
  const originalPrompt = mock.session.prompt
  mock.session.prompt = async (input) => {
    const result = await originalPrompt(input)
    const acceptedAt = originalNow()
    Date.now = () => acceptedAt + 31_000
    return result
  }
  const cleanup = await plugin.setup(mock as never)
  try {
    const created = JSON.parse(contentOf(await loopTool(mock, "create_loop").execute(
      { instruction: "tick", interval: "1s", max_runs: 1 }, toolContext("ses_slow"),
    ))) as { created: string }
    await sleep(1300)
    expect(mock.promptCalls).toHaveLength(1)
    const loop = await getLoop(created.created)
    expect(loop?.runCount).toBe(1)
    expect(loop?.status).toBe("completed")
  } finally {
    Date.now = originalNow
    mock.stream.end()
    await cleanup()
  }
})

test("V2 create_loop advertises keep_alive without making it required", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  const input = loopTool(mock, "create_loop").input as {
    properties: Record<string, { type?: string }>
    required: string[]
  }
  expect(input.properties.keep_alive?.type).toBe("boolean")
  expect(input.required).toEqual(["instruction"])

  mock.stream.end()
  await cleanup()
})

test("V2 keep-alive recovery exempts age expiry and preserves ordinary sibling dormancy", async () => {
  const durable = await createLoop("ses_keep", { prompt: "durable", intervalMs: 1, keepAlive: true })
  const ordinary = await createLoop("ses_keep", { prompt: "ordinary", intervalMs: 1 })
  const statePath = process.env.OPENCODE_LOOP_STATE_PATH!
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    loops: Record<string, { createdAt: number; nextRunAt: number }>
  }
  for (const loop of Object.values(state.loops)) {
    loop.createdAt = Date.now() - 400 * 86_400_000
    loop.nextRunAt = Date.now() - 1000
  }
  await writeFile(statePath, JSON.stringify(state))
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  await waitFor(() => mock.promptCalls.length === 1)
  expect((await getLoop(durable.id))?.status).toBe("active")
  expect((await getLoop(ordinary.id))?.lastResult).toBeNull()
  mock.stream.push({ type: "session.idle", data: { sessionID: "ses_keep" } })
  await waitFor(async () => (await getLoop(ordinary.id))?.status === "stopped")
  expect((await getLoop(durable.id))?.status).toBe("active")
  mock.stream.end()
  await cleanup()
})

test("V2 keep_alive requires a fixed interval", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)

  await expect(
    loopTool(mock, "create_loop").execute({ instruction: "no cadence", keep_alive: true }, toolContext("ses_bad")),
  ).rejects.toThrow(/keep-alive loops require a fixed interval/)

  mock.stream.end()
  await cleanup()
})


test("V2 keep-alive recovery leaves inaccessible sessions dormant", async () => {
  const loop = await createLoop("ses_missing", { prompt: "tick", intervalMs: 1, keepAlive: true })
  const mock = makeMockContext()
  mock.unavailableSessions.add("ses_missing")
  const cleanup = await plugin.setup(mock as never)
  await sleep(200)
  expect(mock.promptCalls).toHaveLength(0)
  expect((await getLoop(loop.id))?.lastResult).toBeNull()
  mock.stream.end()
  await cleanup()
})

test("V2 keep-alive recovery retains bounded failure pause and explicit resume", async () => {
  const loop = await createLoop("ses_retry", { prompt: "tick", intervalMs: 100, keepAlive: true })
  const mock = makeMockContext({ max_consecutive_failures: 1 })
  const prompt = mock.session.prompt
  mock.session.prompt = async () => { throw new Error("provider failed") }
  const cleanup = await plugin.setup(mock as never)
  await waitFor(async () => (await getLoop(loop.id))?.status === "paused")
  mock.session.prompt = prompt
  await loopTool(mock, "resume_loop").execute({ loop_id: loop.id }, toolContext("ses_retry"))
  await waitFor(async () => (await getLoop(loop.id))?.runCount === 1)
  expect((await getLoop(loop.id))?.status).toBe("active")
  mock.stream.end()
  await cleanup()
})


test("V2 keep-alive recovery refuses another directory or project", async () => {
  const loop = await createLoop("ses_foreign", { prompt: "tick", intervalMs: 1, keepAlive: true })
  for (const session of [
    { location: { directory: "/other" }, projectID: "current" },
    { location: { directory: "/current" }, projectID: "other" },
  ]) {
    const mock = makeMockContext()
    mock.location = { directory: "/current", project: { id: "current" } }
    mock.session.get = async ({ sessionID }) => ({ id: sessionID, ...session })
    const cleanup = await plugin.setup(mock as never)
    await sleep(200)
    expect(mock.promptCalls).toHaveLength(0)
    expect((await getLoop(loop.id))?.lastResult).toBeNull()
    mock.stream.end()
    await cleanup()
  }
})

test("V2 concurrent recovery contexts deliver a keep-alive iteration once", async () => {
  const loop = await createLoop("ses_shared", { prompt: "tick", intervalMs: 1, keepAlive: true, maxRuns: 1 })
  const first = makeMockContext()
  const second = makeMockContext()
  const cleanFirst = await plugin.setup(first as never)
  const cleanSecond = await plugin.setup(second as never)
  await waitFor(async () => (await getLoop(loop.id))?.status === "completed")
  expect(first.promptCalls.length + second.promptCalls.length).toBe(1)
  first.stream.end()
  second.stream.end()
  await cleanFirst()
  await cleanSecond()
})


test("stable V2 recovered keep-alive uses its native idle barrier without active()", async () => {
  const loop = await createLoop("ses_busy", { prompt: "tick", intervalMs: 100, keepAlive: true, maxRuns: 1 })
  const mock = makeMockContext()
  expect(mock.session).not.toHaveProperty("active")
  mock.activeSessions.add("ses_busy")
  const cleanup = await plugin.setup(mock as never)
  await waitFor(async () => (await getLoop(loop.id))?.lastResult === "skipped_busy")
  expect(mock.promptCalls).toHaveLength(0)
  mock.activeSessions.delete("ses_busy")
  await waitFor(async () => (await getLoop(loop.id))?.status === "completed")
  expect(mock.promptCalls).toHaveLength(1)
  mock.stream.end()
  await cleanup()
})


test("V2 bounds native wait even when the stable adapter ignores cancellation", async () => {
  const loop = await createLoop("ses_wait", { prompt: "tick", intervalMs: 100, keepAlive: true })
  const mock = makeMockContext()
  let calls = 0
  let release!: () => void
  let nativeFinished = false
  const pending = new Promise<void>((resolve) => { release = resolve }).then(() => { nativeFinished = true })
  mock.session.wait = async () => { calls += 1; await pending }
  const cleanup = await plugin.setup(mock as never)
  await waitFor(async () => (await getLoop(loop.id))?.lastResult === "skipped_busy")
  expect(mock.promptCalls).toHaveLength(0)
  await sleep(200)
  expect(calls).toBe(1)
  mock.stream.end()
  await cleanup()
  expect(nativeFinished).toBe(false)
  release()
  await sleep(50)
  expect(mock.promptCalls).toHaveLength(0)
  expect((await getLoop(loop.id))?.runCount).toBe(0)
})

test("V2 context hook survives loop state failures", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  // A file where the state directory should be makes every state mutation
  // fail deterministically on any platform.
  const blocker = join(dir, "blocker")
  await writeFile(blocker, "not a directory")
  process.env.OPENCODE_LOOP_STATE_PATH = join(blocker, "loops.json")

  const contextHook = mock.hooks["context"]!
  const sessionContext = {
    sessionID: "ses_broken_v2",
    agent: "build",
    system: [] as Array<{ type: string; text: string }>,
    messages: [],
    tools: {},
  }
  await contextHook(sessionContext)
  expect(sessionContext.system).toEqual([])

  mock.stream.end()
  await cleanup()
})

test("V2 event consumer survives a failing event", async () => {
  const mock = makeMockContext()
  const cleanup = await plugin.setup(mock as never)
  const blocker = join(dir, "blocker")
  await writeFile(blocker, "not a directory")
  process.env.OPENCODE_LOOP_STATE_PATH = join(blocker, "loops.json")

  mock.stream.push({ type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_bad" } })
  await waitFor(() => mock.stream.processed >= 1)

  // The consumer must still be alive to process later events once state
  // recovers; without per-event handling the first failure kills it.
  process.env.OPENCODE_LOOP_STATE_PATH = join(dir, "loops.json")
  const processed = mock.stream.processed
  mock.stream.push({ type: "session.execution.started", created: Date.now(), data: { sessionID: "ses_ok" } })
  await waitFor(() => mock.stream.processed >= processed + 1)

  mock.stream.end()
  await cleanup()
})
