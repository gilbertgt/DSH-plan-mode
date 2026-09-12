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
  await writeFile(join(d,'base.txt'),'base');await git(d,['add','.']);await git(d,['commit','-m','base'])
  return d
}

async function validation(d,runDir,id,command,timeoutMs=3000,capBytes=1024*1024){
  return runValidation({cwd:d,runDir,runId:'r1',phase:'VALIDATING',commandId:id,command,timeoutMs,capBytes})
}

test('host validation distinguishes pass/fail/unsafe mutation/timeout and detects tampering',async()=>{
  const d=await repo(),runDir=await mkdtemp(join(tmpdir(),'planx-run-'))
  try{
    const pass=await validation(d,runDir,'pass','node -e "process.stdout.write(\'ok\')"')
    assert.equal(pass.status,'PASS');assert.equal(pass.complete,true);assert.equal(pass.exitCode,0)
    await assertTrustedReceipts([pass],await fullHead(d),pass.ownershipFingerprint)
    await writeFile(pass.stdout.path,'tampered')
    const currentHead=await fullHead(d)
    await assert.rejects(()=>assertTrustedReceipts([pass],currentHead,pass.ownershipFingerprint),/tampered validation receipt|verification failed/)

    const fail=await validation(d,runDir,'fail','node -e "process.exit(3)"')
    assert.equal(fail.status,'FAIL');assert.equal(fail.exitCode,3)

    const mutation=await validation(d,runDir,'mutate','node -e "require(\'fs\').writeFileSync(\'generated.txt\',\'x\')"')
    assert.equal(mutation.status,'UNSAFE_MUTATION')
    await rm(join(d,'generated.txt'),{force:true})

    const timeout=await validation(d,runDir,'timeout','node -e "setTimeout(()=>{},5000)"',100)
    assert.equal(timeout.status,'INCONCLUSIVE');assert.equal(timeout.complete,false);assert.equal(timeout.exitCode,null)
  }finally{await rm(d,{recursive:true,force:true});await rm(runDir,{recursive:true,force:true})}
})

test('validation stream cap is inconclusive rather than a false pass',async()=>{
  const d=await repo(),runDir=await mkdtemp(join(tmpdir(),'planx-cap-'))
  try{
    const receipt=await validation(d,runDir,'cap','node -e "process.stdout.write(\'x\'.repeat(4096))"',3000,128)
    assert.equal(receipt.status,'INCONCLUSIVE');assert.equal(receipt.stdout.truncated,true);assert.equal(receipt.stdout.bytes,128)
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
