import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import serverModule from "../src/server"
import { activeLoops, createLoop, getLoop, listLoops } from "../src/state"

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

function fakeClient(sent: SentPrompt[], options: { failPrompts?: boolean; unavailableSessions?: Set<string> } = {}) {
  return {
    session: {
      status: async () => ({ data: {} }),
      get: async (input: { path: { id: string } }) => {
        if (options.unavailableSessions?.has(input.path.id)) throw new Error("session unavailable")
        return { data: { id: input.path.id } }
      },
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

async function makeServer(sent: SentPrompt[], options?: Record<string, unknown>, clientOptions?: { failPrompts?: boolean; unavailableSessions?: Set<string> }) {
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

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  expect(await predicate()).toBe(true)
}

test("create_loop schedules an iteration and injects the prompt when due", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1", agent: "build" }),
  ) as { created: string }

  expect(created.created).toMatch(/^loop_/)
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)

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

  await waitFor(async () => (await getLoop(created.created))?.lastResult === "skipped_busy")
  expect(sent).toHaveLength(0)

  await idle(hooks, "ses_1")
  await waitFor(() => sent.length >= 1)
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

  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
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

test("failed injections record a safe category and stay active for retry", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent, {}, { failPrompts: true })
  const created = JSON.parse(
    await tool(hooks, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1" }),
  ) as { created: string }

  await waitFor(async () => (await getLoop(created.created))?.lastResult === "failed")
  const loop = await getLoop(created.created)
  expect(loop?.lastResult).toBe("failed")
  expect(loop?.lastError).toBe("provider/model request failed")
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

  await waitFor(async () => (await getLoop(created.created))?.lastResult === "skipped_plan")
  expect(sent).toHaveLength(0)
  expect((await getLoop(created.created))?.lastResult).toBe("skipped_plan")

  await hooks["chat.message"]?.({ sessionID: "ses_1", agent: "build" } as never, { message: {} } as never)
  await idle(hooks, "ses_1")
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
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

test("rehydrated loops resume after an authoritative idle event", async () => {
  const sent: SentPrompt[] = []
  const first = await makeServer(sent)
  const created = JSON.parse(
    await tool(first, "create_loop").execute({ instruction: "say tick", interval: "1s" }, { sessionID: "ses_1" }),
  ) as { created: string }
  await first.dispose?.()

  const second = await makeServer(sent)
  await tool(second, "list_loops").execute({}, { sessionID: "ses_1" })
  await sleep(1300)
  expect(sent).toHaveLength(0)
  await second.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)
  await waitFor(async () => (await getLoop(created.created))?.runCount === 1)
  expect(sent.length).toBeGreaterThanOrEqual(1)
  expect(sent[0]?.text).toContain(created.created)
  await second.dispose?.()
})

test("V1 rehydrate leaves a foreign unscheduled dynamic loop unchanged", async () => {
  const first = await makeServer([])
  const created = JSON.parse(
    await tool(first, "create_loop").execute({ instruction: "watch CI" }, { sessionID: "ses_foreign" }),
  ) as { created: string }
  const before = await getLoop(created.created)

  const foreign = await makeServer([])
  await foreign.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_foreign" } } } as never)
  await sleep(100)
  const after = await getLoop(created.created)

  expect(after?.status).toBe(before?.status)
  expect(after?.stopReason).toBe(before?.stopReason)
  expect(after?.updatedAt).toBe(before?.updatedAt)
  await foreign.dispose?.()
  await first.dispose?.()
})


test("slow accepted delivery retains run accounting after the initial owner lease expires", async () => {
  const sent: SentPrompt[] = []
  const originalNow = Date.now
  const client = fakeClient(sent)
  const originalPrompt = client.session.promptAsync
  client.session.promptAsync = async (input) => {
    await originalPrompt(input)
    const acceptedAt = originalNow()
    Date.now = () => acceptedAt + 31_000
  }
  const hooks = await serverModule.server(
    { client } as never,
    { min_interval_seconds: 1 } as never,
  )
  try {
    const created = JSON.parse(await tool(hooks, "create_loop").execute(
      { instruction: "tick", interval: "1s", max_runs: 1 }, { sessionID: "ses_slow" },
    )) as { created: string }
    await waitFor(async () => (await getLoop(created.created))?.status === "completed")
    expect(sent).toHaveLength(1)
    const loop = await getLoop(created.created)
    expect(loop?.runCount).toBe(1)
    expect(loop?.status).toBe("completed")
  } finally {
    Date.now = originalNow
    await hooks.dispose?.()
  }
})

test("a keep-alive loop survives age expiry that would stop an ordinary loop", async () => {
  const sent: SentPrompt[] = []
  const first = await makeServer(sent)
  const durable = JSON.parse(
    await tool(first, "create_loop").execute(
      { instruction: "hold the future open", interval: "1s", keep_alive: true },
      { sessionID: "ses_keep" },
    ),
  ) as { created: string }
  const ordinary = JSON.parse(
    await tool(first, "create_loop").execute({ instruction: "ordinary", interval: "1s" }, { sessionID: "ses_keep" }),
  ) as { created: string }
  await first.dispose?.()

  // Backdate both well past the expiry window.
  const statePath = process.env.OPENCODE_LOOP_STATE_PATH!
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    loops: Record<string, { createdAt: number; nextRunAt: number }>
  }
  for (const id of [durable.created, ordinary.created]) {
    state.loops[id]!.createdAt = Date.now() - 400 * 24 * 60 * 60 * 1000
    state.loops[id]!.nextRunAt = Date.now() - 1000
  }
  await writeFile(statePath, JSON.stringify(state))

  const second = await makeServer(sent, { max_loop_age_days: 7 })
  await idle(second, "ses_keep")
  await waitFor(async () => (await getLoop(ordinary.created))?.status === "stopped" &&
    (await getLoop(durable.created))?.runCount === 1)

  expect((await getLoop(durable.created))?.status).toBe("active")
  expect((await getLoop(ordinary.created))?.status).toBe("stopped")
  await second.dispose?.()
})

test("a keep-alive loop retries in a session this process never observed", async () => {
  const sent: SentPrompt[] = []
  const first = await makeServer(sent)
  const durable = JSON.parse(
    await tool(first, "create_loop").execute(
      { instruction: "hold the future open", interval: "1s", keep_alive: true },
      { sessionID: "ses_detached" },
    ),
  ) as { created: string }
  await first.dispose?.()

  // A fresh process never sees an event for the detached session, and the
  // prompt fails: the loop must record the failure and re-arm, not stall.
  const second = await makeServer(sent, undefined, { failPrompts: true })
  await waitFor(async () => (await getLoop(durable.created))?.lastResult === "failed")

  const loop = await getLoop(durable.created)
  expect(loop?.status).toBe("active")
  expect(loop?.lastResult).toBe("failed")
  expect(loop?.nextRunAt).not.toBeNull()
  await second.dispose?.()
})

test("an ordinary loop still defers to the owning process when unobserved", async () => {
  const sent: SentPrompt[] = []
  const first = await makeServer(sent)
  const ordinary = JSON.parse(
    await tool(first, "create_loop").execute({ instruction: "ordinary", interval: "1s" }, { sessionID: "ses_other_proc" }),
  ) as { created: string }
  await first.dispose?.()

  const second = await makeServer(sent, undefined, { failPrompts: true })
  await sleep(1300)

  // Left alone for the process that owns it: no failure recorded.
  expect((await getLoop(ordinary.created))?.lastResult).toBeNull()
  await second.dispose?.()
})

test("a keep-alive loop survives a restart and keeps firing", async () => {
  const sent: SentPrompt[] = []
  const first = await makeServer(sent)
  const durable = JSON.parse(
    await tool(first, "create_loop").execute(
      { instruction: "hold the future open", interval: "1s", keep_alive: true },
      { sessionID: "ses_restart" },
    ),
  ) as { created: string }
  await first.dispose?.()

  const second = await makeServer(sent)
  await waitFor(async () => (await getLoop(durable.created))?.runCount === 1)

  expect(sent.map((entry) => entry.sessionID)).toContain("ses_restart")
  expect((await getLoop(durable.created))?.status).toBe("active")
  await second.dispose?.()
})

test("a keep-alive future ends only when the agent stops it", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  const durable = JSON.parse(
    await tool(hooks, "create_loop").execute(
      { instruction: "hold the future open", interval: "1s", keep_alive: true },
      { sessionID: "ses_stop" },
    ),
  ) as { created: string }

  // Several iterations pass without the agent ever stopping the loop. The
  // injected turn marks the session busy, so each iteration needs its idle.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await waitFor(async () => ((await getLoop(durable.created))?.runCount ?? 0) >= iteration + 1)
    await idle(hooks, "ses_stop")
  }
  expect((await getLoop(durable.created))?.status).toBe("active")
  expect((await getLoop(durable.created))?.runCount).toBeGreaterThanOrEqual(3)

  await tool(hooks, "stop_loop").execute({ loop_id: durable.created }, { sessionID: "ses_stop" })
  expect((await getLoop(durable.created))?.status).toBe("stopped")
  await hooks.dispose?.()
})

