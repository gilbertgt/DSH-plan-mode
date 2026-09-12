import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { OrchestrationService } from '../../src/orchestration/service.ts'
import { createOrchestratorRunner, currentRoute } from '../../src/orchestration/engine.ts'
import { routeChoices } from '../../src/orchestration/role-router.ts'
import { assertLosslessEventData } from '../../src/contract/events.ts'
import { DEFAULT_SETTINGS } from '../../src/contract/settings.ts'
import { git } from '../../src/git/repository.ts'

const TEST_TIMEOUT = 60_000

const artifact={planModeVersion:1,summary:'x',complexity:'small',decisionLocks:[],tasks:[{id:'t1',title:'t',objective:'o',read:['a.ts'],modify:['a.ts'],decisionLocks:[],requiredChanges:['x'],acceptanceCriteria:['ok'],validation:[],dependsOn:[],parallelSafe:false}],validationStrategy:[],validationCommands:[],risks:[],outOfScope:[]}

/**
 * Mirrors DSH `Session.append`: the payload must survive the lossless-JSON
 * snapshot boundary. The real append throws when `snapshotJsonValue` returns
 * undefined, which is exactly what an explicitly `undefined` property does.
 */
function appendLikeDsh(events,type,data){
  const snapshot=snapshotJsonValue(data)
  if(snapshot===undefined)throw new Error(`session event "${type}" carries non-JSON-serializable data`)
  const stored={type,data:JSON.parse(JSON.stringify(snapshot))}
  events.push(stored)
  return stored
}

function agent(sessionId,{cwd=process.cwd(),options={}}={}){
  const events=[]
  const instance={
    status:'busy',
    options,
    session:{
      id:sessionId,
      header:{cwd},
      append(type,data){return appendLikeDsh(events,type,data)},
      snapshotEvents(){return events},
    },
    inject(){return true},
    runMaintenance(fn){return Promise.resolve().then(()=>fn(new AbortController().signal))},
  }
  return {agent:instance,events}
}

/** A runner that stays active until the run is aborted or cancelled. */
const pendingRunner=()=>(_launch,_runId,signal)=>new Promise((_resolve,reject)=>{
  const fail=()=>reject(new Error('aborted'))
  if(signal.aborted){fail();return}
  signal.addEventListener('abort',fail,{once:true})
})

function store(root){
  const manifests=new Map()
  let failWrites=0
  return {
    root,
    failNextWrites(count){failWrites=count},
    runDir(sessionId,runId){return join(root,'sessions',sessionId,runId)},
    async writeManifest(value){if(failWrites>0){failWrites--;throw new Error('simulated manifest write failure')}manifests.set(value.runId,structuredClone(value))},
    async readManifest(_sessionId,runId){const value=manifests.get(runId);if(!value)throw new Error('manifest missing');return structuredClone(value)},
    async removeRun(){},
    async listSessionManifests(){return[]},
    manifest(runId){return manifests.get(runId)},
  }
}

async function gitRepo(){
  const dir=await mkdtemp(join(tmpdir(),'planx-preflight-'))
  await git(dir,['init'])
  await git(dir,['config','user.email','test@example.com'])
  await git(dir,['config','user.name','test'])
  const {writeFile}=await import('node:fs/promises')
  await writeFile(join(dir,'a.ts'),'base\n')
  await git(dir,['add','.'])
  await git(dir,['commit','-m','base'])
  return dir
}

/** Runner wiring the real engine against a stubbed ctx and the test store. */
function engineRunner({ctx,store:st,events,settings}){
  const resolved={...DEFAULT_SETTINGS,execution:{...DEFAULT_SETTINGS.execution,maxParallelWorkers:1,parallelMode:'serial',keepFailedWorktrees:false},...settings}
  return createOrchestratorRunner({ctx,settings:()=>resolved,store:st,emit:(kind,data)=>events.push({type:`emit:${kind}`,data})})
}

