import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsFileBackedWindowsStdio } from '../../src/platform/captured-exec.ts'
import { prepareValidationSubprocessEnvironment, validationInfrastructureDiagnostic } from '../../src/validation/runner.ts'

test('Windows sandbox validation selects file-backed nested stdio only for the explicit host marker', () => {
  assert.equal(needsFileBackedWindowsStdio('win32', { PLANX_SANDBOX_VALIDATION: '1' }), true)
  assert.equal(needsFileBackedWindowsStdio('win32', {}), false)
  assert.equal(needsFileBackedWindowsStdio('linux', { PLANX_SANDBOX_VALIDATION: '1' }), false)
})

test('Windows validation Git trust is exact, subprocess-local, and temporary', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'planx-git-trust-worktree-'))
  const validationDir = await mkdtemp(join(tmpdir(), 'planx-git-trust-receipts-'))
  let prepared
  try {
    prepared = await prepareValidationSubprocessEnvironment(cwd, validationDir, 'VALIDATING-run-v-unit', 'win32')
    assert.equal(prepared.env.PLANX_SANDBOX_VALIDATION, '1')
    assert.equal(typeof prepared.env.GIT_CONFIG_GLOBAL, 'string')
    assert.equal(prepared.env.GIT_CONFIG_GLOBAL, prepared.gitConfigPath)

    const config = await readFile(prepared.gitConfigPath, 'utf8')
    assert.match(config, /^\[safe\]\n\tdirectory = ".+"\n$/)
    assert.equal(config.includes('safe.directory=*'), false)
    assert.equal(config.includes('directory = "*"'), false)
    assert.equal(config.includes(cwd.replaceAll('\\', '/')), true)

    const linux = await prepareValidationSubprocessEnvironment(cwd, validationDir, 'VALIDATING-run-linux', 'linux')
    assert.deepEqual(linux.env, { PLANX_SANDBOX_VALIDATION: '1' })
    assert.equal(linux.gitConfigPath, undefined)
    await linux.cleanup()
  } finally {
    const configPath = prepared?.gitConfigPath
    await prepared?.cleanup()
    if (configPath) await assert.rejects(access(configPath))
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
    await rm(validationDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('Windows partial-sandbox nested spawn EPERM is infrastructure INCONCLUSIVE evidence, not a test FAIL', () => {
  const diagnostic = validationInfrastructureDiagnostic(
    'win32',
    { mode: 'workspace-write', denied: false, enforcement: 'partial' },
    1,
    Buffer.from("Error: spawn EPERM\n  code: 'EPERM',\n  syscall: 'spawn'\n"),
    Buffer.alloc(0),
  )
  assert.equal(diagnostic, 'WINDOWS_SANDBOX_NESTED_PIPE_EPERM')
  assert.equal(
    validationInfrastructureDiagnostic(
      'win32',
      { mode: 'workspace-write', denied: false, enforcement: 'partial' },
      1,
      'AssertionError: expected true',
      '',
    ),
    undefined,
  )
  assert.equal(
    validationInfrastructureDiagnostic(
      'linux',
      { mode: 'workspace-write', denied: false, enforcement: 'partial' },
      1,
      "Error: spawn EPERM\ncode: 'EPERM'\nsyscall: 'spawn'",
      '',
    ),
    undefined,
  )
})
