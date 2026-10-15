import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const PACKAGE_NAME = "@prevalentware/opencode-loop-plugin"

function configDir() {
  if (process.env.XDG_CONFIG_HOME) return resolve(process.env.XDG_CONFIG_HOME, "opencode")
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "..", "Local", "opencode")
  const base = process.platform === "win32" ? join(homedir(), "AppData", "Local") : join(homedir(), ".config")
  return join(base, "opencode")
}

function readJson(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new Error(`invalid JSON: ${path}`)
  }
}

function ensurePluginList(value) {
  if (value == null) return []
  if (Array.isArray(value)) return value
  throw new Error(`"plugins" must be an array`)
}

function pluginKey(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return null
}

function addPlugin(list, pkg) {
  if (list.some((entry) => pluginKey(entry) === pkg)) return { list, added: false }
  return { list: [...list, pkg], added: true }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function main() {
  const args = process.argv.slice(2)
  const projectDir = args.includes("--project") ? resolve(args[args.indexOf("--project") + 1] ?? ".") : null
  const pkg = args.includes("--package") ? args[args.indexOf("--package") + 1] : PACKAGE_NAME
  if (!pkg) throw new Error("missing package name")

  const targets = []
  if (projectDir) {
    targets.push({ kind: "server(project)", path: join(projectDir, "opencode.json") })
  } else {
    targets.push({ kind: "server(global)", path: join(configDir(), "opencode.json") })
  }
  targets.push({ kind: "tui", path: join(configDir(), "cli.json") })

  for (const target of targets) {
    const current = readJson(target.path)
    const { list, added } = addPlugin(ensurePluginList(current.plugins), pkg)
    if (added) {
      writeJson(target.path, { ...current, plugins: list })
      console.log(`added ${pkg} to ${target.kind}: ${target.path}`)
    } else {
      console.log(`already present in ${target.kind}: ${target.path}`)
    }
  }
}

main()
