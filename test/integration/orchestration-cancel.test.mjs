import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationService } from '../../src/orchestration/service.ts'

const artifact={planModeVersion:1,summary:'x',complexity:'small',decisionLocks:[],tasks:[{id:'t1',title:'t',objective:'o',read:['a.ts'],modify:['a.ts'],decisionLocks:[],requiredChanges:['x'],acceptanceCriteria:['ok'],validation:[],dependsOn:[],parallelSafe:false}],validationStrategy:[],validationCommands:[],risks:[],outOfScope:[]}

function agent(sessionId='s1'){
  const events=[]
  const session={id:sessionId,header:{cwd:process.cwd()},append(type,data){events.push({type,data})},snapshotEvents(){return events}}
  return {status:'busy',session,runMaintenance(fn){return Promise.resolve().then(()=>fn(new AbortController().signal))}}
}

function store(root,{delayFirstWrite=false}={}){
  const manifests=new Map();let release
  const gate=delayFirstWrite?new Promise(resolve=>{release=resolve}):Promise.resolve()
  let writes=0
  return {
    root,
    release:()=>release?.(),
    runDir(sessionId,runId){return join(root,'sessions',sessionId,runId)},
    async writeManifest(value){writes++;if(delayFirstWrite&&writes===1)await gate;manifests.set(value.runId,structuredClone(value))},
    async readManifest(_sessionId,runId){const value=manifests.get(runId);if(!value)throw new Error('manifest missing');return structuredClone(value)},
    async removeRun(){},
    async listSessionManifests(){return[]},
    manifest(runId){return manifests.get(runId)},
  }
}

test('disable during approval persistence cannot launch or resurrect pending run',async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-cancel-pending-'))
  try{
    const st=store(root,{delayFirstWrite:true});let runnerCalls=0
    const service=new OrchestrationService(st,async()=>{runnerCalls++})
    const a=agent('s-pending')
    const runId=service.approve({sessionId:'s-pending',agent:a,artifact,planHash:'h'})
    assert.equal(typeof runId,'string')
    const idle=service.onParentIdle('s-pending')
    const cancelled=service.cancelSession('s-pending','disabled')
    st.release()
    assert.equal(await idle,false)
    assert.equal(await cancelled,true)
    assert.equal(runnerCalls,0)
    assert.equal(st.manifest(runId).phase,'CANCELLED')
    assert.equal(st.manifest(runId).terminal,true)
    assert.equal(service.activeRun('s-pending'),undefined)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('disable aborts an active run and persists terminal CANCELLED',async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-cancel-active-'))
  try{
    const st=store(root);let started=false,aborted=false
    const service=new OrchestrationService(st,async(_launch,_runId,signal)=>{
      started=true
      await new Promise((resolve,reject)=>{
        if(signal.aborted){aborted=true;reject(new Error('aborted'));return}
        signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'))},{once:true})
      })
    })
    const a=agent('s-active')
    const runId=service.approve({sessionId:'s-active',agent:a,artifact,planHash:'h'})
    assert.equal(await service.onParentIdle('s-active'),true)
    while(!started)await new Promise(resolve=>setImmediate(resolve))
    assert.equal(await service.cancelSession('s-active','disabled'),true)
    assert.equal(aborted,true)
    assert.equal(st.manifest(runId).phase,'CANCELLED')
    assert.equal(st.manifest(runId).terminal,true)
    assert.equal(service.activeRun('s-active'),undefined)
  }finally{await rm(root,{recursive:true,force:true})}
})