async function waitFor(predicate,{timeoutMs=20_000,label='condition'}={}){
  const deadline=Date.now()+timeoutMs
  while(Date.now()<deadline){
    if(await predicate())return
    await new Promise(resolve=>setTimeout(resolve,5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Windows can still hold handles briefly; retry instead of failing the test. */
const cleanup=dir=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50})

// A. phase event with no message -> payload contains no message property.
test('phase event without a message carries no message property and is losslessly serializable',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-phase-'))
  try{
    const st=store(root)
    const {agent:a,events}=agent('s-phase')
    const service=new OrchestrationService(st,pendingRunner())
    const runId=service.approve({sessionId:'s-phase',agent:a,artifact,planHash:'h'})
    assert.equal(typeof runId,'string')
    assert.equal(await service.onParentIdle('s-phase'),true)
    await waitFor(()=>events.some(event=>event.type==='planx/run-phase'),{label:'PREFLIGHT phase event'})

    const phase=events.find(event=>event.type==='planx/run-phase')
    assert.equal(phase.data.phase,'PREFLIGHT')
    assert.equal('message' in phase.data,false,'an absent message must not be present as undefined')
    assert.equal(Object.values(phase.data).includes(undefined),false)
    for(const event of events)assert.notEqual(snapshotJsonValue(event.data),undefined,`${event.type} data must be lossless JSON`)
    assert.equal(await service.cancelSession('s-phase','test cleanup'),true)
  }finally{await cleanup(root)}
})

test('the payload guard rejects an explicitly undefined optional field and accepts its absence',()=>{
  assert.throws(()=>assertLosslessEventData({runId:'r',phase:'PREFLIGHT',message:undefined},'planx/run-phase'),/undefined value at planx\/run-phase\.message/)
  assert.throws(()=>appendLikeDsh([],'planx/run-phase',{runId:'r',phase:'PREFLIGHT',message:undefined}),/non-JSON-serializable/)
  assert.doesNotThrow(()=>assertLosslessEventData({runId:'r',phase:'PREFLIGHT'},'planx/run-phase'))
  const events=[]
  assert.doesNotThrow(()=>appendLikeDsh(events,'planx/run-phase',{runId:'r',phase:'PREFLIGHT'}))
  assert.equal(events.length,1)
})

// B. current route with no reasoningEffort/maxTokens -> RouteChoice carries neither property.
test('a current route without reasoningEffort/maxTokens produces a RouteChoice with neither property',()=>{
  // The live-agent read must not materialize absent optional controls.
  const fromAgent=currentRoute({options:{provider:'provider',model:'model'}})
  assert.equal('reasoningEffort' in fromAgent,false,'reasoningEffort must be absent, not undefined')
  assert.equal('maxTokens' in fromAgent,false,'maxTokens must be absent, not undefined')
  assert.notEqual(snapshotJsonValue(fromAgent),undefined,'an agent-derived route must be lossless JSON')
  const fromBareAgent=currentRoute({})
  assert.equal('reasoningEffort' in fromBareAgent,false)
  assert.equal('maxTokens' in fromBareAgent,false)
  const populatedAgent=currentRoute({options:{provider:'p',model:'m',reasoningEffort:'high',maxTokens:1234}})
  assert.equal(populatedAgent.reasoningEffort,'high')
  assert.equal(populatedAgent.maxTokens,1234)

  const choices=routeChoices({mode:'current',fallbacks:[]},{provider:'provider',model:'model'})
  assert.equal(choices.length,1)
  const [choice]=choices
  assert.equal(choice.provider,'provider')
  assert.equal(choice.model,'model')
  assert.equal('reasoningEffort' in choice,false,'reasoningEffort must be absent, not undefined')
  assert.equal('maxTokens' in choice,false,'maxTokens must be absent, not undefined')
  assert.notEqual(snapshotJsonValue(choice),undefined,'a route choice must be lossless JSON for subagent/agentOptions transport')

  // A populated route still forwards both controls unchanged.
  const populated=routeChoices({mode:'current',fallbacks:[]},{provider:'p',model:'m',reasoningEffort:'high',maxTokens:1234})
  assert.equal(populated[0].reasoningEffort,'high')
  assert.equal(populated[0].maxTokens,1234)
  // A fallback declared without optional controls also stays clean.
  const withFallback=routeChoices({mode:'current',fallbacks:[{provider:'fp',model:'fm'}]},{provider:'p',model:'m'})
  assert.equal(withFallback.length,2)
  assert.equal('maxTokens' in withFallback[1],false)
  assert.notEqual(snapshotJsonValue(withFallback),undefined)
})

// C. failure during initial PREFLIGHT event handling -> run converges to terminal=true.
test('a failure during initial PREFLIGHT event handling still converges to a terminal manifest',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-failclose-'))
  try{
    const st=store(root)
    const {agent:a}=agent('s-failclosed')
    const originalAppend=a.session.append.bind(a.session)
    // Reproduce the observed production fault: the very first PREFLIGHT append fails.
    a.session.append=(type,data)=>{
      if(type==='planx/run-phase'&&data.phase==='PREFLIGHT')throw new Error('session event "planx/run-phase" carries non-JSON-serializable data')
      return originalAppend(type,data)
    }

    let runnerCalls=0
    const service=new OrchestrationService(st,async()=>{runnerCalls++;await new Promise(()=>{})})
    const runId=service.approve({sessionId:'s-failclosed',agent:a,artifact,planHash:'h'})
    assert.equal(await service.onParentIdle('s-failclosed'),true)
    await waitFor(()=>st.manifest(runId)?.terminal===true,{label:'terminal manifest'})

    const manifest=st.manifest(runId)
    assert.equal(manifest.terminal,true)
    assert.equal(manifest.phase,'FAILED')
    assert.notEqual(manifest.phase,'PREFLIGHT','the run must not remain forever in PREFLIGHT')
    assert.equal(runnerCalls,0,'the runner must not start once the initial phase event failed')
    const view=service.list('s-failclosed').find(item=>item.runId===runId)
    assert.equal(view.phase,'FAILED')
    assert.match(String(view.message),/non-JSON-serializable/)
    assert.equal(service.activeRun('s-failclosed'),undefined,'no run may stay active')
  }finally{await cleanup(root)}
})

