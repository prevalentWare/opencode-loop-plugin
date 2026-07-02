import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import serverModule from "../src/server"
import { activeLoops, getLoop, listLoops } from "../src/state"

type Hooks = Awaited<ReturnType<typeof serverModule.server>>

type SentPrompt = {
  sessionID: string
  text: string
  agent?: string
}

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-loop-plugin-server-"))
  process.env.OPENCODE_LOOP_STATE_PATH = join(dir, "loops.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_LOOP_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

function fakeClient(sent: SentPrompt[], options: { failPrompts?: boolean } = {}) {
  return {
    session: {
      promptAsync: async (input: { path: { id: string }; body: { agent?: string; parts: { type: string; text: string }[] } }) => {
        if (options.failPrompts) throw new Error("prompt rejected")
        sent.push({
          sessionID: input.path.id,
          text: input.body.parts[0]?.text ?? "",
          agent: input.body.agent,
        })
      },
    },
    app: {
      log: async () => {},
    },
  }
}

async function makeServer(sent: SentPrompt[], options?: Record<string, unknown>, clientOptions?: { failPrompts?: boolean }) {
  const hooks = await serverModule.server(
    { client: fakeClient(sent, clientOptions) } as never,
    { min_interval_seconds: 1, busy_backoff_seconds: 1, failure_backoff_seconds: 1, ...options } as never,
  )
  return hooks as Hooks
}

function tool(hooks: Hooks, name: string) {
  const tools = (hooks as { tool?: Record<string, { execute: (args: unknown, context: { sessionID: string; agent?: string }) => Promise<string> }> }).tool
  const entry = tools?.[name]
  if (!entry) throw new Error(`tool ${name} not registered`)
  return entry
}

async function idle(hooks: Hooks, sessionID: string) {
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID } } } as never)
}

async function busy(hooks: Hooks, sessionID: string) {
  await hooks.event?.({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
  } as never)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("create_loop schedules an iteration and injects the prompt when due", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1", agent: "build" }),
  ) as { created: string }

  expect(created.created).toMatch(/^loop_/)
  await sleep(1300)

  expect(sent).toHaveLength(1)
  expect(sent[0]?.sessionID).toBe("ses_1")
  expect(sent[0]?.agent).toBe("build")
  expect(sent[0]?.text).toContain(created.created)
  expect(sent[0]?.text).toContain("say tick")
  expect(sent[0]?.text).toContain("stop_loop")

  const loop = await getLoop(created.created)
  expect(loop?.runCount).toBe(1)
  expect(loop?.lastResult).toBe("sent")
  await hooks.dispose?.()
})

test("busy sessions defer iterations until idle", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  await busy(hooks, "ses_1")
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1" }),
  ) as { created: string }

  await sleep(1300)
  expect(sent).toHaveLength(0)
  expect((await getLoop(created.created))?.lastResult).toBe("skipped_busy")

  await idle(hooks, "ses_1")
  await sleep(1300)
  expect(sent.length).toBeGreaterThanOrEqual(1)
  await hooks.dispose?.()
})

test("stop_loop cancels future iterations", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1" }),
  ) as { created: string }

  await tool(hooks, "stop_loop").execute({ loop_id: created.created, reason: "done" }, { sessionID: "ses_1" })
  await sleep(1300)

  expect(sent).toHaveLength(0)
  expect((await getLoop(created.created))?.status).toBe("stopped")
  await hooks.dispose?.()
})

test("loop tools reject loops from other sessions", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1m" }, { sessionID: "ses_1" }),
  ) as { created: string }

  await expect(tool(hooks, "stop_loop").execute({ loop_id: created.created }, { sessionID: "ses_2" })).rejects.toThrow(
    "different session",
  )
  await hooks.dispose?.()
})

test("dynamic loops end when the turn does not schedule the next run", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "watch CI" }, { sessionID: "ses_1" }),
  ) as { created: string; loop: { mode: string } }

  expect(created.loop.mode).toBe("dynamic")
  await idle(hooks, "ses_1")

  const loop = await getLoop(created.created)
  expect(loop?.status).toBe("stopped")
  expect(loop?.stopReason).toContain("without scheduling")
  await hooks.dispose?.()
})