test("keep_alive requires a fixed interval", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)

  await expect(
    tool(hooks, "create_loop").execute({ instruction: "no cadence", keep_alive: true }, { sessionID: "ses_bad" }),
  ).rejects.toThrow(/keep-alive loops require a fixed interval/)

  await hooks.dispose?.()
})


test("keep-alive recovery leaves unavailable sessions dormant", async () => {
  const loop = await createLoop("ses_missing", { prompt: "tick", intervalMs: 1, keepAlive: true })
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent, undefined, { unavailableSessions: new Set(["ses_missing"]) })
  await sleep(200)
  expect(sent).toHaveLength(0)
  expect((await getLoop(loop.id))?.lastResult).toBeNull()
  await hooks.dispose?.()
})

test("keep-alive recovery does not wake ordinary siblings without observation", async () => {
  const durable = await createLoop("ses_shared", { prompt: "durable", intervalMs: 1, keepAlive: true })
  const ordinary = await createLoop("ses_shared", { prompt: "ordinary", intervalMs: 1 })
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  await waitFor(async () => (await getLoop(durable.id))?.runCount === 1)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).toContain(durable.id)
  expect((await getLoop(ordinary.id))?.lastResult).toBeNull()
  await hooks.dispose?.()
})

test("keep-alive recovery retains bounded failure pause and explicit resume", async () => {
  const loop = await createLoop("ses_retry", { prompt: "tick", intervalMs: 100, keepAlive: true })
  const sent: SentPrompt[] = []
  const failures = { failPrompts: true }
  const hooks = await makeServer(sent, { max_consecutive_failures: 1 }, failures)
  await waitFor(async () => (await getLoop(loop.id))?.status === "paused")
  expect((await getLoop(loop.id))?.status).toBe("paused")
  failures.failPrompts = false
  await tool(hooks, "resume_loop").execute({ loop_id: loop.id }, { sessionID: "ses_retry" })
  await waitFor(async () => (await getLoop(loop.id))?.runCount === 1)
  expect((await getLoop(loop.id))?.status).toBe("active")
  expect((await getLoop(loop.id))?.runCount).toBe(1)
  await hooks.dispose?.()
})


