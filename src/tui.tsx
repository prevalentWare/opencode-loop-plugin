/** @jsxImportSource @opentui/solid */
import type { TuiCommand, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiPluginV2 } from "@opencode-ai/plugin-v2/tui"
import type { SessionMessageInfo } from "@opencode-ai/client"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"

type LoopSnapshot = {
  id: string
  sessionID: string
  prompt: string
  mode: "interval" | "dynamic"
  intervalMs: number | null
  status: "active" | "paused" | "stopped" | "completed"
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastResult: string | null
  lastError: string | null
  lastReason: string | null
  runCount: number
  maxRuns: number | null
  agent: string | null
  stopReason: string | null
  sampledAt: number
}

type LoopToolPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    output?: string
  }
}

type SessionMessage = {
  id: string
}

type ElementChild = string | number | boolean | null | undefined | object | (() => ElementChild)

const LOOP_TOOLS = ["create_loop", "list_loops", "stop_loop", "pause_loop", "resume_loop", "run_loop", "schedule_next_run", "clear_loops"]

const loopCache = new Map<string, LoopSnapshot[]>()

function element(tag: string, props: Record<string, unknown>, children: ElementChild[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) if (value !== undefined) setProp(node, key, value)
  for (const child of children) if (child !== null && child !== undefined && child !== false) insert(node, child)
  return node
}

function text(props: Record<string, unknown>, children: ElementChild[]) {
  return element("text", props, children)
}

function box(props: Record<string, unknown>, children: ElementChild[] = []) {
  return element("box", props, children)
}

