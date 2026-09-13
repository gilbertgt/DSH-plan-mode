import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, fullHead } from '../../src/git/repository.ts'
import { snapshotDirty, snapshotHash } from '../../src/git/fingerprints.ts'
import { runValidation } from '../../src/validation/runner.ts'
import { assertTrustedReceipts } from '../../src/validation/review-handoff.ts'
import { diagnoseResume } from '../../src/recovery/reconcile.ts'

async function repo(){
  const d=await mkdtemp(join(tmpdir(),'planx-val-'))
  await git(d,['init']);await git(d,['config','user.email','test@example.com']);await git(d,['config','user.name','test'])
  await writeFile(join(d,'base.txt'),'base')
  await writeFile(join(d,'package.json'),JSON.stringify({private:true,scripts:{test:'node --test','test:unit':'node --test test/unit/*.test.mjs'}},null,2))
  await git(d,['add','.']);await git(d,['commit','-m','base'])
  return d
}

function shellResult(overrides={}){
  return {
    exitCode:0,signal:null,timedOut:false,aborted:false,
    stdout:{text:'ok',truncated:false},stderr:{text:'',truncated:false},
    sandbox:{mode:'workspace-write',denied:false,enforcement:'full',runnerFailed:false},
    ...overrides,
  }
}
function fakeShell(run){
  return {resolve(request){return request},run:run??(async()=>shellResult())}
}
async function validation(d,runDir,id,shell=fakeShell(),command='npm test',timeoutMs=3000,capBytes=1024*1024){
  return runValidation({cwd:d,runDir,runId:'r1',phase:'VALIDATING',commandId:id,command,timeoutMs,capBytes,shell})
}

test('sandboxed host validation distinguishes pass/fail/unsafe mutation/timeout and detects tampering',async()=>{
  const d=await repo(),runDir=await mkdtemp(join(tmpdir(),'planx-run-'))
  try{
    const pass=await validation(d,runDir,'pass')
    assert.equal(pass.status,'PASS');assert.equal(pass.complete,true);assert.equal(pass.exitCode,0)
    assert.deepEqual(pass.sandbox,{mode:'workspace-write',denied:false,enforcement:'full',runnerFailed:false})
    await assertTrustedReceipts([pass],await fullHead(d),pass.ownershipFingerprint)
    await writeFile(pass.stdout.path,'tampered')
    const currentHead=await fullHead(d)
    await assert.rejects(()=>assertTrustedReceipts([pass],currentHead,pass.ownershipFingerprint),/tampered validation receipt|verification failed/)

    const fail=await validation(d,runDir,'fail',fakeShell(async()=>shellResult({exitCode:3})))
    assert.equal(fail.status,'FAIL');assert.equal(fail.exitCode,3)

    const mutation=await validation(d,runDir,'mutate',fakeShell(async()=>{await writeFile(join(d,'generated.txt'),'x');return shellResult()}))
    assert.equal(mutation.status,'UNSAFE_MUTATION')
    await rm(join(d,'generated.txt'),{force:true})

    const timeout=await validation(d,runDir,'timeout',fakeShell(async()=>shellResult({timedOut:true,exitCode:null})))
    assert.equal(timeout.status,'INCONCLUSIVE');assert.equal(timeout.complete,false);assert.equal(timeout.exitCode,null)
  }finally{await rm(d,{recursive:true,force:true});await rm(runDir,{recursive:true,force:true})}
})

