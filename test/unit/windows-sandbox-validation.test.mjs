import test from 'node:test'
import assert from 'node:assert/strict'
import { needsFileBackedWindowsStdio } from '../../src/platform/captured-exec.ts'
import { validationInfrastructureDiagnostic } from '../../src/validation/runner.ts'

test('Windows sandbox validation selects file-backed nested stdio only for the explicit host marker', () => {
  assert.equal(needsFileBackedWindowsStdio('win32', { PLANX_SANDBOX_VALIDATION: '1' }), true)
  assert.equal(needsFileBackedWindowsStdio('win32', {}), false)
  assert.equal(needsFileBackedWindowsStdio('linux', { PLANX_SANDBOX_VALIDATION: '1' }), false)
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