test("V1 recovered keep-alive defers while the authoritative host session is busy", async () => {
  const loop = await createLoop("ses_busy", { prompt: "tick", intervalMs: 100, keepAlive: true })
  const sent: SentPrompt[] = []
  const client = fakeClient(sent)
  let busy = true
  client.session.status = async () => ({ data: busy ? { ses_busy: { type: "busy" } } : {} })
  const hooks = await serverModule.server({ client } as never, { min_interval_seconds: 1 } as never)
  await waitFor(async () => (await getLoop(loop.id))?.lastResult === "skipped_busy")
  expect(sent).toHaveLength(0)
  expect((await getLoop(loop.id))?.lastResult).toBe("skipped_busy")
  busy = false
  await waitFor(async () => (await getLoop(loop.id))?.runCount === 1)
  expect(sent).toHaveLength(1)
  expect((await getLoop(loop.id))?.runCount).toBe(1)
  await hooks.dispose?.()
})


test("V1 keep-alive recovery refuses a session in another directory", async () => {
  const loop = await createLoop("ses_foreign", { prompt: "tick", intervalMs: 1, keepAlive: true })
  const sent: SentPrompt[] = []
  const client = fakeClient(sent)
  client.session.get = async ({ path }) => ({ data: { id: path.id, directory: "/other" } })
  const hooks = await serverModule.server({ client, directory: "/current" } as never)
  await sleep(200)
  expect(sent).toHaveLength(0)
  expect((await getLoop(loop.id))?.lastResult).toBeNull()
  await hooks.dispose?.()
})

test("V1 passive hooks survive loop state failures instead of breaking dialogue", async () => {
  const sent: SentPrompt[] = []
  const hooks = await makeServer(sent)
  // A file where the state directory should be makes every state mutation
  // fail deterministically on any platform.
  const blocker = join(dir, "blocker")
  await writeFile(blocker, "not a directory")
  process.env.OPENCODE_LOOP_STATE_PATH = join(blocker, "loops.json")
  const sessionID = "ses_broken_state"
  await hooks["chat.message"]?.({ sessionID, agent: "build" } as never, { message: { sessionID } } as never)
  const system = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID } as never, system as never)
  expect(system.system).toEqual([])
  const compacting = { sessionID, context: [] as string[] }
  await hooks["experimental.session.compacting"]?.(compacting as never, compacting as never)
  expect(compacting.context).toEqual([])
  await hooks.event?.({ event: { type: "session.deleted", properties: { sessionID } } } as never)
  expect(sent).toHaveLength(0)
  await hooks.dispose?.()
})
