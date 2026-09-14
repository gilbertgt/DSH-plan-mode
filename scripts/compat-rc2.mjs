/**
 * Compatibility verification against a genuinely composed rc.2 runtime.
 *
 * The previous lane overlaid 20 rc.2 packages onto an rc.1 workspace with
 * `--force` and then ran no tests, which proved nothing: the remaining rc.1
 * dependencies still had to resolve, the peer mismatch was suppressed rather
 * than solved, and a lane that runs no tests cannot fail for a broken plugin.
 *
 * This lane builds a real rc.2 consumer instead — a fresh project whose only
 * DSH dependencies are rc.2 — installs the packed tarball into it, and asserts
 * the resolved inventory. That is the shape of a front-line user's install, and
 * it either resolves or it does not.
 *
 * Usage:
 *   node scripts/compat-rc2.mjs
 *   PLANX_TARBALL=<path>   # verify an existing artifact instead of packing
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RC2 = '0.1.5-rc.2'
const npmCli = process.env.npm_execpath

/** Every DSH package the plugin declares, so the consumer is complete. */
function declaredDshPackages() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const names = new Set()
  for (const section of ['peerDependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh')) names.add(name)
    }
  }
  return [...names].sort()
}

function npm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

function fail(message) {
  throw new Error(`rc.2 compatibility failed: ${message}`)
}

const suppliedTarball = process.env.PLANX_TARBALL ? resolve(root, process.env.PLANX_TARBALL) : undefined
const consumer = mkdtempSync(join(tmpdir(), 'planx-rc2-consumer-'))
let packedTarball

try {
  if (!npmCli) fail('npm_execpath unavailable; run this lane through npm')

  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'planx-rc2-consumer',
    version: '1.0.0',
    private: true,
  }, null, 2)}\n`)

  // A pure rc.2 graph, installed without --force and without --legacy-peer-deps:
  // the declared peer ranges must accept rc.2 on their own.
  const runtime = declaredDshPackages().map(name => `${name}@${RC2}`)
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...runtime], { cwd: consumer })

  if (suppliedTarball) {
    if (!existsSync(suppliedTarball)) fail(`supplied tarball missing: ${suppliedTarball}`)
    packedTarball = suppliedTarball
  } else {
    const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts'], { cwd: root }))[0]
    if (!packed?.filename) fail('npm pack produced no tarball')
    packedTarball = join(root, packed.filename)
  }

  // Installing the plugin into the rc.2 consumer is the assertion that matters:
  // a peer range that does not accept rc.2 fails here rather than in the field.
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', packedTarball], { cwd: consumer })

  const installed = join(consumer, 'node_modules', '@gilbertgt', 'dsh-plan-orchestrator')
  if (!existsSync(join(installed, 'package.json'))) fail('the plugin was not installed into the rc.2 consumer')
  for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'compatibility.json']) {
    if (!existsSync(join(installed, ...required.split('/')))) fail(`installed plugin is missing ${required}`)
  }

  // The runtime really is homogeneous rc.2: a mixed graph is the hybrid the
  // live Web profile ran, and no single result describes it.
  const inventory = new Map()
  for (const name of declaredDshPackages()) {
    const manifest = join(consumer, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(manifest)) continue
    inventory.set(name, JSON.parse(readFileSync(manifest, 'utf8')).version)
  }
  if (inventory.size === 0) fail('no DSH package resolved in the consumer')
  const mixed = [...inventory.entries()].filter(([, version]) => version !== RC2)
  if (mixed.length > 0) {
    fail(`consumer resolved a mixed runtime: ${mixed.map(([name, version]) => `${name}@${version}`).join(', ')}`)
  }

  const declared = JSON.parse(readFileSync(join(installed, 'compatibility.json'), 'utf8'))
  if (!declared.supported?.includes(RC2)) fail(`${RC2} is not declared as supported in the shipped compatibility.json`)

  process.stdout.write(`rc.2 consumer OK (${inventory.size} DSH packages at ${RC2}, plugin installed and composed)\n`)
} finally {
  if (!suppliedTarball && packedTarball && existsSync(packedTarball)) {
    try { rmSync(packedTarball, { force: true }) } catch { /* the artifact is not this lane's to keep */ }
  }
  rmSync(consumer, { recursive: true, force: true })
}
