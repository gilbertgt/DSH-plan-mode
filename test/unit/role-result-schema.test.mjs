import test from 'node:test'
import assert from 'node:assert/strict'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { ROLE_RESULT_SCHEMA, validateRoleResult } from '../../src/contract/role-result.ts'

/** Must match the marker `validateRoleResult` appends when it clips a string. */
const TRUNCATION_MARKER = '…[truncated by host]'

const baseResult = (taskId = 'task-1') => ({
  taskId,
  status: 'COMPLETE',
  changed: [],
  validation: [],
  remaining: [],
  contextExpansion: [],
})

test('ROLE_RESULT_SCHEMA is accepted by the authoritative DSH object schema validator', () => {
  assert.doesNotThrow(() => assertObjectJsonSchema(ROLE_RESULT_SCHEMA))
})

test('structural violations still fail closed', () => {
  assert.deepEqual(validateRoleResult(baseResult(), 'task-1'), baseResult())

  const longTaskId = 't'.repeat(201)
  assert.throws(() => validateRoleResult(baseResult(longTaskId), longTaskId), /taskId mismatch/)

  // Ownership paths are security-relevant identifiers, not diagnostics: count,
  // type, and length all remain fail-closed rather than being rewritten.
  assert.throws(() => validateRoleResult({ ...baseResult(), changed: Array(201).fill('x') }, 'task-1'), /changed invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), changed: [7] }, 'task-1'), /changed invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), changed: ['x'.repeat(513)] }, 'task-1'), /changed invalid/)

  assert.throws(() => validateRoleResult({ ...baseResult(), validation: Array.from({ length: 31 }, (_, i) => ({ id: `v-${i}`, status: 'PASS' })) }, 'task-1'), /validation invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), validation: [{ id: 'x'.repeat(201), status: 'PASS' }] }, 'task-1'), /validation invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), validation: [{ id: 'v', status: 'NOPE' }] }, 'task-1'), /validation invalid/)

  assert.throws(() => validateRoleResult({ ...baseResult(), remaining: Array(31).fill('x') }, 'task-1'), /remaining invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), remaining: [42] }, 'task-1'), /remaining invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), contextExpansion: Array(31).fill('x') }, 'task-1'), /contextExpansion invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), contextExpansion: [{}] }, 'task-1'), /contextExpansion invalid/)
})

test('a long blocker explanation is clipped, not rejected', () => {
  // Regression: a real Worker reported a 1169-character blocker note against a
  // 1000-character cap. Rejecting the whole result replaced a precise BLOCKED
  // report with the opaque `remaining invalid` and failed the run.
  const blocker = '檔案沙箱為 read-only，寫入被拒。'.repeat(300)
  assert.ok(blocker.length > 4000, 'fixture must exceed the per-string ceiling')

  const result = validateRoleResult({
    ...baseResult(),
    status: 'BLOCKED',
    remaining: [blocker, 'short note'],
  }, 'task-1')

  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.remaining.length, 2)
  assert.ok(result.remaining[0].length < blocker.length, 'the long note must be clipped')
  assert.match(result.remaining[0], /truncated by host\]$/)
  // The excerpt keeps the diagnosis legible and stays bounded.
  assert.ok(result.remaining[0].startsWith('檔案沙箱為 read-only'), 'the useful prefix must survive')
  assert.ok(result.remaining[0].length <= 4000 + TRUNCATION_MARKER.length)
  // Short entries pass through untouched.
  assert.equal(result.remaining[1], 'short note')
})

test('long validation detail is clipped, not rejected', () => {
  const detail = 'assertion failed: expected the select rule to be opaque. '.repeat(120)
  assert.ok(detail.length > 2000, 'fixture must exceed the old detail ceiling')

  const result = validateRoleResult({
    ...baseResult(),
    validation: [{ id: 'v-unit', status: 'FAIL', detail }],
  }, 'task-1')

  assert.equal(result.validation[0].status, 'FAIL')
  assert.ok(result.validation[0].detail.length < detail.length)
  assert.match(result.validation[0].detail, /truncated by host\]$/)
})

test('the raw 128KiB envelope remains fail-closed before diagnostic clipping', () => {
  assert.throws(
    () => validateRoleResult({ ...baseResult(), remaining: ['x'.repeat(129 * 1024)] }, 'task-1'),
    /exceeds 128KiB/,
    'one huge diagnostic must not become acceptable merely because normalization could clip it',
  )

  const oversized = {
    ...baseResult(),
    changed: Array(200).fill('x'.repeat(512)),
    remaining: Array(30).fill('y'.repeat(4000)),
    contextExpansion: Array(30).fill('z'.repeat(4000)),
  }
  assert.throws(() => validateRoleResult(oversized, 'task-1'), /exceeds 128KiB/)
})
