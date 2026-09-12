import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {git,fullHead} from '../../src/git/repository.ts'
import {createWorktree,removeOwnedWorktree,cleanupRunWorktrees,worktreeRunKey} from '../../src/git/worktrees.ts'
import {capturePatch} from '../../src/git/patches.ts'
import {applyPatchArtifact} from '../../src/orchestration/integrator.ts'
async function repo(){const d=await mkdtemp(join(tmpdir(),'planx-wt-'));await git(d,['init']);await git(d,['config','user.email','test@example.com']);await git(d,['config','user.name','test']);await writeFile(join(d,'a.bin'),Buffer.from([0,1,2]));await git(d,['add','.']);await git(d,['commit','-m','base']);return d}
test('worktree patch reconstructs binary/new file without touching main during worker',async()=>{const d=await repo(),state=await mkdtemp(join(tmpdir(),'planx-state-'));try{const h=await fullHead(d),lease=await createWorktree(d,'r1','t1',h,state);await writeFile(join(lease.path,'a.bin'),Buffer.from([9,8,7,0]));await writeFile(join(lease.path,'new.txt'),'new');assert.deepEqual([...await readFile(join(d,'a.bin'))],[0,1,2]);const patch=await capturePatch(lease.path,h,'t1',['a.bin','new.txt']);await applyPatchArtifact(d,patch,['a.bin','new.txt']);assert.deepEqual([...await readFile(join(d,'a.bin'))],[9,8,7,0]);assert.equal(await readFile(join(d,'new.txt'),'utf8'),'new');await removeOwnedWorktree(d,lease,true)}finally{await rm(d,{recursive:true,force:true});await rm(state,{recursive:true,force:true})}})

test('composite worker and validation lease ids remain owned by one cleanup run root',async()=>{
 const d=await repo(),state=await mkdtemp(join(tmpdir(),'planx-state-clean-'))
 const run='123e4567-e89b-12d3-a456-426614174000'
 try{
  const h=await fullHead(d)
  const worker=await createWorktree(d,`${run}-worktrees`,'t1',h,state)
  const validation=await createWorktree(d,`${run}-validation-12345`,'__validation__',h,state)
  assert.equal(worker.runId,run);assert.equal(validation.runId,run);assert.equal(worktreeRunKey(`${run}-worktrees`),run)
  await cleanupRunWorktrees(d,run,state)
  await assert.rejects(()=>stat(worker.path),/ENOENT/)
  await assert.rejects(()=>stat(validation.path),/ENOENT/)
 }finally{await rm(d,{recursive:true,force:true});await rm(state,{recursive:true,force:true})}
})