test('a failure writing the initial PREFLIGHT manifest converges to BLOCKED or FAILED',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-manifest-fail-'))
  try{
    const st=store(root)
    const {agent:a}=agent('s-manifest')
    const service=new OrchestrationService(st,async()=>{})
    const runId=service.approve({sessionId:'s-manifest',agent:a,artifact,planHash:'h'})
    // The initial PREFLIGHT manifest write is the first write the run performs.
    st.failNextWrites(1)
    assert.equal(await service.onParentIdle('s-manifest'),true)
    await waitFor(()=>st.manifest(runId)?.terminal===true,{label:'terminal manifest after write failure'})
    const manifest=st.manifest(runId)
    assert.equal(manifest.terminal,true)
    assert.ok(['BLOCKED','FAILED'].includes(manifest.phase),`unexpected phase ${manifest.phase}`)
  }finally{await cleanup(root)}
})

test('a failure during preflight route resolution converges to a terminal phase',{timeout:TEST_TIMEOUT},async()=>{
  const root=await gitRepo()
  try{
    const st=store(root)
    const {agent:a,events}=agent('s-preflight',{cwd:root})
    // No llm service in ctx: worker route preflight must fail closed.
    const service=new OrchestrationService(st,engineRunner({ctx:{},store:st,events}))
    const runId=service.approve({sessionId:'s-preflight',agent:a,artifact,planHash:'h'})
    assert.equal(await service.onParentIdle('s-preflight'),true)
    await waitFor(()=>st.manifest(runId)?.terminal===true,{label:'terminal manifest after route preflight failure'})
    const manifest=st.manifest(runId)
    assert.equal(manifest.terminal,true)
    assert.notEqual(manifest.phase,'PREFLIGHT')
    assert.ok(['BLOCKED','FAILED'].includes(manifest.phase),`unexpected phase ${manifest.phase}`)
    // Baseline artifacts were created before the route preflight ran.
    const runDir=st.runDir('s-preflight',runId)
    assert.equal((await stat(join(runDir,'baseline.json'))).isFile(),true)
    assert.equal((await stat(join(runDir,'recovery.json'))).isFile(),true)
    assert.equal((await stat(join(runDir,'patches'))).isDirectory(),true)
  }finally{await cleanup(root)}
})

