import { expect, test } from "bun:test"
import { formatCountdown, formatInterval, loopLine } from "../src/tui"

function loop(overrides: Partial<Parameters<typeof loopLine>[0]> = {}) {
  return {
    id: "loop_abcde",
    sessionID: "ses_1",
    prompt: "check the deploy",
    mode: "interval" as const,
    intervalMs: 600_000,
    status: "active" as const,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: 60_000,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastReason: null,
    runCount: 2,
    maxRuns: null,
    agent: null,
    stopReason: null,
    sampledAt: 0,
    ...overrides,
  }
}

test("formats intervals", () => {
  expect(formatInterval(600_000)).toBe("10m")
  expect(formatInterval(null)).toBe("dynamic")
})

test("formats countdowns", () => {
  expect(formatCountdown(30_000)).toBe("30s")
  expect(formatCountdown(90_000)).toBe("1m30s")
  expect(formatCountdown(3_660_000)).toBe("1h01m")
  expect(formatCountdown(-5)).toBe("0s")
})

test("formats loop lines", () => {
  expect(loopLine(loop(), 0)).toBe("loop_abcde every 10m, runs 2, next in 1m00s")
  expect(loopLine(loop({ mode: "dynamic", intervalMs: null, nextRunAt: null }), 0)).toBe(
    "loop_abcde dynamic, runs 2, awaiting schedule",
  )
  expect(loopLine(loop({ status: "paused", maxRuns: 5 }), 0)).toBe("loop_abcde every 10m, runs 2/5")
})
