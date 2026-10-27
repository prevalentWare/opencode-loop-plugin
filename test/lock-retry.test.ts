import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

for (const scenario of ["release-read", "release-remove", "release-exhausted", "owner-partial", "late-handoff", "read-budget"]) {
  test(`lock protocol recovers safely from ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-lock-fault-"))
    try {
      const file = join(directory, "loops.json")
      const script = join(directory, "fault.ts")
      await writeFile(script, `
        import { mock } from "bun:test"
        import * as filesystem from "node:fs/promises"
        const fs = { ...filesystem }
        const scenario = ${JSON.stringify(scenario)}
        const file = ${JSON.stringify(file)}
        const lock = file + ".lock"
        const originalNow = Date.now
        let clock = originalNow()
        let faults = 0
        let links = 0
        let retrying = false
        const denied = () => Object.assign(new Error("injected lock failure"), { code: "EPERM" })
        Date.now = () => clock
        mock.module("node:fs/promises", () => ({
          ...fs,
          writeFile: async (path, value, options) => {
            if (scenario === "owner-partial" && String(path).includes(".lock.owner.") && faults++ === 0) {
              await fs.writeFile(path, "", options)
              throw denied()
            }
            return fs.writeFile(path, value, options)
          },
          link: async (source, target) => {
            if (target === lock) {
              links++
              if (scenario === "read-budget" || (scenario === "late-handoff" && links === 1)) {
                throw Object.assign(new Error("contended"), { code: "EEXIST" })
              }
              if (scenario === "late-handoff" && links === 2) { faults++; throw denied() }
            }
            return fs.link(source, target)
          },
          readFile: async (path, options) => {
            if (path === lock) {
              if (scenario === "late-handoff" && links === 1) {
                clock += 6000
                return process.pid + "-00000000-0000-0000-0000-000000000000"
              }
              if (scenario === "read-budget") { faults++; clock += 1000; throw denied() }
              if (scenario === "release-read" && faults++ === 0) throw denied()
              if (scenario === "release-exhausted" && !retrying) { faults++; clock += 6000; throw denied() }
            }
            return fs.readFile(path, options)
          },
          rm: async (path, options) => {
            if (scenario === "release-remove" && path === lock && faults++ < 2) throw denied()
            return fs.rm(path, options)
          },
        }))
        const state = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/state.ts")).href)})
        try {
          if (scenario === "read-budget") {
            let rejected = false
            try { await state.createLoop("ses_fault", { prompt: "tick", intervalMs: 1000 }) }
            catch { rejected = true }
            if (!rejected || faults > 7) throw new Error("transient read exceeded its 5s budget: " + faults)
          } else {
            await state.createLoop("ses_fault", { prompt: "first", intervalMs: 1000 })
            retrying = true
            await state.createLoop("ses_fault", { prompt: "second", intervalMs: 1000 })
            const loops = await state.listLoops("ses_fault")
            if (loops.length !== 2 || faults === 0) throw new Error("mutations did not recover")
          }
          const leftovers = (await fs.readdir(${JSON.stringify(directory)})).filter(x => x.includes(".lock"))
          if (leftovers.length) throw new Error("lock leftovers: " + leftovers.join(","))
        } finally { Date.now = originalNow }
      `)
      const child = Bun.spawn([process.execPath, script], {
        env: { ...process.env, OPENCODE_LOOP_STATE_PATH: file }, stdout: "pipe", stderr: "pipe",
      })
      const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      expect(code, error).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
