import test from 'node:test'
import assert from 'node:assert/strict'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { ROLE_RESULT_SCHEMA, validateRoleResult } from '../../src/contract/role-result.ts'

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

test('host validation preserves role-result size and count limits outside model-facing schema', () => {
  assert.deepEqual(validateRoleResult(baseResult(), 'task-1'), baseResult())

  const longTaskId = 't'.repeat(201)
  assert.throws(() => validateRoleResult(baseResult(longTaskId), longTaskId), /taskId mismatch/)

  assert.throws(() => validateRoleResult({ ...baseResult(), changed: Array(201).fill('x') }, 'task-1'), /changed invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), changed: ['x'.repeat(513)] }, 'task-1'), /changed invalid/)

  assert.throws(() => validateRoleResult({ ...baseResult(), validation: Array.from({ length: 31 }, (_, i) => ({ id: `v-${i}`, status: 'PASS' })) }, 'task-1'), /validation invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), validation: [{ id: 'x'.repeat(201), status: 'PASS' }] }, 'task-1'), /validation invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), validation: [{ id: 'v', status: 'PASS', detail: 'x'.repeat(2001) }] }, 'task-1'), /validation invalid/)

  assert.throws(() => validateRoleResult({ ...baseResult(), remaining: Array(31).fill('x') }, 'task-1'), /remaining invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), remaining: ['x'.repeat(1001)] }, 'task-1'), /remaining invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), contextExpansion: Array(31).fill('x') }, 'task-1'), /contextExpansion invalid/)
  assert.throws(() => validateRoleResult({ ...baseResult(), contextExpansion: ['x'.repeat(1001)] }, 'task-1'), /contextExpansion invalid/)

  const oversized = {
    ...baseResult(),
    changed: Array(200).fill('x'.repeat(512)),
    remaining: Array(30).fill('y'.repeat(1000)),
    contextExpansion: Array(30).fill('z'.repeat(1000)),
  }
  assert.throws(() => validateRoleResult(oversized, 'task-1'), /exceeds 128KiB/)
})
