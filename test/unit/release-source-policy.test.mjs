import test from 'node:test'
import assert from 'node:assert/strict'
import { assertReleaseMainTip, assertReleaseTagInMain } from '../../scripts/release-source-policy.mjs'

test('push-triggered release source must equal current main tip',()=>{
  const head='a'.repeat(40)
  assert.equal(assertReleaseMainTip(head,head),head)
  assert.throws(()=>assertReleaseMainTip(head,'b'.repeat(40)),/not the current origin\/main tip/)
  assert.throws(()=>assertReleaseMainTip('bad',head),/invalid git SHA/)
})

test('manual release recovery may use an older tag only when it is contained in main',()=>{
  const head='a'.repeat(40)
  const main='b'.repeat(40)
  assert.equal(assertReleaseTagInMain(head,main,true),head)
  assert.throws(()=>assertReleaseTagInMain(head,main,false),/not contained in origin\/main/)
  assert.throws(()=>assertReleaseTagInMain('bad',main,true),/invalid git SHA/)
})
