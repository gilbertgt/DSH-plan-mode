import fs from 'node:fs'
import { createRequire } from 'node:module'

/**
 * Compatibility is a property of the runtime that actually resolved, not of a
 * JSON declaration.
 *
 * The previous check only asserted that its own manifest listed a version, so a
 * profile running rc.1 and rc.2 side by side — the live Web profile that failed
 * run 4429470e did exactly that — passed this gate while the plugin was
 * genuinely untested against half of its runtime. The resolved inventory is now
 * the subject of the check.
 */
const manifest = JSON.parse(fs.readFileSync(new URL('../compatibility.json', import.meta.url), 'utf8'))
if (!Array.isArray(manifest.supported) || !manifest.supported.includes('0.1.5-rc.1')) throw new Error('rc.1 must remain supported')
if (!Array.isArray(manifest.supported) || !manifest.supported.includes('0.1.5-rc.2')) throw new Error('rc.2 must be supported')
if (!Array.isArray(manifest.preview)) throw new Error('preview must be an array')
for (const version of [...manifest.supported, ...manifest.preview]) {
  if (!/^0\.1\.5-rc\.\d+$/.test(version)) throw new Error(`unexpected declared DSH version: ${version}`)
}

const require = createRequire(import.meta.url)
const CORE = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
]

/** Every resolved DSH package version, or undefined when the package is absent. */
function resolvedVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version
  } catch {
    return undefined
  }
}

const inventory = new Map()
for (const name of CORE) {
  const version = resolvedVersion(name)
  if (version !== undefined) inventory.set(name, version)
}

const declaredSupported = process.env.DSH_VERSION_UNDER_TEST
const versions = [...new Set(inventory.values())]
// The plugin's runtime must be one exact DSH release: a graph that resolves
// rc.1 and rc.2 side by side is the hybrid the live Web profile ran, and no
// single test result describes it.
const homogeneous = versions.length <= 1
const actual = versions[0] ?? '(no DSH packages resolved)'
if (!homogeneous) {
  const detail = [...inventory.entries()].map(([name, version]) => `${name}@${version}`).join(', ')
  throw new Error(`mixed DSH runtime: ${versions.join(', ')} (${detail})`)
}
const subject = declaredSupported ?? actual
if (declaredSupported !== undefined && declaredSupported !== actual) {
  throw new Error(`resolved DSH runtime ${actual} does not match DSH_VERSION_UNDER_TEST ${declaredSupported}`)
}
if (!manifest.supported.includes(subject) && !manifest.preview.includes(subject)) {
  throw new Error(`${subject} is not declared in compatibility.json`)
}
if (!inventory.size) throw new Error('no core DSH package resolved; the compatibility lane cannot prove anything')

console.log(`compatibility manifest OK (resolved DSH ${subject}, ${inventory.size} core package(s) verified)`)
