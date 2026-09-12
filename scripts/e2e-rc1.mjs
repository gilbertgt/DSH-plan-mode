import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import net from 'node:net'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('npm_execpath unavailable; run rc.1 E2E through npm')
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dirname(dshPackage), 'lib', 'bin.js')
const home = mkdtempSync(join(tmpdir(), 'planx-dsh-home-'))
const profile = 'planx-e2e'
const env = { ...process.env, DSH_HOME: home, NO_COLOR: '1', CI: '1' }

// pnpm 12.3+ publishes `pnpm` as a placeholder that its lifecycle replaces
// with a native executable. CI intentionally installs dependencies with
// --ignore-scripts, so on Windows the generated pnpm.cmd would otherwise ask
// Node to parse that placeholder/native target. pnpm also ships a stable JS
// wrapper at bin/pnpm.mjs; expose that through a test-local cmd shim instead.
if (process.platform === 'win32') {
  const pnpmWrapper = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  if (!existsSync(pnpmWrapper)) throw new Error(`pnpm JS wrapper missing: ${pnpmWrapper}`)
  const shimDir = join(home, 'test-bin')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(join(shimDir, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "${pnpmWrapper}" %*\r\n`, 'utf8')
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = `${shimDir}${delimiter}${process.env[pathKey] ?? ''}`
}

function command(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}
function npmCommand(args, options) { return command(process.execPath, [npmCli, ...args], options) }
function dsh(args, options) { return command(process.execPath, [dshBin, ...args], options) }
function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`${label} missing ${needle}`)
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise(resolveClose => server.close(resolveClose))
  if (!port) throw new Error('failed to allocate loopback port')
  return port
}
async function waitForPort(port, child, output, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited before listening (${child.exitCode})\n${output()}`)
    const open = await new Promise(resolveOpen => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolveOpen(true) })
      socket.once('error', () => resolveOpen(false))
      socket.setTimeout(500, () => { socket.destroy(); resolveOpen(false) })
    })
    if (open) return
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`dsh web did not listen within ${timeoutMs}ms\n${output()}`)
}
async function stopTree(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  }
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 3_000)),
  ])
  if (child.exitCode === null && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  }
}

const suppliedTarball = process.env.PLANX_TARBALL ? resolve(root, process.env.PLANX_TARBALL) : undefined
let tarball
let ownsTarball = false
try {
  let packedPaths
  if (suppliedTarball) {
    if (!existsSync(suppliedTarball)) throw new Error(`supplied release tarball missing: ${suppliedTarball}`)
    tarball = suppliedTarball
    const entries = command('tar', ['-tf', tarball]).split(/\r?\n/).filter(Boolean)
    packedPaths = new Set(entries
      .filter(entry => entry.startsWith('package/') && !entry.endsWith('/'))
      .map(entry => entry.slice('package/'.length)))
  } else {
    const packed = JSON.parse(npmCommand(['pack', '--json', '--ignore-scripts']))[0]
    if (!packed?.filename) throw new Error('npm pack produced no tarball')
    tarball = resolve(root, packed.filename)
    ownsTarball = true
    packedPaths = new Set((packed.files ?? []).map(entry => entry.path))
  }
  for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'compatibility.json']) {
    if (!packedPaths.has(required)) throw new Error(`tarball missing ${required}`)
  }

  // Create a fresh custom Web profile from DSH's shipped rc.1 template before
  // installing the out-of-tree plugin. `dsh plugin` alone initializes a base
  // profile, which has no Web listener to exercise in the boot smoke below.
  dsh(['--profile', profile, '--from-default-profile', 'web', '--help'])

  // Real install into the fresh named Web profile.
  dsh(['plugin', '--profile', profile, 'add', tarball, '--ignore-scripts'])
  const dump = dsh(['--profile', profile, '--dump-config'])
  assertIncludes(dump, '@gilbertgt/dsh-plan-orchestrator', 'installed profile')
  assertIncludes(dump, '@deepseek-ai/dsh-plan-mode', 'native Plan Mode composition')

  // Web boot smoke: prove the installed bundle composes far enough to bind a
  // loopback listener. No browser is opened and no model request is made.
  const port = await freePort()
  let stdout = '', stderr = ''
  const child = spawn(process.execPath, [dshBin, '--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64 * 1024) })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024) })
  try { await waitForPort(port, child, () => `${stdout}\n${stderr}`) }
  finally { await stopTree(child) }

  if (process.env.PLANX_COEXISTENCE === '1') {
    dsh(['plugin', '--profile', profile, 'add', 'dsh-codex-subscription@2.0.1', '@mars-sea/dsh-commandcode-provider@0.10.5', '--ignore-scripts'])
    const coexist = dsh(['--profile', profile, '--dump-config'])
    assertIncludes(coexist, '@gilbertgt/dsh-plan-orchestrator', 'coexistence profile')
    assertIncludes(coexist, 'dsh-codex-subscription', 'Codex subscription coexistence')
    assertIncludes(coexist, '@mars-sea/dsh-commandcode-provider', 'CommandCode coexistence')
  }

  // Uninstall smoke: removing our package must not require destructive profile cleanup.
  dsh(['plugin', '--profile', profile, 'remove', '@gilbertgt/dsh-plan-orchestrator', '--ignore-scripts'])
  const afterRemove = dsh(['--profile', profile, '--dump-config'])
  if (afterRemove.includes("name: '@gilbertgt/dsh-plan-orchestrator'")) throw new Error('plugin still present after uninstall')
  console.log(`rc.1 tarball install / profile / web boot / uninstall smoke OK${suppliedTarball ? ' (verified release artifact)' : ''}`)
} finally {
  if (ownsTarball && tarball && existsSync(tarball)) { try { unlinkSync(tarball) } catch {} }
  rmSync(home, { recursive: true, force: true })
}
