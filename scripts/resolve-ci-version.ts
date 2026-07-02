import { readFile, writeFile } from "node:fs/promises"

type PackageJson = {
  name: string
  version: string
}

function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!match) throw new Error(`Unsupported semver version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function bumpPatch(version: string) {
  const parsed = parseVersion(version)
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

async function latestPublishedVersion(name: string) {
  const encoded = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
  const response = await fetch(`https://registry.npmjs.org/${encoded}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`npm registry lookup failed for ${name}: ${response.status} ${response.statusText}`)

  const data = (await response.json()) as { "dist-tags"?: { latest?: unknown } }
  const latest = data["dist-tags"]?.latest
  return typeof latest === "string" ? latest : null
}

const packagePath = new URL("../package.json", import.meta.url)
const pkg = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson
const latest = await latestPublishedVersion(pkg.name)
const next = latest && compareVersions(latest, pkg.version) >= 0 ? bumpPatch(latest) : pkg.version

if (next !== pkg.version) {
  pkg.version = next
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
}

console.log(`Publishing ${pkg.name}@${next}${latest ? ` (latest on npm: ${latest})` : " (first publish)"}`)
