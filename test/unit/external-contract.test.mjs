import test from 'node:test'
import assert from 'node:assert/strict'
import { selectTrustedRevision } from '../../src/external/contract.ts'
import { findCurrentCompletion } from '../../src/external/continuation.ts'

const task={id:'t',title:'t',objective:'o',read:[],modify:['a'],decisionLocks:[],requiredChanges:[],acceptanceCriteria:['ok'],validation:[],dependsOn:[],parallelSafe:false}
const plan={planModeVersion:1,summary:'x',complexity:'small',decisionLocks:[],tasks:[task],validationStrategy:[],validationCommands:[],risks:[],outOfScope:[]}
const contract=(revision,summary='x')=>({externalPlan:{version:1,revision,repository:'o/r',baseCommit:'a'.repeat(40)},plan:{...plan,summary}})

test('highest external revision wins and semantic duplicates do not conflict',()=>{
  assert.equal(selectTrustedRevision([contract(1),contract(2),structuredClone(contract(2))]).externalPlan.revision,2)
  assert.throws(()=>selectTrustedRevision([contract(2,'a'),contract(2,'b')]),/conflicting contracts/)
})

test('stale completion evidence never short-circuits without remote head revalidation',async()=>{
  const evidence=[{externalCompletion:{version:1,revision:2,repository:'o/r',issue:7,pr:9,head:'b'.repeat(40)}}]
  assert.equal(await findCurrentCompletion(evidence,{revision:2,repository:'o/r',issue:7,remoteHead:async()=> 'c'.repeat(40)}),undefined)
  assert.equal((await findCurrentCompletion(evidence,{revision:2,repository:'o/r',issue:7,remoteHead:async()=> 'b'.repeat(40)}))?.pr,9)
})
