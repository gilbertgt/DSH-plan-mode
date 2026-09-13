import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileCaptured } from '../../src/platform/captured-exec.ts'
import { packageManagerLauncher, resolveValidationExecutable } from '../../src/validation/launcher.ts'

const isWindows = process.platform === 'win32'

/**
 * The real PowerShell this host actually has, most preferred first: PowerShell 7
 * (`pwsh`) when installed, otherwise the Windows PowerShell 5.1 that ships with
 * every supported Windows image. Selection happens once, here, and the chosen
 * label travels into the test names below, so a run never claims live coverage
 * of a shell this host did not have.
 *
 * The probe uses `stdio: 'ignore'` only: a confined Windows grandchild may not
 * open libuv's named-pipe stdio, but ignored stdio carries no pipe to open. If
 * this probe were to capture output it would fail inside DSH's sandbox and
 * silently downgrade three tests to skips. It stays synchronous because it runs
 * during module evaluation to compute each test's `skip` option.
 */
function detectRealShell() {
  const windowsPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return [
    { command: 'pwsh', label: 'PowerShell 7 (pwsh)' },
    { command: windowsPowerShell, label: 'Windows PowerShell 5.1 (powershell.exe)' },
  ].find(candidate => {
    try {
      const result = spawnSync(candidate.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        // CREATE_NO_WINDOW is not compatible with DSH's restricted token.
        windowsHide: false,
      })
      if (result.error) return false
      return result.status === 0
    } catch { return false }
  })
}

const liveShell = isWindows ? detectRealShell() : undefined
const shellLabel = liveShell?.label ?? 'PowerShell'
const liveSkip = !isWindows ? 'Windows-only host behavior' : (liveShell ? false : 'no PowerShell executable on this host')

/**
 * Run one command through the host's real PowerShell and capture its output.
 *
 * Capturing output is the point of these tests, and on Windows the libuv
 * named-pipe stdio that `execFileSync({ stdio: 'pipe' })` creates is unavailable
 * to a confined grandchild. `execFileCaptured` selects file-backed stdio under
 * the sandbox marker and ordinary `execFile` everywhere else, so both the
 * sandboxed and the plain host exercise the launcher exactly.
 */
async function runInPowerShell(command, cwd) {
  return (await execFileCaptured(liveShell.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd })).stdout.toString('utf8')
}

/**
 * Extract the diagnostic text from a captured subprocess failure.
 *
 * `execFileCaptured` attaches Buffer stdout/stderr to its Command-failed error.
 * `String(buffer)` happens to equal `buffer.toString('utf8')` for UTF-8 data,
 * but naming the Buffer case explicitly keeps the diagnostic exact and survives
 * a future seam that returns a different encoding or a non-Buffer shape.
 */
function errorText(error) {
  const stderr = error?.stderr
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8')
  return String(stderr ?? error?.message ?? error)
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

    // The resolved command must actually run the package script.
    assert.match(await runInPowerShell(executableCommand, d), /LAUNCHER-OK/)

    // Guard the regression directly: on a host whose Execution Policy blocks
    // script files, the unsuffixed form is what Issue #37 observed failing. If
    // this host allows npm.ps1 the assertion is inverted so the test stays
    // meaningful on permissive images instead of silently proving nothing.
    let unsuffixedBlocked = false
    try { await runInPowerShell('npm run launcher-probe', d) }
    catch (error) { unsuffixedBlocked = /PSSecurityException|running scripts is disabled|cannot be loaded/i.test(errorText(error)) }
    if (unsuffixedBlocked) {
      // `runInPowerShell` is async, so its failure arrives as a rejected
      // promise. `assert.throws` cannot observe that: handed an async thunk it
      // raises `ERR_ASSERTION: Missing expected exception` while the rejection
      // escapes as an unhandled rejection. `assert.rejects` is the tool that
      // actually matches the diagnostic.
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

// This asserts the form launcher selection can emit on this host — never a
// PowerShell script, always one of the documented `.cmd`/`.exe` names. It
// deliberately does not claim yarn, bun, or pnpm are installed: requiring them
// would force every CI image to carry a toolchain this project does not use.
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
