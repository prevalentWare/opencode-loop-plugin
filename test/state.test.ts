import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  acquireLoopOwner,
  acquireSessionLease,
  claimDueRunOwned,
  clearClosedLoops,
  confirmRunClaim,
  createLoop,
  formatInterval,
  formatLoops,
  getLoop,
  listLoops,
  activeLoops,
  parseInterval,
  pauseLoop,
  ownsSessionLease,
  recordRunDeferred,
  recordRunSentClaimed,
  recordRunFailedClaimed,
  recordRunDeferredClaimed,
  rescheduleDynamicIfUnchanged,
  stopLoopClaimed,
  recordRunFailed,
  recordRunSent,
  releaseSessionLease,
  renewSessionLease,
  resumeLoop,
  scheduleNextRun,
  stopLoop,
  stopLoopIfUnchanged,
  stopLoopsForSession,
} from "../src/state"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-loop-plugin-"))
  process.env.OPENCODE_LOOP_STATE_PATH = join(dir, "loops.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_LOOP_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("parses intervals with supported units", () => {
  expect(parseInterval("30s")).toBe(30_000)
  expect(parseInterval("10m")).toBe(600_000)
  expect(parseInterval("2h")).toBe(7_200_000)
  expect(parseInterval("1d")).toBe(86_400_000)
  expect(parseInterval("5 minutes", 0)).toBe(300_000)
  expect(parseInterval("1s", 1)).toBe(1000)
})

test("rejects invalid or out-of-range intervals", () => {
  expect(() => parseInterval("banana")).toThrow("invalid interval")
  expect(() => parseInterval("10")).toThrow("invalid interval")
  expect(() => parseInterval("5s")).toThrow("below the minimum")
  expect(() => parseInterval("8d")).toThrow("above the maximum")
  expect(() => parseInterval("0m", 0)).toThrow("greater than zero")
})

test("formats intervals back to compact strings", () => {
  expect(formatInterval(600_000)).toBe("10m")
  expect(formatInterval(90_000)).toBe("90s")
  expect(formatInterval(3_600_000)).toBe("1h")
  expect(formatInterval(null)).toBe("dynamic")
})

test("atomically acquires, revises, validates, and releases session leases", async () => {
  const first = await acquireSessionLease("ses_1", "instance-a", 60_000)
  expect(first?.revision).toBe(1)
  expect(await acquireSessionLease("ses_1", "instance-b", 60_000)).toBeNull()
  expect(await ownsSessionLease("ses_1", "instance-a", first!.revision)).toBe(true)

  const renewed = await renewSessionLease("ses_1", "instance-a", first!.revision, 60_000)
  expect(renewed?.revision).toBe(1)
  expect(await ownsSessionLease("ses_1", "instance-a", first!.revision)).toBe(true)
  expect(await releaseSessionLease("ses_1", "instance-a", renewed!.revision)).toBe(true)
  expect((await acquireSessionLease("ses_1", "instance-b", 60_000))?.instanceID).toBe("instance-b")
})

test("only one process can acquire a session lease", async () => {
  const worker = join(dir, "acquire.ts")
  await writeFile(
    worker,
    `import { acquireSessionLease } from ${JSON.stringify(join(process.cwd(), "src/state.ts"))}\n` +
      `const lease = await acquireSessionLease("ses_shared", process.argv[2]!, 60_000)\n` +
      `await Bun.write(Bun.stdout, lease ? "acquired\\n" : "denied\\n")\n` +
      `process.exit(0)\n`,
  )
  const results = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const child = Bun.spawn([globalThis.process.execPath, worker, `instance-${index}`], {
        env: { ...Bun.env, OPENCODE_LOOP_STATE_PATH: join(dir, "shared.json") },
        stdout: "pipe",
      })
      const output = await new Response(child.stdout).text()
      expect(await child.exited).toBe(0)
      return output.trim()
    }),
  )
  expect(results.filter((result) => result === "acquired")).toHaveLength(1)
  expect(results.filter((result) => result === "denied")).toHaveLength(7)
}, 15_000)

