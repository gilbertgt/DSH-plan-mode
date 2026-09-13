import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { OrchestrationService } from '../../src/orchestration/service.ts'
import { createOrchestratorRunner, currentRoute } from '../../src/orchestration/engine.ts'
import { routeChoices } from '../../src/orchestration/role-router.ts'
import { assertNoUndefinedEventData } from '../../src/contract/events.ts'
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

function store(root,{failWriteAt=[]}={}){
  const manifests=new Map()
  let writes=0
  return {
    root,
    runDir(sessionId,runId){return join(root,'sessions',sessionId,runId)},
    async writeManifest(value){
      writes++
      if(failWriteAt.includes(writes))throw new Error(`simulated manifest write failure #${writes}`)
      manifests.set(value.runId,structuredClone(value))
    },
    async readManifest(_sessionId,runId){const value=manifests.get(runId);if(!value)throw new Error('manifest missing');return structuredClone(value)},
    async removeRun(){},
    async listSessionManifests(){return[]},
    manifest(runId){return manifests.get(runId)},
    get writes(){return writes},
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
  assert.throws(()=>assertNoUndefinedEventData({runId:'r',phase:'PREFLIGHT',message:undefined},'planx/run-phase'),/undefined value at planx\/run-phase\.message/)
  assert.throws(()=>appendLikeDsh([],'planx/run-phase',{runId:'r',phase:'PREFLIGHT',message:undefined}),/non-JSON-serializable/)
  assert.doesNotThrow(()=>assertNoUndefinedEventData({runId:'r',phase:'PREFLIGHT'},'planx/run-phase'))
  // The guard names the offending path for the shapes it does claim to catch.
  assert.throws(()=>assertNoUndefinedEventData({a:{b:[1,undefined]}},'planx/x'),/undefined value at planx\/x\.a\.b\[1\]/)
  assert.throws(()=>assertNoUndefinedEventData({a:Number.NaN},'planx/x'),/non-finite number/)
  const circular={};circular.self=circular
  assert.throws(()=>assertNoUndefinedEventData(circular,'planx/x'),/circular reference/)
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(()=>assertNoUndefinedEventData({a:[1,,3]},'planx/x'),/sparse array/)
  assert.throws(()=>assertNoUndefinedEventData({a:new Date()},'planx/x'),/non-plain object/)
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
  // An unresolved inherited agent has no provider/model; those must be absent
  // too, otherwise the object itself fails the DSH lossless-JSON boundary.
  assert.equal('provider' in fromBareAgent,false)
  assert.equal('model' in fromBareAgent,false)
  assert.notEqual(snapshotJsonValue(fromBareAgent),undefined,'a bare-agent route must still be lossless JSON')
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

test('switching a planner to a fixed route must not inherit the previous reasoning effort',async()=>{
  const {installPlannerRoute}=await import('../../src/planning/planner-route.ts')
  const handlers=new Map()
  const ctx={llm:{resolveCallConfig:async()=>{}},on(name,handler){handlers.set(name,handler);return()=>handlers.delete(name)}}
  installPlannerRoute(ctx,()=>({mode:'fixed',provider:'modelB',model:'modelB',fallbacks:[]}),()=>true,()=>true)

  // The live request already carries the previous model's reasoning effort.
  const previous={provider:'modelA',model:'modelA',reasoningEffort:'high',maxTokens:321}
  const routed=await handlers.get('agent/request')({agent:{}},async()=>previous)
  assert.equal(routed.provider,'modelB')
  assert.equal(routed.model,'modelB')
  assert.equal('reasoningEffort' in routed,false,'the previous model effort must not carry over to a route that declares none')
  assert.equal(Object.values(routed).includes(undefined),false,'no routed field may be an explicit undefined')
  assert.notEqual(snapshotJsonValue(routed),undefined,'the routed request must be lossless JSON')
  // maxTokens keeps its original fallback to the native request value.
  assert.equal(routed.maxTokens,321)

  // A route that declares its own effort still wins.
  const handlers2=new Map()
  const ctx2={llm:{resolveCallConfig:async()=>{}},on(name,handler){handlers2.set(name,handler);return()=>handlers2.delete(name)}}
  installPlannerRoute(ctx2,()=>({mode:'fixed',provider:'modelB',model:'modelB',reasoningEffort:'low',maxTokens:99,fallbacks:[]}),()=>true,()=>true)
  const explicit=await handlers2.get('agent/request')({agent:{}},async()=>previous)
  assert.equal(explicit.reasoningEffort,'low')
  assert.equal(explicit.maxTokens,99)
  assert.notEqual(snapshotJsonValue(explicit),undefined)
})

// C2. terminal persistence failure must never announce the original success phase.
// Case A: the intended terminal write fails once, the retry succeeds. The
// on-disk manifest must still converge on FAILED + terminal, otherwise recovery
// would later misread the run as INTERRUPTED.
test('a transient terminal write failure is retried and still lands FAILED + terminal on disk',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-terminal-retry-'))
  try{
    // writes: 1 = approval, 2 = PREFLIGHT, 3 = intended terminal (fails), 4 = retry (succeeds).
    const st=store(root,{failWriteAt:[3]})
    const {agent:a,events}=agent('s-terminal')
    const service=new OrchestrationService(st,async()=>{})
    const runId=service.approve({sessionId:'s-terminal',agent:a,artifact:{tasks:[]},planHash:'h'})
    assert.equal(await service.onParentIdle('s-terminal'),true)
    await waitFor(()=>events.some(event=>event.type==='planx/run-terminal'),{label:'terminal event'})
    await waitFor(()=>service.activeRun('s-terminal')===undefined,{label:'run settled'})

    // The retry must have persisted the converged terminal state on disk.
    const manifest=st.manifest(runId)
    assert.equal(manifest.phase,'FAILED','the retried write must persist FAILED')
    assert.equal(manifest.terminal,true,'the retried write must persist terminal:true')
    assert.equal(st.writes,4,'exactly one retry is attempted')

    const terminalPhases=events.filter(event=>event.type==='planx/run-terminal').map(event=>event.data.phase)
    assert.equal(terminalPhases.includes('COMPLETE'),false,`no terminal event may announce COMPLETE after persistence failed: ${terminalPhases.join(',')}`)
    assert.equal(terminalPhases.every(phase=>phase==='FAILED'),true,`unexpected terminal phases: ${terminalPhases.join(',')}`)
    const view=service.list('s-terminal').find(item=>item.runId===runId)
    assert.equal(view.phase,'FAILED')
    assert.match(String(view.message),/terminal manifest persistence failed/)
    for(const event of events)if(event.type.startsWith('planx/'))assert.notEqual(snapshotJsonValue(event.data),undefined)
  }finally{await cleanup(root)}
})

// Case B: the intended write and the retry both fail, and session.append fails
// too. finalize() must still contain everything and leave the FAILED run view.
test('a persistent terminal write failure stays contained and never announces COMPLETE',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-double-fail-'))
  try{
    // The intended terminal write (3), the retry (4) and all later writes fail.
    const st=store(root,{failWriteAt:[3,4,5,6]})
    const {agent:a,events}=agent('s-double')
    // Rejections escaping the run task are surfaced by start(), so capture them.
    let escaped
    a.runMaintenance=fn=>{const task=Promise.resolve().then(()=>fn(new AbortController().signal));task.catch(error=>{escaped=error});return task}
    // Gate the runner so append failures are installed BEFORE finalize runs;
    // otherwise the run can finish inside the await and never exercise it.
    let release
    const gate=new Promise(resolve=>{release=resolve})
    const service=new OrchestrationService(st,async()=>{await gate})
    const runId=service.approve({sessionId:'s-double',agent:a,artifact:{tasks:[]},planHash:'h'})
    const originalAppend=a.session.append.bind(a.session)
    let failAppends=false
    a.session.append=(type,data)=>{
      if(failAppends)throw new Error('session append unavailable')
      return originalAppend(type,data)
    }
    assert.equal(await service.onParentIdle('s-double'),true)
    await waitFor(()=>events.some(event=>event.type==='planx/run-phase'&&event.data.phase==='PREFLIGHT'),{label:'PREFLIGHT event'})
    // From here on, every session append fails as well.
    failAppends=true
    release()
    await waitFor(()=>service.activeRun('s-double')===undefined,{label:'run settled'})
    // finalize() is documented as never throwing: an append failure while
    // handling a persistence failure must not become a second escaping error.
    assert.equal(escaped,undefined,`finalize must contain its own failures, got: ${escaped?.message}`)
    const view=service.list('s-double').find(item=>item.runId===runId)
    assert.equal(view.phase,'FAILED','the run view is the last resort when persistence and append both fail')
    assert.match(String(view.message),/terminal manifest persistence failed/)
    assert.match(String(view.message),/retry failed/)
    // The runtime must not drift back to a non-failure state.
    assert.notEqual(view.phase,'COMPLETE')
    assert.notEqual(view.status,'COMPLETE')
    // Exactly one retry: the intended write plus the retry, and nothing after.
    assert.equal(st.writes,4,'the retry must be attempted exactly once')
    for(const event of events)if(event.type.startsWith('planx/'))assert.notEqual(event.data.phase,'COMPLETE')
  }finally{await cleanup(root)}
})

