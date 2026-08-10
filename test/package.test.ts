import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("published TUI runtime imports are production dependencies", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  for (const dependency of ["@opentui/solid", "solid-js"]) {
    expect(packageJson.dependencies?.[dependency]).toBeString()
    expect(packageJson.devDependencies?.[dependency]).toBeUndefined()
  }
})
