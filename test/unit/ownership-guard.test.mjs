import test from 'node:test'
import assert from 'node:assert/strict'
import { mutationTargetCandidates, ownershipGuardReason, toolPathToRepoRelative } from '../../src/orchestration/ownership-guard.ts'

test('ownership guard extracts direct and patch targets and denies unknown mutating targets',()=>{
  assert.deepEqual(mutationTargetCandidates('write',{path:'src/a.ts',content:'x'}),['src/a.ts'])
  assert.deepEqual(mutationTargetCandidates('apply_patch',{patch:'*** Update File: src/a.ts\n*** Add File: src/b.ts'}),['src/a.ts','src/b.ts'])
  assert.equal(mutationTargetCandidates('read',{path:'src/a.ts'}),undefined)
  assert.match(ownershipGuardReason(process.cwd(),['src/a.ts'],'write',{content:'x'}),/cannot identify target/)
})

test('ownership guard permits exact owned files and denies escape/outside paths',()=>{
  const root=process.cwd()
  assert.equal(ownershipGuardReason(root,['src/a.ts'],'write',{path:'src/a.ts'}),undefined)
  assert.match(ownershipGuardReason(root,['src/a.ts'],'write',{path:'src/b.ts'}),/ownership violation/)
  assert.throws(()=>toolPathToRepoRelative(root,'../escape.txt'),/escapes repository/)
})