test("creates, lists, pauses, resumes, and stops a loop", async () => {
  const created = await createLoop("ses_1", { prompt: "check the deploy", intervalMs: 600_000 })
  expect(created.status).toBe("active")
  expect(created.mode).toBe("interval")
  expect(created.nextRunAt).toBeGreaterThan(Date.now())
  expect(created.id).toMatch(/^loop_[a-z0-9]{5}$/)

  const listed = await listLoops("ses_1")
  expect(listed).toHaveLength(1)

  const paused = await pauseLoop(created.id)
  expect(paused.status).toBe("paused")
  expect(paused.nextRunAt).toBeNull()

  const resumed = await resumeLoop(created.id)
  expect(resumed.status).toBe("active")
  expect(resumed.nextRunAt).toBeGreaterThan(Date.now())

  const stopped = await stopLoop(created.id, "purpose achieved")
  expect(stopped.status).toBe("stopped")
  expect(stopped.stopReason).toBe("purpose achieved")
  expect(await activeLoops("ses_1")).toHaveLength(0)
})

test("completes a loop when max runs is reached", async () => {
  const created = await createLoop("ses_1", { prompt: "tick", intervalMs: 60_000, maxRuns: 2 })
  const first = await recordRunSent(created.id)
  expect(first.status).toBe("active")
  expect(first.runCount).toBe(1)
  expect(first.nextRunAt).toBeGreaterThan(Date.now())

  const second = await recordRunSent(created.id)
  expect(second.status).toBe("completed")
  expect(second.runCount).toBe(2)
  expect(second.nextRunAt).toBeNull()
  expect(second.stopReason).toContain("max runs reached")
})

test("dynamic loops schedule one run at a time", async () => {
  const created = await createLoop("ses_1", { prompt: "watch CI", mode: "dynamic" })
  expect(created.mode).toBe("dynamic")
  expect(created.intervalMs).toBeNull()
  expect(created.nextRunAt).toBeNull()

  const scheduled = await scheduleNextRun(created.id, 90_000, "watching CI run")
  expect(scheduled.nextRunAt).toBeGreaterThan(Date.now())
  expect(scheduled.lastReason).toBe("watching CI run")

  const sent = await recordRunSent(created.id)
  expect(sent.nextRunAt).toBeNull()
  expect(sent.runCount).toBe(1)
})

test("conditional dynamic cleanup ignores missing and changed loops", async () => {
  const removed = await createLoop("ses_1", { prompt: "removed", mode: "dynamic" })
  await stopLoop(removed.id)
  await clearClosedLoops("ses_1")
  expect(await stopLoopIfUnchanged(removed.id, removed.updatedAt, "stale after restart")).toBeNull()

  const scheduled = await createLoop("ses_1", { prompt: "scheduled", mode: "dynamic" })
  await scheduleNextRun(scheduled.id, 60_000, "still owned")
  expect(await stopLoopIfUnchanged(scheduled.id, scheduled.updatedAt, "stale after restart")).toBeNull()
  expect((await getLoop(scheduled.id))?.status).toBe("active")
})

test("stale dynamic loops resume with fallback delay instead of stopping", async () => {
  const created = await createLoop("ses_1", { prompt: "watch CI", mode: "dynamic" })
  const resumed = await rescheduleDynamicIfUnchanged(created.id, created.updatedAt, 120_000, "restart fallback")
  expect(resumed?.nextRunAt).toBeGreaterThan(Date.now())
  expect(resumed?.status).toBe("active")
  expect(resumed?.lastReason).toBe("restart fallback")

  const changed = (await getLoop(created.id))!
  expect(await rescheduleDynamicIfUnchanged(created.id, created.updatedAt, 120_000, "stale")).toBeNull()
  expect(changed.nextRunAt).not.toBeNull()
})

