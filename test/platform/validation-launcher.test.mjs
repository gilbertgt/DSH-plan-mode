import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageManagerLauncher, resolveValidationExecutable } from '../../src/validation/launcher.ts'
import { execFileCaptured } from '../../src/platform/captured-exec.ts'

const isWindows = process.platform === 'win32'

function errorText(error) {
  const stderr = error?.stderr
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8')
  return String(stderr ?? error?.message ?? error)
}

/**
 * The real PowerShell this host actually has, most preferred first: PowerShell 7
 * (`pwsh`) when installed, otherwise the Windows PowerShell 5.1 that ships with
 * every supported Windows image. Selection happens once, here, and the chosen
 * label travels into the test names below, so a run never claims live coverage
 * of a shell this host did not have.
 *
 * execFileCaptured is deliberate: inside authoritative Windows validation the
 * subprocess is already confined, so libuv pipe capture would reproduce the
 * documented nested-pipe EPERM infrastructure failure instead of testing the
 * launcher. Outside that sandbox this helper behaves like ordinary execFile.
 */
async function detectRealShell() {
  const windowsPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  for (const candidate of [
    { command: 'pwsh', label: 'PowerShell 7 (pwsh)' },
    { command: windowsPowerShell, label: 'Windows PowerShell 5.1 (powershell.exe)' },
  ]) {
    try {
      await execFileCaptured(candidate.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'])
      return candidate
    } catch {}
  }
  return undefined
}

const liveShell = isWindows ? await detectRealShell() : undefined
const shellLabel = liveShell?.label ?? 'PowerShell'
const liveSkip = !isWindows ? 'Windows-only host behavior' : (liveShell ? false : 'no PowerShell executable on this host')

async function runInPowerShell(command, cwd) {
  const result = await execFileCaptured(
    liveShell.command,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { cwd },
  )
  return result.stdout.toString('utf8')
}

/**
 * Confirms the selected launcher is runnable on this image before a test asserts
 * through it. The npm regression test below is the one this build must keep
 * exercising, so a host without a working npm skips loudly instead of failing.
 */
async function requireRunnableNpm(t) {
  const launcher = packageManagerLauncher('npm', { platform: 'win32' })
  try { await runInPowerShell(`${launcher} --version`, process.cwd()) }
  catch (error) {
    t.skip(`${launcher} is not runnable on this host: ${errorText(error).split('\n')[0]}`)
    return undefined
  }
  return launcher
}

test(`a resolved Windows launcher reaches the real npm under ${shellLabel}'s Execution Policy`, { skip: liveSkip }, async (t) => {
  const d = await mkdtemp(join(tmpdir(), 'planx-launch-real-'))
  try {
    const npmLauncher = await requireRunnableNpm(t)
    if (!npmLauncher) return

    await writeFile(join(d, 'package.json'), JSON.stringify({
      name: 'planx-launcher-probe', private: true,
      scripts: { 'launcher-probe': 'node -e "console.log(\'LAUNCHER-OK\')"' },
    }, null, 2))

    const { executableCommand } = resolveValidationExecutable('npm run launcher-probe', { platform: 'win32' })
    assert.equal(executableCommand, `${npmLauncher} run launcher-probe`)

    assert.match(await runInPowerShell(executableCommand, d), /LAUNCHER-OK/)

    let unsuffixedBlocked = false
    try { await runInPowerShell('npm run launcher-probe', d) }
    catch (error) { unsuffixedBlocked = /PSSecurityException|running scripts is disabled|cannot be loaded/i.test(errorText(error)) }
    if (unsuffixedBlocked) {
      await assert.rejects(() => runInPowerShell('npm run launcher-probe', d), /PSSecurityException|running scripts is disabled|cannot be loaded/i)
      assert.match(await runInPowerShell(executableCommand, d), /LAUNCHER-OK/)
    }
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test(`a resolved Windows launcher passes script arguments through the real npm under ${shellLabel}`, { skip: liveSkip }, async (t) => {
  const d = await mkdtemp(join(tmpdir(), 'planx-launch-args-'))
  try {
    const npmLauncher = await requireRunnableNpm(t)
    if (!npmLauncher) return

    await writeFile(join(d, 'echo-args.mjs'), 'console.log("ARGS="+JSON.stringify(process.argv.slice(2)))')
    await writeFile(join(d, 'package.json'), JSON.stringify({
      name: 'planx-launcher-args', private: true, scripts: { 'echo-args': 'node echo-args.mjs' },
    }, null, 2))

    const { executableCommand } = resolveValidationExecutable('npm run echo-args -- --flag=1 x', { platform: 'win32' })
    assert.equal(executableCommand, `${npmLauncher} run echo-args -- --flag=1 x`)
    assert.match(await runInPowerShell(executableCommand, d), /ARGS=\["--flag=1","x"\]/)
  } finally {
    await rm(d, { recursive: true, force: true })
  }
})

test('Windows launcher selection never returns, and never escapes, the documented executable forms', { skip: liveSkip }, () => {
  const documented = {
    npm: ['npm.cmd'],
    pnpm: ['pnpm.cmd', 'pnpm.exe'],
    yarn: ['yarn.cmd'],
    bun: ['bun.exe', 'bun.cmd'],
  }
  for (const [manager, forms] of Object.entries(documented)) {
    const launcher = packageManagerLauncher(manager, { platform: 'win32' })
    assert.doesNotMatch(launcher, /\.ps1$/i, `${manager} must never resolve to a PowerShell script`)
    assert.ok(forms.includes(launcher), `${manager} resolved to ${launcher}, outside the documented forms ${forms.join('/')}`)
  }
})
