import test from 'node:test'
import assert from 'node:assert/strict'
import { isNativePlanApproved } from '../../src/planning/native-plan-bridge.ts'

test('only native structured approval launches orchestration', () => {
  assert.equal(isNativePlanApproved({ isError: false, value: { approved: true } }), true)
  assert.equal(isNativePlanApproved({ isError: true, value: { approved: true } }), false)
  assert.equal(isNativePlanApproved({ isError: false, value: { approved: false } }), false)
  assert.equal(isNativePlanApproved({ isError: false, content: [{ type: 'text', text: 'Plan approved' }] }), false)
  assert.equal(isNativePlanApproved(undefined), false)
})
