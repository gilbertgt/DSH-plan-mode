import test from 'node:test';import assert from 'node:assert/strict';import {extractPlanArtifact,validatePlanArtifact,normalizeOwnedPath,schedulerPathIdentity} from '../../src/contract/plan-artifact.ts'
const plan={planModeVersion:1,summary:'x',complexity:'small',decisionLocks:[],tasks:[{id:'t1',title:'t',objective:'o',read:['src/a.ts'],modify:['src/a.ts'],decisionLocks:[],requiredChanges:['x'],acceptanceCriteria:['passes'],validation:['node test'],dependsOn:[],parallelSafe:false}],validationStrategy:[],validationCommands:[{id:'unit',taskIds:['t1'],command:'node --test',timeoutMs:1000}],risks:[],outOfScope:[]}
test('validates and hashes one JSON candidate',()=>{const x=extractPlanArtifact(`# P\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``);assert.equal(x.artifact.tasks[0].id,'t1');assert.match(x.hash,/^[0-9a-f]{64}$/)})
test('rejects duplicate candidates',()=>assert.throws(()=>extractPlanArtifact(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``),/exactly one/))
test('rejects cycles and invalid paths',()=>{const bad=structuredClone(plan);bad.tasks[0].modify=['../x'];assert.throws(()=>validatePlanArtifact(bad),/escapes/);assert.throws(()=>normalizeOwnedPath('src/*.ts'),/exact/);assert.equal(schedulerPathIdentity('SRC/A.ts','win32'),'src/a.ts')})

test('rejects unknown fields, duplicate ids, invalid command refs and timeout',()=>{
  const unknown=structuredClone(plan);unknown.unplanned=true;assert.throws(()=>validatePlanArtifact(unknown),/unknown field/)
  const dup=structuredClone(plan);dup.tasks.push({...structuredClone(dup.tasks[0]),title:'two'});assert.throws(()=>validatePlanArtifact(dup),/duplicate task id/)
  const ref=structuredClone(plan);ref.validationCommands[0].taskIds=['missing'];assert.throws(()=>validatePlanArtifact(ref),/unknown task/)
  const timeout=structuredClone(plan);timeout.validationCommands[0].timeoutMs=600001;assert.throws(()=>validatePlanArtifact(timeout),/timeoutMs invalid/)
})