function loopSnapshotKey(sessionID: string) {
  return `loop-mode.snapshot.${sessionID}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isLoopSnapshot(value: unknown): value is LoopSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string") return false
  if (typeof value.sessionID !== "string") return false
  if (typeof value.prompt !== "string") return false
  if (!["interval", "dynamic"].includes(String(value.mode))) return false
  if (value.intervalMs !== null && typeof value.intervalMs !== "number") return false
  if (!["active", "paused", "stopped", "completed"].includes(String(value.status))) return false
  if (typeof value.createdAt !== "number") return false
  if (typeof value.updatedAt !== "number") return false
  if (value.nextRunAt !== null && typeof value.nextRunAt !== "number") return false
  if (typeof value.runCount !== "number") return false
  return true
}

function isLoopList(value: unknown): value is LoopSnapshot[] {
  return Array.isArray(value) && value.every(isLoopSnapshot)
}

function cachedLoops(api: TuiPluginApi, sessionID: string) {
  const memory = loopCache.get(sessionID)
  if (memory) return memory
  const persisted = api.kv?.get(loopSnapshotKey(sessionID), null)
  return isLoopList(persisted) ? persisted : []
}

function cacheLoops(api: TuiPluginApi, sessionID: string, loops: LoopSnapshot[]) {
  loopCache.set(sessionID, loops)
  api.kv?.set(loopSnapshotKey(sessionID), loops)
}

function parseLoopToolOutput(part: LoopToolPart): LoopSnapshot[] | undefined {
  if (part.type !== "tool") return undefined
  if (!LOOP_TOOLS.includes(part.tool ?? "")) return undefined
  if (part.state?.status !== "completed") return undefined
  if (typeof part.state.output !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(part.state.output)
    if (!isRecord(parsed)) return undefined
    return isLoopList(parsed.loops) ? parsed.loops : undefined
  } catch {
    return undefined
  }
}

export function loopsFromSession(api: TuiPluginApi, sessionID: string): LoopSnapshot[] {
  const messages = [...api.state.session.messages(sessionID)] as SessionMessage[]
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message) continue
    const parts = [...api.state.part(message.id)].reverse() as LoopToolPart[]
    for (const part of parts) {
      const loops = parseLoopToolOutput(part)
      if (loops !== undefined) {
        cacheLoops(api, sessionID, loops)
        return loops
      }
    }
  }
  return cachedLoops(api, sessionID)
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

export function formatCountdown(msFromNow: number) {
  const total = Math.max(0, Math.ceil(msFromNow / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

export function loopLine(loop: LoopSnapshot, nowMs: number) {
  const cadence = loop.mode === "interval" ? `every ${formatInterval(loop.intervalMs)}` : "dynamic"
  const runs = `runs ${loop.runCount}${loop.maxRuns == null ? "" : `/${loop.maxRuns}`}`
  let next = ""
  if (loop.status === "active") {
    next = loop.nextRunAt != null ? `, next in ${formatCountdown(loop.nextRunAt - nowMs)}` : ", awaiting schedule"
  }
  return `${loop.id} ${cadence}, ${runs}${next}`
}

function currentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast({ title: "Loop", message, variant, duration: 2500 })
}

async function sendLoopPrompt(api: TuiPluginApi, sessionID: string, text: string) {
  await api.client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text }],
  })
}

function actionOption(api: TuiPluginApi, sessionID: string, title: string, value: string, description: string, prompt: string) {
  return {
    title,
    value,
    description,
    onSelect: () => {
      void sendLoopPrompt(api, sessionID, prompt)
        .then(() => api.ui.dialog.clear())
        .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
    },
  }
}

function showSummary(api: TuiPluginApi, sessionID: string, loops: LoopSnapshot[]) {
  const DialogSelect = api.ui.DialogSelect
  const now = Date.now()
  const open = loops.filter((loop) => loop.status === "active" || loop.status === "paused")
  const options = [
    actionOption(api, sessionID, "Refresh", "refresh", "Ask the agent to list the current loops", "Call list_loops for this session and report each loop briefly."),
    ...open.flatMap((loop) => [
      ...(loop.status === "active"
        ? [
            actionOption(
              api,
              sessionID,
              `Run ${loop.id} now`,
              `run.${loop.id}`,
              loopLine(loop, now),
              `Call run_loop with loop_id "${loop.id}" and report the result briefly.`,
            ),
            actionOption(
              api,
              sessionID,
              `Pause ${loop.id}`,
              `pause.${loop.id}`,
              loopLine(loop, now),
              `Call pause_loop with loop_id "${loop.id}" and report the result briefly.`,
            ),
          ]
        : [
            actionOption(
              api,
              sessionID,
              `Resume ${loop.id}`,
              `resume.${loop.id}`,
              loopLine(loop, now),
              `Call resume_loop with loop_id "${loop.id}" and report the result briefly.`,
            ),
          ]),
      actionOption(
        api,
        sessionID,
        `Stop ${loop.id}`,
        `stop.${loop.id}`,
        loopLine(loop, now),
        `Call stop_loop with loop_id "${loop.id}" and report the result briefly.`,
      ),
    ]),
    ...(loops.some((loop) => loop.status === "stopped" || loop.status === "completed")
      ? [actionOption(api, sessionID, "Clear closed loops", "clear", "Delete stopped and completed loops", "Call clear_loops for this session and report how many loops were removed.")]
      : []),
  ]

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    DialogSelect({
      title: "Loops",
      placeholder: open.length === 0 ? "No open loops in this session." : open.map((loop) => loopLine(loop, now)).join("\n"),
      options,
      onSelect(option) {
        option.onSelect?.()
      },
    }),
  )
}

function LoopSidebar(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [nowMs, setNowMs] = createSignal(Date.now())
  const timer = setInterval(() => setNowMs(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const loops = createMemo(() => {
    props.api.state.session.messages(props.sessionID)
    return loopsFromSession(props.api, props.sessionID)
  })
  const open = createMemo(() => loops().filter((loop) => loop.status === "active" || loop.status === "paused"))

  return (
    <Show when={open().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Loops</b>
        </text>
        <For each={open()}>
          {(loop) => (
            <text fg={loop.status === "active" ? theme().textMuted : theme().textMuted}>
              {loop.status === "paused" ? "⏸ " : ""}
              {loopLine(loop, nowMs())}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function registerLoopCommand(api: TuiPluginApi, command: TuiCommand) {
  const modern = api as TuiPluginApi & {
    keymap?: {
      registerLayer?: (layer: {
        commands: {
          namespace: string
          name: string
          title: string
          desc?: string
          category?: string
          run?: () => void
        }[]
        bindings?: unknown[]
      }) => () => void
    }
  }
  if (modern.keymap?.registerLayer) {
    modern.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: command.value,
          title: command.title,
          desc: command.description,
          category: command.category,
          run: command.onSelect,
        },
      ],
      bindings: [],
    })
    return
  }
  api.command?.register(() => [command])
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 126,
    slots: {
      sidebar_content(_ctx, props) {
        return <LoopSidebar api={api} sessionID={props.session_id} />
      },
    },
  })

  registerLoopCommand(api, {
    title: "Loops",
    value: "loop.show",
    category: "Loop",
    description: "View, run, pause, resume, or stop the recurring loops in this session",
    onSelect: () => {
      const sessionID = currentSessionID(api)
      if (!sessionID) {
        toast(api, "Open a session before viewing loops.", "warning")
        return
      }
      showSummary(api, sessionID, loopsFromSession(api, sessionID))
    },
  })
}

export function loopsFromV2Messages(messages: readonly SessionMessageInfo[]): LoopSnapshot[] | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message || message.type !== "assistant") continue
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex]
      if (!part || part.type !== "tool" || !LOOP_TOOLS.includes(part.name)) continue
      if (part.state.status !== "completed") continue
      for (const content of part.state.content) {
        if (content.type !== "text") continue
        try {
          const parsed: unknown = JSON.parse(content.text)
          if (isRecord(parsed) && isLoopList(parsed.loops)) return parsed.loops
        } catch {
          // Malformed output from a newer tool call should not hide an older valid snapshot.
        }
      }
    }
  }
  return undefined
}

function currentSessionIDV2(api: TuiPluginV2.Context) {
  const route = api.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

function toastV2(api: TuiPluginV2.Context, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast.show({ title: "Loop", message, variant, duration: 2500 })
}

function promptForAction(action: string, loopID?: string) {
  if (action === "refresh") return "Call list_loops for this session and report each loop briefly."
  if (action === "clear") return "Call clear_loops for this session and report how many loops were removed."
  if (!loopID) return undefined
  if (action === "run") return `Call run_loop with loop_id "${loopID}" and report the result briefly.`
  if (action === "pause") return `Call pause_loop with loop_id "${loopID}" and report the result briefly.`
  if (action === "resume") return `Call resume_loop with loop_id "${loopID}" and report the result briefly.`
  if (action === "stop") return `Call stop_loop with loop_id "${loopID}" and report the result briefly.`
  return undefined
}

async function showSummaryV2(api: TuiPluginV2.Context, sessionID: string, loops: LoopSnapshot[]) {
  const now = Date.now()
  const open = loops.filter((loop) => loop.status === "active" || loop.status === "paused")
  const options = [
    { title: "Refresh", value: "refresh", description: "Ask the agent to list the current loops" },
    ...open.flatMap((loop) => [
      ...(loop.status === "active"
        ? [
            { title: `Run ${loop.id} now`, value: `run.${loop.id}`, description: loopLine(loop, now) },
            { title: `Pause ${loop.id}`, value: `pause.${loop.id}`, description: loopLine(loop, now) },
          ]
        : [{ title: `Resume ${loop.id}`, value: `resume.${loop.id}`, description: loopLine(loop, now) }]),
      { title: `Stop ${loop.id}`, value: `stop.${loop.id}`, description: loopLine(loop, now) },
    ]),
    ...(loops.some((loop) => loop.status === "stopped" || loop.status === "completed")
      ? [{ title: "Clear closed loops", value: "clear", description: "Delete stopped and completed loops" }]
      : []),
  ]

  api.ui.dialog.set({ size: "large" })
  const selected = await api.ui.dialog.select({
    title: "Loops",
    placeholder: open.length === 0 ? "No open loops in this session." : open.map((loop) => loopLine(loop, now)).join("\n"),
    options,
  })
  if (!selected) return
  const separator = selected.indexOf(".")
  const action = separator === -1 ? selected : selected.slice(0, separator)
  const loopID = separator === -1 ? undefined : selected.slice(separator + 1)
  const prompt = promptForAction(action, loopID)
  if (!prompt) return
  try {
    await api.client.session.prompt({ sessionID, text: prompt })
  } catch (error) {
    toastV2(api, error instanceof Error ? error.message : String(error), "error")
  }
}

function LoopSidebarV2(api: TuiPluginV2.Context, sessionID: string) {
  const [cache, setCache] = api.storage.memory<{ loops: LoopSnapshot[] }>(`loop-mode.v2.${sessionID}`, {
    initial: { loops: [] },
  })
  const loops = createMemo(() => {
    const found = loopsFromV2Messages(api.data.session.message.list(sessionID))
    return found ?? cache.loops
  })
  createEffect(() => {
    const found = loopsFromV2Messages(api.data.session.message.list(sessionID))
    if (!found) return
    untrack(() =>
      setCache((draft) => {
        draft.loops = found
      }),
    )
  })
  const open = createMemo(() => loops().filter((loop) => loop.status === "active" || loop.status === "paused"))
  const [nowMs, setNowMs] = createSignal(Date.now())
  createEffect(() => {
    if (!open().some((loop) => loop.status === "active")) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return box({}, [() => {
    const loops = open()
    if (loops.length === 0) return null
    return box({}, [
      text({ fg: api.theme.text.default }, ["Loops"]),
      ...loops.map((loop) =>
        text({ fg: api.theme.text.subdued }, [
          `${loop.status === "paused" ? "paused " : ""}${loopLine(loop, nowMs())}`,
        ]),
      ),
    ])
  }])
}

function LoopKeymapLayerV2(api: TuiPluginV2.Context) {
  api.keymap.layer(() => ({
    commands: [
      {
        id: "loop.show",
        title: "Loops",
        description: "View, run, pause, resume, or stop the recurring loops in this session",
        group: "Loop",
        palette: true,
        run: () => {
          const sessionID = currentSessionIDV2(api)
          if (!sessionID) {
            toastV2(api, "Open a session before viewing loops.", "warning")
            return
          }
          const loops = loopsFromV2Messages(api.data.session.message.list(sessionID)) ?? []
          void showSummaryV2(api, sessionID, loops)
        },
      },
    ],
  }))
  return null
}

export function setupTuiV2(context: TuiPluginV2.Context): TuiPluginV2.Cleanup {
  const offSidebar = context.ui.slot("sidebar.content", (props) => LoopSidebarV2(context, props.sessionID))
  const offApp = context.ui.slot("app", () => LoopKeymapLayerV2(context))
  return () => {
    offSidebar()
    offApp()
  }
}

const plugin: TuiPluginModule & TuiPluginV2.Definition = {
  id: "local.loop-mode.tui",
  tui,
  setup: setupTuiV2,
}

export default plugin