// D. normal successful startup -> runner starts; baseline/checkpoint creation proceeds.
test('normal startup starts the runner and creates baseline plus checkpoint artifacts',{timeout:TEST_TIMEOUT},async()=>{
  const root=await gitRepo()
  try{
    const st=store(root)
    const resolved=[]
    const {agent:a,events}=agent('s-ok',{cwd:root,options:{provider:'native-inherit',model:'native-inherit'}})
    const ctx={llm:{resolveCallConfig:async choice=>{resolved.push(choice);return choice}}}
    let runnerStarted=false
    const inner=engineRunner({ctx,store:st,events})
    const service=new OrchestrationService(st,async(launch,runId,signal)=>{
      runnerStarted=true
      return inner(launch,runId,signal)
    })
    const runId=service.approve({sessionId:'s-ok',agent:a,artifact,planHash:'h'})
    assert.equal(await service.onParentIdle('s-ok'),true)
    // runMaintenance defers the runner to a microtask, so wait for it explicitly.
    await waitFor(()=>runnerStarted,{label:'runner start'})
    assert.equal(runnerStarted,true)
    // The WORKERS phase event is emitted only after baseline/checkpoint + route preflight.
    await waitFor(()=>events.some(event=>event.type==='emit:phase'&&event.data.phase==='WORKERS'),{label:'WORKERS phase'})

    const runDir=st.runDir('s-ok',runId)
    const baseline=JSON.parse(await readFile(join(runDir,'baseline.json'),'utf8'))
    assert.match(baseline.head,/^[0-9a-f]{40}$/)
    const checkpoint=JSON.parse(await readFile(join(runDir,'recovery.json'),'utf8'))
    assert.equal(checkpoint.phase,'PREFLIGHT')
    assert.equal(checkpoint.safeBoundary,true)
    assert.equal(checkpoint.head,baseline.head)
    // patches/ is created up front so worker patch capture can always land.
    assert.equal((await stat(join(runDir,'patches'))).isDirectory(),true)
    assert.ok((await readdir(runDir)).includes('baseline.json'))

    // Route preflight ran through the real llm service for the worker role.
    assert.ok(resolved.length>=1,'worker route preflight must run')
    assert.equal(resolved[0].provider,'native-inherit')
    assert.equal(resolved[0].model,'native-inherit')
    assert.equal('reasoningEffort' in resolved[0],false)
    assert.equal('maxTokens' in resolved[0],false)

    // With no subagent backend the runner fails closed, and the run still terminates.
    await waitFor(()=>st.manifest(runId)?.terminal===true,{label:'terminal manifest'})
    const phase=st.manifest(runId).phase
    assert.ok(['BLOCKED','FAILED'].includes(phase),`unexpected phase ${phase}`)
    assert.equal(events.some(event=>event.type==='planx/run-terminal'&&event.data.phase===phase),true)
    for(const event of events)if(event.type.startsWith('planx/'))assert.notEqual(snapshotJsonValue(event.data),undefined)
  }finally{await cleanup(root)}
})