test("serializes state mutations across processes", async () => {
  const script = `
    import { createLoop } from "./src/state.ts"
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      createLoop("session_" + process.pid + "_" + index, { prompt: "tick", intervalMs: 60000 })
    ))
  `
  const options = {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  }
  const children = [
    Bun.spawn([process.execPath, "-e", script], options),
    Bun.spawn([process.execPath, "-e", script], options),
  ]
  const exits = await Promise.all(children.map((child) => child.exited))
  expect(exits).toEqual([0, 0])
  expect(await listLoops()).toHaveLength(24)
})

test("recordRunSent does not resurrect stopped or paused loops", async () => {
  const created = await createLoop("ses_1", { prompt: "tick", intervalMs: 60_000 })
  await stopLoop(created.id, "done")

  const sent = await recordRunSent(created.id)
  expect(sent.status).toBe("stopped")
  expect(sent.runCount).toBe(0)
  expect(sent.nextRunAt).toBeNull()
})

test("records deferred and failed runs with retry times", async () => {
  const created = await createLoop("ses_1", { prompt: "tick", intervalMs: 600_000 })
  const deferred = await recordRunDeferred(created.id, "skipped_busy", 5000)
  expect(deferred.lastResult).toBe("skipped_busy")
  expect(deferred.nextRunAt).toBeLessThanOrEqual(Date.now() + 5000)

  const failed = await recordRunFailed(created.id, "network exploded", 5000)
  expect(failed.lastResult).toBe("failed")
  expect(failed.lastError).toBe("provider/model request failed")
  expect(failed.consecutiveFailures).toBe(1)
  expect(failed.nextRetryAt).toBe(failed.nextRunAt)
  expect(failed.status).toBe("active")

  const second = await recordRunFailed(created.id, "secret provider response", 5000)
  expect(second.nextRetryAt! - second.updatedAt).toBe(10_000)
  const recovered = await recordRunSent(created.id)
  expect(recovered.consecutiveFailures).toBe(0)
  expect(recovered.nextRetryAt).toBeNull()
  expect(recovered.lastError).toBeNull()
})

test("pauses loops after the bounded consecutive failure threshold", async () => {
  const created = await createLoop("ses_1", { prompt: "tick", intervalMs: 600_000 })
  await recordRunFailed(created.id, "sensitive one", 1000, 2, 1500)
  const blocked = await recordRunFailed(created.id, "sensitive two", 1000, 2, 1500)
  expect(blocked.status).toBe("paused")
  expect(blocked.nextRunAt).toBeNull()
  expect(blocked.nextRetryAt).toBeNull()
  expect(blocked.blockedReason).toContain("2 consecutive")
  expect(blocked.lastError).not.toContain("sensitive")
})

test("fences a claimed run when its owner lease is replaced", async () => {
  const created = await createLoop("ses_1", { prompt: "tick", intervalMs: 60_000 })
  await scheduleNextRun(created.id, 1)
  await Bun.sleep(5)

  const ownerA = await acquireLoopOwner(created.id, "owner-a", 1000)
  expect(ownerA).not.toBeNull()
  const claimA = await claimDueRunOwned(created.id, ownerA!, 30_000)
  expect(claimA).not.toBeNull()
  expect(await confirmRunClaim(created.id, claimA!)).not.toBeNull()

  await Bun.sleep(1200)
  const ownerB = await acquireLoopOwner(created.id, "owner-b", 30_000)
  expect(ownerB?.ownerRevision).toBeGreaterThan(ownerA!.ownerRevision)
  expect(await confirmRunClaim(created.id, claimA!)).toBeNull()
  expect(await recordRunSentClaimed(created.id, claimA!)).toBeNull()
  expect((await getLoop(created.id))?.runCount).toBe(0)
})

