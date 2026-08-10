import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/server"
import { activeLoops, getLoop, listLoops } from "../src/state"

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

type MockCommandDraft = {
  get(name: string): { name: string; template: string } | undefined
  update(name: string, update: (command: { description?: string; template: string }) => void): void
}

type Registration = { dispose: () => Promise<void> }

function controlledStream() {
  const queue: Array<{ done: boolean; value?: unknown }> = []
  const waiters: Array<() => void> = []
  let ended = false
  return {
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
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

type MockContext = {
  options: Record<string, unknown>
  promptCalls: Array<{ sessionID: string; text: string; agents?: Array<{ name: string }> }>
  tools: Array<ToolDraft["add"] extends (tool: infer T) => void ? T : never>
  commandDraft: MockCommandDraft
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
    hook: (name: string, callback: (input: unknown) => void) => Promise<Registration>
    prompt: (input: { sessionID: string; text: string; agents?: Array<{ name: string }> }) => Promise<unknown>
  }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

function makeMockContext(options: Record<string, unknown> = {}): MockContext {
  const tools: MockContext["tools"] = []
  const hooks: MockContext["hooks"] = {}
  const promptCalls: MockContext["promptCalls"] = []
  const disposals: string[] = []
  const stream = controlledStream()
  const commandDraft: MockCommandDraft = {
    get: () => undefined,
    update: (name, update) => {
      const command = { name, template: "" }
      update(command)
      commandDraft.get = () => command
    },
  }
  const registration = (name: string): Registration => ({
    dispose: async () => {
      disposals.push(name)
    },
  })
  return {
    options: { min_interval_seconds: 1, busy_backoff_seconds: 1, failure_backoff_seconds: 1, ...options },
    promptCalls,
    tools,
    commandDraft,
    hooks,
    stream,
    disposals,
    command: {
      transform: async (callback) => {
        callback(commandDraft)
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
      hook: async (name, callback) => {
        hooks[name] = callback
        return registration(`session.hook:${name}`)
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

  const command = mock.commandDraft.get("loop")
  expect(command).toBeDefined()
  expect(command?.template).toContain('OpenCode loop mode command "/loop" was invoked')
  expect(command?.template).toContain("$ARGUMENTS")
  expect(command?.template).toContain("create_loop")

  mock.stream.end()
  await cleanup()
})

test("V2 setup skips command registration when register_command is false", async () => {
  const mock = makeMockContext({ register_command: false })
  const cleanup = await plugin.setup(mock as never)

  expect(mock.commandDraft.get("loop")).toBeUndefined()
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
  const created = JSON.parse(
    contentOf(await loopTool(mock, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string }

  await sleep(1300)
  expect(mock.promptCalls).toHaveLength(0)
  expect((await getLoop(created.created))?.lastResult).toBe("skipped_busy")

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

test("V2 setup rehydrates persisted active loops", async () => {
  const first = makeMockContext()
  const cleanup1 = await plugin.setup(first as never)
  const created = JSON.parse(
    contentOf(await loopTool(first, "create_loop").execute({ instruction: "say tick", interval: "1s" }, toolContext())),
  ) as { created: string }
  first.stream.end()
  await cleanup1()

  const second = makeMockContext()
  const cleanup2 = await plugin.setup(second as never)
  await waitFor(() => second.promptCalls.length >= 1)
  expect(second.promptCalls[0]?.text).toContain(created.created)
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)

  second.stream.end()
  await cleanup2()
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
