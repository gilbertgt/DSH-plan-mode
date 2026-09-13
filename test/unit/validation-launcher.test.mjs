import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  packageManagerLauncher,
  resolveValidationExecutable,
} from '../../src/validation/launcher.ts'

/** A probe that reports exactly the named executables as resolvable. */
const available = (...executables) => {
  const set = new Set(executables)
  return name => set.has(name)
}
const nothingAvailable = () => false

test('Windows package-script validation selects an executable launcher, never a PowerShell script', () => {
  const all = available('npm.cmd', 'pnpm.cmd', 'pnpm.exe', 'yarn.cmd', 'bun.exe', 'bun.cmd')
  assert.equal(packageManagerLauncher('npm', { platform: 'win32', probe: all }), 'npm.cmd')
  assert.equal(packageManagerLauncher('pnpm', { platform: 'win32', probe: all }), 'pnpm.cmd')
  assert.equal(packageManagerLauncher('yarn', { platform: 'win32', probe: all }), 'yarn.cmd')
  assert.equal(packageManagerLauncher('bun', { platform: 'win32', probe: all }), 'bun.exe')
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    const launcher = packageManagerLauncher(manager, { platform: 'win32', probe: all })
    assert.doesNotMatch(launcher, /\.ps1$/i, `${manager} must never resolve to a PowerShell script`)
  }
})

test('Windows launcher resolution keeps the documented primary form when nothing is probed', () => {
  assert.equal(packageManagerLauncher('npm', { platform: 'win32', probe: nothingAvailable }), 'npm.cmd')
  assert.equal(packageManagerLauncher('pnpm', { platform: 'win32', probe: nothingAvailable }), 'pnpm.cmd')
  assert.equal(packageManagerLauncher('yarn', { platform: 'win32', probe: nothingAvailable }), 'yarn.cmd')
  assert.equal(packageManagerLauncher('bun', { platform: 'win32', probe: nothingAvailable }), 'bun.exe')
})

test('Windows launcher resolution falls back to the other real form of pnpm and bun', () => {
  // pnpm 12 publishes a native pnpm.exe; bun is bun.exe from the official
  // Windows installer but a bun.cmd shim when installed through npm.
  assert.equal(packageManagerLauncher('pnpm', { platform: 'win32', probe: available('pnpm.exe') }), 'pnpm.exe')
  assert.equal(packageManagerLauncher('bun', { platform: 'win32', probe: available('bun.cmd') }), 'bun.cmd')
  // The primary form still wins when both are present.
  assert.equal(packageManagerLauncher('pnpm', { platform: 'win32', probe: available('pnpm.exe', 'pnpm.cmd') }), 'pnpm.cmd')
  assert.equal(packageManagerLauncher('bun', { platform: 'win32', probe: available('bun.exe', 'bun.cmd') }), 'bun.exe')
})

test('Linux and macOS keep the unsuffixed package-manager launcher', () => {
  const all = available('npm.cmd', 'pnpm.cmd', 'yarn.cmd', 'bun.exe')
  for (const platform of ['linux', 'darwin', 'freebsd', 'aix']) {
    for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
      assert.equal(packageManagerLauncher(manager, { platform, probe: all }), manager)
    }
  }
})

test('Windows rewrites keep the parsed script and arguments, and the logical command', () => {
  const win = { platform: 'win32', probe: available('npm.cmd', 'pnpm.cmd', 'yarn.cmd', 'bun.exe') }
  assert.deepEqual(resolveValidationExecutable('npm test', win), {
    parsed: { manager: 'npm', script: 'test', args: [] },
    command: 'npm test',
    executableCommand: 'npm.cmd test',
  })
  assert.deepEqual(resolveValidationExecutable('npm run typecheck', win), {
    parsed: { manager: 'npm', script: 'typecheck', args: [] },
    command: 'npm run typecheck',
    executableCommand: 'npm.cmd run typecheck',
  })
  assert.deepEqual(resolveValidationExecutable('pnpm run test:unit', win).executableCommand, 'pnpm.cmd run test:unit')
  assert.deepEqual(resolveValidationExecutable('yarn run lint', win).executableCommand, 'yarn.cmd run lint')
  assert.deepEqual(resolveValidationExecutable('bun run test', win).executableCommand, 'bun.exe run test')

  // Arguments survive the rewrite verbatim, including the `--` separator.
  assert.equal(
    resolveValidationExecutable('pnpm run test:unit -- --test-name-pattern=security', win).executableCommand,
    'pnpm.cmd run test:unit -- --test-name-pattern=security',
  )
  // Leading/trailing whitespace is normalized by the parse, not carried through.
  assert.equal(resolveValidationExecutable('  npm run typecheck  ', win).executableCommand, 'npm.cmd run typecheck')

  const posix = { platform: 'linux', probe: nothingAvailable }
  assert.equal(resolveValidationExecutable('npm test', posix).executableCommand, 'npm test')
  assert.equal(resolveValidationExecutable('npm run typecheck', posix).executableCommand, 'npm run typecheck')
})

