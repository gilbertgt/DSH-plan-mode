import test from 'node:test'
import assert from 'node:assert/strict'
import { assertReleaseMainTip } from '../../scripts/release-source-policy.mjs'

test('release source must equal current main tip, not merely be an ancestor',()=>{
  const head='a'.repeat(40)
  assert.equal(assertReleaseMainTip(head,head),head)
  assert.throws(()=>assertReleaseMainTip(head,'b'.repeat(40)),/not the current origin\/main tip/)
  assert.throws(()=>assertReleaseMainTip('bad',head),/invalid git SHA/)
})