test("owner-aware claims reject a non-current lease", async () => {
  const created = await createLoop("ses_1", { prompt: "tick", intervalMs: 60_000 })
  await scheduleNextRun(created.id, 1)
  await Bun.sleep(5)
  const owner = await acquireLoopOwner(created.id, "owner-a", 30_000)
  expect(owner).not.toBeNull()
  expect(
    await claimDueRunOwned(created.id, { ownerID: "owner-a", ownerRevision: owner!.ownerRevision + 1 }, 30_000),
  ).toBeNull()
})

test("enforces the per-session open loop limit", async () => {
  await createLoop("ses_1", { prompt: "a", intervalMs: 60_000, maxLoopsPerSession: 2 })
  await createLoop("ses_1", { prompt: "b", intervalMs: 60_000, maxLoopsPerSession: 2 })
  await expect(createLoop("ses_1", { prompt: "c", intervalMs: 60_000, maxLoopsPerSession: 2 })).rejects.toThrow(
    "already has 2 open loop(s)",
  )
  await createLoop("ses_2", { prompt: "c", intervalMs: 60_000, maxLoopsPerSession: 2 })
})

test("validates the loop instruction", async () => {
  await expect(createLoop("ses_1", { prompt: "   ", intervalMs: 60_000 })).rejects.toThrow("must not be empty")
  await expect(createLoop("ses_1", { prompt: "x".repeat(4001), intervalMs: 60_000 })).rejects.toThrow("at most 4000")
})

test("stops all open loops for a deleted session", async () => {
  await createLoop("ses_1", { prompt: "a", intervalMs: 60_000 })
  await createLoop("ses_1", { prompt: "b", intervalMs: 60_000 })
  await createLoop("ses_2", { prompt: "c", intervalMs: 60_000 })

  const stopped = await stopLoopsForSession("ses_1", "session deleted")
  expect(stopped).toHaveLength(2)
  expect(stopped.every((loop) => loop.status === "stopped")).toBe(true)
  expect((await activeLoops("ses_2"))).toHaveLength(1)
})

test("clears closed loops but keeps open ones", async () => {
  const open = await createLoop("ses_1", { prompt: "a", intervalMs: 60_000 })
  const closed = await createLoop("ses_1", { prompt: "b", intervalMs: 60_000 })
  await stopLoop(closed.id)

  expect(await clearClosedLoops("ses_1")).toBe(1)
  const remaining = await listLoops("ses_1")
  expect(remaining).toHaveLength(1)
  expect(remaining[0]?.id).toBe(open.id)
})

test("decodes persisted state with optional fields omitted", async () => {
  await writeFile(
    process.env.OPENCODE_LOOP_STATE_PATH!,
    JSON.stringify({
      version: 1,
      loops: {
        loop_abcde: {
          id: "loop_abcde",
          sessionID: "ses_1",
          prompt: "tick",
          intervalMs: 60000,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          nextRunAt: 2,
        },
      },
    }),
  )

  const loop = await getLoop("loop_abcde")
  expect(loop?.mode).toBe("interval")
  expect(loop?.runCount).toBe(0)
  expect(loop?.lastResult).toBeNull()
  expect(loop?.maxRuns).toBeNull()
  expect(loop?.agent).toBeNull()
  expect(loop?.keepAlive).toBe(false)
  expect(loop?.consecutiveFailures).toBe(0)
  expect(loop?.nextRetryAt).toBeNull()
  expect(loop?.blockedReason).toBeNull()
})

test("writes state with owner-only file permissions", async () => {
  await createLoop("ses_1", { prompt: "tick", intervalMs: 60_000 })
  const mode = (await stat(process.env.OPENCODE_LOOP_STATE_PATH!)).mode & 0o777
  if (process.platform === "win32") return
  expect(mode).toBe(0o600)
})

test("does not overwrite corrupt persisted state", async () => {
  await writeFile(process.env.OPENCODE_LOOP_STATE_PATH!, "{not valid json", "utf8")
  await expect(createLoop("ses_1", { prompt: "tick", intervalMs: 60_000 })).rejects.toThrow()
  expect(await readFile(process.env.OPENCODE_LOOP_STATE_PATH!, "utf8")).toBe("{not valid json")
})