test("dynamic loops continue while schedule_next_run keeps being called", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "watch CI" }, { sessionID: "ses_1" }),
  ) as { created: string }

  const scheduled = JSON.parse(
    await tool(hooks, "schedule_next_run").execute(
      { loop_id: created.created, delay_seconds: 1, reason: "watching CI" },
      { sessionID: "ses_1" },
    ),
  ) as { clamped_delay_seconds: number }
  expect(scheduled.clamped_delay_seconds).toBe(1)

  await idle(hooks, "ses_1")
  expect((await getLoop(created.created))?.status).toBe("active")

  await sleep(1300)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).toContain("schedule_next_run")

  await busy(hooks, "ses_1")
  await idle(hooks, "ses_1")
  const settled = await getLoop(created.created)
  expect(settled?.status).toBe("stopped")
  expect(settled?.stopReason).toContain("without scheduling")
  await hooks.dispose?.()
})

test("schedule_next_run rejects fixed-interval loops", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1m" }, { sessionID: "ses_1" }),
  ) as { created: string }

  await expect(
    tool(hooks, "schedule_next_run").execute(
      { loop_id: created.created, delay_seconds: 10, reason: "nope" },
      { sessionID: "ses_1" },
    ),
  ).rejects.toThrow("fixed interval")
  await hooks.dispose?.()
})

test("failed injections record the error and stay active for retry", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent, {}, { failPrompts: true })
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1" }),
  ) as { created: string }

  await sleep(1300)
  const loop = await getLoop(created.created)
  expect(loop?.lastResult).toBe("failed")
  expect(loop?.lastError).toContain("prompt rejected")
  expect(loop?.status).toBe("active")
  await hooks.dispose?.()
})

test("session deletion stops the session's loops", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  await tool(hooks, "create_loop").execute({ instruction: "a", interval: "1m" }, { sessionID: "ses_1" })
  await tool(hooks, "create_loop").execute({ instruction: "b", interval: "1m" }, { sessionID: "ses_1" })

  await hooks.event?.({ event: { type: "session.deleted", properties: { sessionID: "ses_1" } } } as never)

  expect(await activeLoops("ses_1")).toHaveLength(0)
  const loops = await listLoops("ses_1")
  expect(loops.every((loop) => loop.stopReason === "session deleted")).toBe(true)
  await hooks.dispose?.()
})

test("restricted agents defer loop iterations", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  await hooks["chat.message"]?.({ sessionID: "ses_1", agent: "plan" } as never, { message: {} } as never)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1" }),
  ) as { created: string }

  await sleep(1300)
  expect(sent).toHaveLength(0)
  expect((await getLoop(created.created))?.lastResult).toBe("skipped_plan")

  await hooks["chat.message"]?.({ sessionID: "ses_1", agent: "build" } as never, { message: {} } as never)
  await idle(hooks, "ses_1")
  await sleep(1500)
  expect(sent.length).toBeGreaterThanOrEqual(1)
  await hooks.dispose?.()
})

test("registers the /loop command through the config hook", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const config: { command?: Record<string, { description?: string; template?: string }> } = {}
  await hooks.config?.(config as never)

  expect(config.command?.loop).toBeDefined()
  expect(config.command?.loop?.template).toContain("$ARGUMENTS")
  expect(config.command?.loop?.template).toContain("create_loop")
  await hooks.dispose?.()
})

test("system transform merges a loop reminder for sessions with open loops", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1m" }, { sessionID: "ses_1" })

  const output = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_1" } as never, output as never)
  expect(output.system[0]).toContain("OpenCode loop mode")

  const empty = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_other" } as never, empty as never)
  expect(empty.system[0]).toBe("base prompt")
  await hooks.dispose?.()
})

test("rehydrates persisted active loops on startup", async () => {
  const sent: SentPrompt[] = []
  const first = await makeServer(sent)
  const created = JSON.parse(
    await tool(first, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1" }),
  ) as { created: string }
  await first.dispose?.()

  const second = await makeServer(sent)
  await sleep(1300)
  expect(sent.length).toBeGreaterThanOrEqual(1)
  expect(sent[0]?.text).toContain(created.created)
  await second.dispose?.()
})