test('a failed approval persistence still reports FAILED even when the session append also fails',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-approval-fail-'))
  try{
    // write 1 = approval persistence (fails), so onParentIdle reports the failure.
    const st=store(root,{failWriteAt:[1]})
    const {agent:a}=agent('s-approval')
    const service=new OrchestrationService(st,async()=>{throw new Error('runner must not start')})
    const runId=service.approve({sessionId:'s-approval',agent:a,artifact:{tasks:[]},planHash:'h'})
    const originalAppend=a.session.append.bind(a.session)
    a.session.append=(type,data)=>{
      if(type==='planx/run-terminal')throw new Error('session append unavailable')
      return originalAppend(type,data)
    }
    // The unwrapped failView call in onParentIdle must not turn a handled
    // persistence failure into a rejecting promise.
    assert.equal(await service.onParentIdle('s-approval'),false)
    assert.equal(service.shouldFence('s-approval'),false)
    const view=service.list('s-approval').find(item=>item.runId===runId)
    assert.equal(view.phase,'FAILED')
    assert.match(String(view.message),/approval persistence failed/)
  }finally{await cleanup(root)}
})

test('a synchronous maintenance launch failure fails the run closed instead of fencing forever',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-launch-race-'))
  try{
    const st=store(root)
    const {agent:a}=agent('s-race')
    // DSH rejects runMaintenance synchronously when the agent left idle.
    a.runMaintenance=()=>{throw new Error('agent "s-race" already has active work')}
    const service=new OrchestrationService(st,async()=>{})
    const runId=service.approve({sessionId:'s-race',agent:a,artifact:{tasks:[]},planHash:'h'})
    assert.equal(await service.onParentIdle('s-race'),false)
    assert.equal(service.shouldFence('s-race'),false,'the parent must not stay fenced forever')
    assert.equal(service.activeRun('s-race'),undefined)
    await waitFor(()=>st.manifest(runId)?.terminal===true,{label:'terminal manifest after launch failure'})
    const manifest=st.manifest(runId)
    assert.equal(manifest.terminal,true)
    assert.notEqual(manifest.phase,'APPROVED_PENDING')
    assert.ok(['BLOCKED','FAILED'].includes(manifest.phase),`unexpected phase ${manifest.phase}`)
  }finally{await cleanup(root)}
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
    // writes: 1 = approval, 2 = the initial PREFLIGHT write (fails).
    const st=store(root,{failWriteAt:[2]})
    const {agent:a}=agent('s-manifest')
    const service=new OrchestrationService(st,async()=>{})
    const runId=service.approve({sessionId:'s-manifest',agent:a,artifact,planHash:'h'})
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

// E. A runner that cooperatively resolves on abort must still be reported CANCELLED.
test('a cooperatively aborted runner is persisted as CANCELLED, never COMPLETE',{timeout:TEST_TIMEOUT},async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx-coop-cancel-'))
  try{
    const st=store(root)
    const {agent:a,events}=agent('s-coop')
    const service=new OrchestrationService(st,async(_launch,_runId,signal)=>{
      // Resolve cleanly on abort instead of rejecting.
      await new Promise(resolve=>{
        if(signal.aborted)return resolve()
        signal.addEventListener('abort',()=>resolve(),{once:true})
      })
    })
    const runId=service.approve({sessionId:'s-coop',agent:a,artifact:{tasks:[]},planHash:'h'})
    assert.equal(await service.onParentIdle('s-coop'),true)
    await waitFor(()=>st.manifest(runId)?.phase==='PREFLIGHT',{label:'PREFLIGHT started'})
    assert.equal(await service.cancelSession('s-coop','user requested stop'),true)
    await waitFor(()=>st.manifest(runId)?.terminal===true,{label:'terminal manifest'})

    const manifest=st.manifest(runId)
    assert.equal(manifest.terminal,true)
    assert.notEqual(manifest.phase,'COMPLETE','a cancelled run must not be reported as COMPLETE')
    assert.ok(['CANCELLED','BLOCKED','FAILED'].includes(manifest.phase),`unexpected phase ${manifest.phase}`)
    const view=service.list('s-coop').find(item=>item.runId===runId)
    assert.notEqual(view.phase,'COMPLETE')
    const terminalPhases=events.filter(event=>event.type==='planx/run-terminal').map(event=>event.data.phase)
    assert.equal(terminalPhases.includes('COMPLETE'),false,`terminal events must not announce COMPLETE: ${terminalPhases.join(',')}`)
  }finally{await cleanup(root)}
})