test("formats loop lists for reports", async () => {
  expect(formatLoops([])).toBe("No loops exist for this session.")
  const created = await createLoop("ses_1", { prompt: "check the deploy and report status", intervalMs: 600_000 })
  const report = formatLoops(await listLoops("ses_1"))
  expect(report).toContain(created.id)
  expect(report).toContain("every 10m")
  expect(report).toContain("check the deploy")
})


test("session lease renewals preserve claims but ownership transfer fences every transition", async () => {
  const loop = await createLoop("ses_1", { prompt: "tick", intervalMs: 1 })
  const lease = (await acquireSessionLease("ses_1", "a", 60_000))!
  const owner = (await acquireLoopOwner(loop.id, "owner-a", 60_000, lease))!
  await new Promise((resolve) => setTimeout(resolve, 5))
  const claim = (await claimDueRunOwned(loop.id, owner, 60_000))!
  expect(claim).not.toBeNull()
  await renewSessionLease("ses_1", "a", lease.revision, 60_000)
  await acquireSessionLease("ses_1", "a", 60_000)
  expect(await confirmRunClaim(loop.id, claim)).not.toBeNull()
  await releaseSessionLease("ses_1", "a", lease.revision)
  await acquireSessionLease("ses_1", "b", 60_000)
  expect(await confirmRunClaim(loop.id, claim)).toBeNull()
  expect(await recordRunSentClaimed(loop.id, claim)).toBeNull()
  expect(await recordRunFailedClaimed(loop.id, claim, "failure", 1)).toBeNull()
  expect(await recordRunDeferredClaimed(loop.id, claim, "skipped_busy", 1)).toBeNull()
  expect(await stopLoopClaimed(loop.id, claim)).toBeNull()
  expect((await getLoop(loop.id))?.runCount).toBe(0)
})

test("pause, stop, and explicit rescheduling revoke an in-flight claim", async () => {
  for (const control of [pauseLoop, stopLoop, (id: string) => scheduleNextRun(id, 60_000)]) {
    const loop = await createLoop("ses_1", { prompt: "tick", intervalMs: 1 })
    const owner = (await acquireLoopOwner(loop.id, "owner-a", 60_000))!
    await new Promise((resolve) => setTimeout(resolve, 5))
    const claim = (await claimDueRunOwned(loop.id, owner, 60_000))!
    expect(claim).not.toBeNull()
    await control(loop.id)
    expect(await confirmRunClaim(loop.id, claim)).toBeNull()
    if ((await getLoop(loop.id))?.status === "paused") {
      await resumeLoop(loop.id)
      expect(await confirmRunClaim(loop.id, claim)).toBeNull()
    }
  }
})

test("orphan dynamic cleanup is fenced by session ownership", async () => {
  const loop = await createLoop("ses_1", { prompt: "tick", mode: "dynamic" })
  const lease = (await acquireSessionLease("ses_1", "a", 60_000))!
  await releaseSessionLease("ses_1", "a", lease.revision)
  await acquireSessionLease("ses_1", "b", 60_000)
  expect(await stopLoopIfUnchanged(loop.id, loop.updatedAt, "stale", lease)).toBeNull()
  expect((await getLoop(loop.id))?.status).toBe("active")
})

test("maximum failure backoff caps even the first retry", async () => {
  const loop = await createLoop("ses_1", { prompt: "tick", intervalMs: 1 })
  const failed = await recordRunFailed(loop.id, "failure", 60_000, 5, 1000)
  expect(failed.nextRetryAt! - failed.updatedAt).toBe(1000)
  await scheduleNextRun(loop.id, 1)
  const owner = (await acquireLoopOwner(loop.id, "owner-a", 60_000))!
  await new Promise((resolve) => setTimeout(resolve, 5))
  const claim = (await claimDueRunOwned(loop.id, owner, 60_000))!
  const claimedFailure = await recordRunFailedClaimed(loop.id, claim, "failure", 60_000, 5, 1000)
  expect(claimedFailure!.nextRetryAt! - claimedFailure!.updatedAt).toBe(1000)
})