test('validation accepts supported Windows partial enforcement and fails closed elsewhere',async()=>{
  const d=await repo(),runDir=await mkdtemp(join(tmpdir(),'planx-cap-'))
  try{
    const truncated=await validation(d,runDir,'cap',fakeShell(async()=>shellResult({stdout:{text:'tail',truncated:true}})))
    assert.equal(truncated.status,'INCONCLUSIVE');assert.equal(truncated.stdout.truncated,true)

    const noSandbox=await validation(d,runDir,'nosandbox',fakeShell(async()=>{const x=shellResult();delete x.sandbox;return x}))
    assert.equal(noSandbox.status,'INCONCLUSIVE');assert.equal(noSandbox.complete,false);assert.equal(noSandbox.sandbox,undefined)

    const partialFacts={mode:'workspace-write',denied:false,enforcement:'partial',runnerFailed:false}
    const partial=await validation(d,runDir,'partial',fakeShell(async()=>shellResult({sandbox:partialFacts})))
    assert.deepEqual(partial.sandbox,partialFacts)
    assert.equal(partial.status,process.platform==='win32'?'PASS':'INCONCLUSIVE')
    assert.equal(partial.complete,process.platform==='win32')

    const partialFail=await validation(d,runDir,'partial-fail',fakeShell(async()=>shellResult({exitCode:3,sandbox:partialFacts})))
    assert.equal(partialFail.status,process.platform==='win32'?'FAIL':'INCONCLUSIVE')

    const partialDenied=await validation(d,runDir,'partial-denied',fakeShell(async()=>shellResult({exitCode:1,sandbox:{...partialFacts,denied:true}})))
    assert.equal(partialDenied.status,'UNSAFE_MUTATION')

    const runnerFailed=await validation(d,runDir,'runner-failed',fakeShell(async()=>shellResult({sandbox:{...partialFacts,runnerFailed:true}})))
    assert.equal(runnerFailed.status,'INCONCLUSIVE');assert.equal(runnerFailed.complete,false)
    assert.equal(runnerFailed.sandbox.runnerFailed,true)

    const denied=await validation(d,runDir,'denied',fakeShell(async()=>shellResult({exitCode:1,sandbox:{mode:'workspace-write',denied:true,enforcement:'full',runnerFailed:false}})))
    assert.equal(denied.status,'UNSAFE_MUTATION')
  }finally{await rm(d,{recursive:true,force:true});await rm(runDir,{recursive:true,force:true})}
})

test('validation refuses arbitrary commands and nonexistent package scripts before shell execution',async()=>{
  const d=await repo(),runDir=await mkdtemp(join(tmpdir(),'planx-policy-'))
  try{
    let runs=0;const shell=fakeShell(async()=>{runs++;return shellResult()})
    await assert.rejects(()=>validation(d,runDir,'unsafe',shell,'node -e process.exit(0)'),/package scripts|validation command/)
    await assert.rejects(()=>validation(d,runDir,'missing',shell,'npm run does-not-exist'),/does not exist/)
    assert.equal(runs,0)
  }finally{await rm(d,{recursive:true,force:true});await rm(runDir,{recursive:true,force:true})}
})

test('recovery resumes only matching safe checkpoints and blocks fingerprint/head drift',async()=>{
  const d=await repo()
  try{
    const head=await fullHead(d),snapshot=await snapshotDirty(d),fingerprint=snapshotHash(snapshot)
    const manifest={schemaVersion:1,runId:'r',sessionId:'s',planHash:'h',phase:'INTERRUPTED',terminal:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),baselineHead:head,ownership:['base.txt'],completedTaskIds:['t1'],artifacts:{}}
    const checkpoint={schemaVersion:1,head,ownership:['base.txt'],changedPaths:[],fingerprint,phase:'WORKERS',completedTaskIds:['t1'],safeBoundary:true,at:new Date().toISOString()}
    const ok=await diagnoseResume(d,manifest,checkpoint)
    assert.equal(ok.resumable,true);assert.equal(ok.resumeFrom,'WORKERS');assert.deepEqual(ok.completedTaskIds,['t1'])

    await writeFile(join(d,'drift.txt'),'user')
    const drift=await diagnoseResume(d,manifest,checkpoint)
    assert.equal(drift.resumable,false);assert.match(drift.reason,/fingerprint drift/)
    await rm(join(d,'drift.txt'))

    await writeFile(join(d,'base.txt'),'next');await git(d,['add','base.txt']);await git(d,['commit','-m','drift'])
    const headDrift=await diagnoseResume(d,manifest,checkpoint)
    assert.equal(headDrift.resumable,false);assert.match(headDrift.reason,/HEAD drift/)
  }finally{await rm(d,{recursive:true,force:true})}
})