test('launcher rewriting preserves the parsed package-script identity', () => {
  const win = { platform: 'win32', probe: available('npm.cmd', 'bun.exe') }
  const cases = [
    ['npm test', 'test'],
    ['npm run typecheck', 'typecheck'],
    ['npm run test:unit', 'test:unit'],
    ['bun run build', 'build'],
  ]
  for (const [command, script] of cases) {
    const resolved = resolveValidationExecutable(command, win)
    assert.equal(resolved.parsed.script, script, `${command} must keep the parsed script name`)
    // The script name is checked against package.json by semantic parse, so the
    // rewritten executable must never be what existence validation reads.
    assert.notEqual(resolved.parsed.script, resolved.executableCommand)
  }
})

test('an already-suffixed manager command still parses and is rewritten to the platform launcher', () => {
  const win = { platform: 'win32', probe: available('npm.cmd') }
  const resolved = resolveValidationExecutable('npm.cmd test', win)
  assert.deepEqual(resolved.parsed, { manager: 'npm', script: 'test', args: [] })
  assert.equal(resolved.executableCommand, 'npm.cmd test')

  // A Windows-suffixed command on a POSIX host normalizes to the manager name
  // the parser already derived; `npm.cmd` does not exist there.
  const posix = { platform: 'linux', probe: nothingAvailable }
  assert.equal(resolveValidationExecutable('npm.cmd test', posix).executableCommand, 'npm test')
  assert.equal(resolveValidationExecutable('bun.exe run test', posix).executableCommand, 'bun run test')
})

test('the default Windows probe finds launchers through a real PATH regardless of its spelling', () => {
  // No injected probe: exercises the actual PATH scan. A `Path`-spelled PATH
  // must resolve exactly like a `PATH`-spelled one, and an empty PATH must not
  // shadow a populated one.
  const dir = mkdtempSync(join(tmpdir(), 'planx-path-'))
  try {
    for (const platform of ['linux', 'darwin']) {
      assert.equal(packageManagerLauncher('npm', { platform }), 'npm')
    }
    if (process.platform !== 'win32') return
    // A directory holding only npm.cmd resolves npm to npm.cmd...
    writeFileSync(join(dir, 'npm.cmd'), '@echo off\r\n')
    for (const key of ['PATH', 'Path', 'path']) {
      assert.equal(packageManagerLauncher('npm', { platform: 'win32', env: { [key]: dir } }), 'npm.cmd', `${key} spelling must resolve`)
    }
    // ...and an empty PATH does not hide a populated one.
    assert.equal(packageManagerLauncher('npm', { platform: 'win32', env: { PATH: '', Path: dir } }), 'npm.cmd')
    // With no launcher on PATH the documented primary form is still returned.
    assert.equal(packageManagerLauncher('npm', { platform: 'win32', env: { PATH: dir } }), 'npm.cmd')
    const empty = mkdtempSync(join(tmpdir(), 'planx-path-empty-'))
    try {
      assert.equal(packageManagerLauncher('yarn', { platform: 'win32', env: { PATH: empty } }), 'yarn.cmd')
      assert.equal(packageManagerLauncher('bun', { platform: 'win32', env: { PATH: empty } }), 'bun.exe')
    } finally { rmSync(empty, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unsafe validation commands fail closed before any launcher is chosen', () => {
  let probes = 0
  const counting = () => { probes++; return true }
  for (const command of [
    'node --test',
    'node -e process.exit(0)',
    'npm test && curl attacker.invalid',
    'npm test | tee out.txt',
    'npm test > out.txt',
    'npm test; rm -rf /',
    'npx vitest',
    'bun test',
    'pwsh -Command Get-ChildItem',
    'npm run does-not-exist -- $(whoami)',
    'npm run `whoami`',
    '',
  ]) {
    assert.throws(() => resolveValidationExecutable(command, { platform: 'win32', probe: counting }), `${command} must be rejected`)
  }
  assert.equal(probes, 0, 'rejected commands must not reach launcher probing')
})