test("recovers a crashed writer lock without stealing a suspended live writer lock", async () => {
  const worker = join(dir, "lock.ts")
  const lock = `${process.env.OPENCODE_LOOP_STATE_PATH}.lock`
  await writeFile(worker, `import { writeFile } from "node:fs/promises"\n` +
    `import { randomUUID } from "node:crypto"\n` +
    `await writeFile(process.argv[2], process.pid + "-" + randomUUID())\n`)
  const child = Bun.spawn([process.execPath, worker, lock], { stdout: "pipe" })
  expect(await child.exited).toBe(0)
  const created = await createLoop("ses_1", { prompt: "tick", mode: "dynamic" })
  expect(created.status).toBe("active")
  const { utimes } = await import("node:fs/promises")
  await writeFile(lock, `${process.pid}-${randomUUID()}`)
  // A 30-second age must not authorize taking a live process's lock.
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  let finished = false
  const pending = createLoop("ses_2", { prompt: "tick", mode: "dynamic" }).then((loop) => { finished = true; return loop })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(finished).toBe(false)
  await rm(lock)
  expect((await pending).status).toBe("active")
})


test("recovers a crashed lock reclaimer", async () => {
  const worker = join(dir, "reclaim.ts")
  const lock = `${process.env.OPENCODE_LOOP_STATE_PATH}.lock`
  await writeFile(worker, `import { writeFile } from "node:fs/promises"\n` +
    `import { randomUUID } from "node:crypto"\n` +
    `const owner = process.pid + "-" + randomUUID()\n` +
    `await writeFile(process.argv[2], owner)\n` +
    `await writeFile(process.argv[2] + ".reclaim." + owner, process.pid + "-" + randomUUID())\n`)
  const child = Bun.spawn([process.execPath, worker, lock], { stdout: "pipe" })
  expect(await child.exited).toBe(0)
  expect((await createLoop("ses_1", { prompt: "tick", mode: "dynamic" })).status).toBe("active")
})

test("a dynamic iteration counts its run without overwriting an equal-timestamp next schedule", async () => {
  const originalNow = Date.now
  let clock = originalNow()
  Date.now = () => clock
  try {
    const loop = await createLoop("ses_1", { prompt: "tick", mode: "dynamic", maxRuns: 2 })
    await scheduleNextRun(loop.id, 1)
    const owner = (await acquireLoopOwner(loop.id, "owner-a", 60_000))!
    clock += 5
    const claim = (await claimDueRunOwned(loop.id, owner, 60_000))!
    expect(await confirmRunClaim(loop.id, claim)).not.toBeNull()
    const scheduled = await scheduleNextRun(loop.id, 60_000)
    expect(scheduled.nextRunAt).toBe(claim.loop.nextRunAt)
    expect(await confirmRunClaim(loop.id, claim)).toBeNull()
    const sent = await recordRunSentClaimed(loop.id, claim)
    expect(sent?.runCount).toBe(1)
    expect(sent?.nextRunAt).toBe(scheduled.nextRunAt)
  } finally {
    Date.now = originalNow
  }
})

test("createLoop records keep-alive futures and defaults them off", async () => {
  const ordinary = await createLoop("ses_1", { prompt: "tick", intervalMs: 60_000 })
  expect(ordinary.keepAlive).toBe(false)

  const durable = await createLoop("ses_1", { prompt: "tick", intervalMs: 60_000, keepAlive: true })
  expect(durable.keepAlive).toBe(true)
})

test("keep-alive loops cannot delegate pacing to the agent", async () => {
  await expect(createLoop("ses_1", { prompt: "tick", mode: "dynamic", keepAlive: true })).rejects.toThrow(
    /keep-alive loops require a fixed interval/,
  )
})
