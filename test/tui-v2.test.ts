import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode-ai/client"
import { createSignal } from "solid-js"
import { createStore, type Store } from "solid-js/store"
import plugin, { loopsFromV2Messages, setupTuiV2 } from "../src/tui"

type Loop = NonNullable<ReturnType<typeof loopsFromV2Messages>>[number]

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop_abcde",
    sessionID: "session",
    prompt: "check deploy",
    mode: "interval",
    intervalMs: 60_000,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: Date.now() + 60_000,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastReason: null,
    runCount: 0,
    maxRuns: null,
    agent: null,
    stopReason: null,
    sampledAt: Date.now(),
    ...overrides,
  }
}

function toolMessage(id: string, loops: Loop[]): SessionMessageInfo {
  const part = {
    type: "tool",
    id: `call_${id}`,
    name: "list_loops",
    state: { status: "completed", input: {}, content: [{ type: "text", text: JSON.stringify({ loops }) }] },
    time: { created: 0 },
  } as SessionMessageAssistantTool
  return {
    id,
    time: { created: 0 },
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [part],
  } as SessionMessageInfo
}

type Layer = { commands?: readonly { id?: string; title?: string; palette?: true; run: () => void }[] }

function mockContext() {
  const slots = new Map<string, (props: { sessionID: string }) => unknown>()
  const disposed: string[] = []
  const layers: Array<() => Layer> = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const [messages, setMessages] = createSignal<SessionMessageInfo[]>([])
  const memories = new Map<string, [Store<{ loops: Loop[] }>, (mutation: (draft: { loops: Loop[] }) => void) => void]>()
  let route: { type: string; sessionID?: string } = { type: "home" }

  const context = {
    options: {},
    location: undefined,
    app: { version: "0.0.0", channel: "test" },
    renderer: undefined,
    client: { session: { prompt: async (input: { sessionID: string; text: string }) => void prompts.push(input) } },
    data: { session: { message: { list: () => messages() } } },
    attention: undefined,
    theme: {
      text: {
        default: "#ffffff",
        subdued: "#888888",
      },
    },
    markdown: undefined,
    keymap: { layer: (input: () => Layer) => void layers.push(input) },
    storage: {
      memory(key: string, options: { initial: { loops: Loop[] } }) {
        let entry = memories.get(key)
        if (!entry) {
          const [store, setStore] = createStore({ ...options.initial })
          entry = [
            store,
            (mutation) => {
              const draft = { loops: [...store.loops] }
              mutation(draft)
              setStore(draft)
            },
          ]
          memories.set(key, entry)
        }
        return entry
      },
      store: () => {
        throw new Error("not used")
      },
    },
    ui: {
      dialog: {
        set: () => {},
        select: async () => undefined,
        clear: () => {},
      },
      toast: { show: () => {} },
      format: { path: (value: string) => value },
      router: {
        register: () => () => {},
        navigate: () => {},
        current: () => route,
      },
      tabs: undefined,
      slot(claim: {
        append: string
        render: (props: { sessionID: string }) => unknown
      }) {
        slots.set(claim.append, claim.render)
        return () => disposed.push(claim.append)
      },
    },
  }
  return {
    context,
    slots,
    disposed,
    layers,
    prompts,
    setMessages,
    setRoute(next: { type: string; sessionID?: string }) {
      route = next
    },
  }
}

test("V2 TUI export preserves V1 and exposes setup", () => {
  expect(plugin.id).toBe("local.loop-mode.tui")
  expect(plugin.tui).toBeTypeOf("function")
  expect(plugin.setup).toBeTypeOf("function")
})

test("loopsFromV2Messages reads the newest completed loop tool text output", () => {
  const result = loopsFromV2Messages([
    toolMessage("old", [loop({ status: "active" })]),
    toolMessage("new", [loop({ status: "paused", runCount: 2 })]),
  ])
  expect(result?.[0]?.status).toBe("paused")
  expect(result?.[0]?.runCount).toBe(2)
})

test("V2 setup registers slots and cleanup disposes them", () => {
  const mock = mockContext()
  const cleanup = setupTuiV2(mock.context as never)
  expect([...mock.slots.keys()].sort()).toEqual(["app", "sidebar.content"])
  cleanup()
  expect(mock.disposed.sort()).toEqual(["app", "sidebar.content"])
})

test("V2 sidebar reacts to loop tool results after mount", async () => {
  const mock = mockContext()
  const cleanup = setupTuiV2(mock.context as never)
  const sidebar = mock.slots.get("sidebar.content")
  const rendered = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 100, height: 20 })
  try {
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).not.toContain("loop_abcde")
    mock.setMessages([toolMessage("created", [loop()])])
    await rendered.flush()
    expect(rendered.captureCharFrame()).toContain("loop_abcde")
    expect(rendered.captureCharFrame()).toContain("runs 0")
    mock.setMessages([toolMessage("paused", [loop({ status: "paused" })])])
    await rendered.flush()
    expect(rendered.captureCharFrame()).not.toContain("next in")
  } finally {
    rendered.renderer.destroy()
    cleanup()
  }
})

test("V2 app slot registers the loop palette command", async () => {
  const mock = mockContext()
  const cleanup = setupTuiV2(mock.context as never)
  const app = mock.slots.get("app")
  const rendered = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 10 })
  try {
    await rendered.renderOnce()
    const command = mock.layers[0]?.().commands?.find((candidate) => candidate.id === "loop.show")
    expect(command?.title).toBe("Loops")
    expect(command?.palette).toBe(true)
  } finally {
    rendered.renderer.destroy()
    cleanup()
  }
})
