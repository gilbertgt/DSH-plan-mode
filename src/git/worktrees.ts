import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { git } from './repository.ts'
import { confined, stateRoot } from '../recovery/store.ts'

export interface WorktreeLease{path:string;runId:string;taskId:string;baseHead:string}

function safeSegment(value:string):string{
  if(/^[A-Za-z0-9._-]{1,120}$/.test(value))return value
  return createHash('sha256').update(value).digest('hex')
}

/** Engine lease ids may append -worktrees/-validation-* to the run UUID. All
 * physical leases still live under worktrees/<base-run-id>/ so terminal cleanup
 * owns one exact directory tree. */
export function worktreeRunKey(runId:string):string{
  const match=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/i.exec(runId)
  return safeSegment(match?.[1]??runId)
}

export async function createWorktree(repo:string,runId:string,taskId:string,head:string,root=stateRoot()):Promise<WorktreeLease>{
  const runKey=worktreeRunKey(runId)
  const leaseKey=safeSegment(`${runId}--${taskId}`)
  const path=confined(root,'worktrees',runKey,leaseKey)
  await mkdir(join(path,'..'),{recursive:true})
  await git(repo,['worktree','add','--detach',path,head])
  return{path,runId:runKey,taskId,baseHead:head}
}

export async function removeOwnedWorktree(repo:string,lease:WorktreeLease,force=false){
  await git(repo,['worktree','remove',...(force?['--force']:[]),lease.path])
  await rm(lease.path,{recursive:true,force:true}).catch(()=>{})
}

export async function cleanupRunWorktrees(repo:string,runId:string,root=stateRoot()){
  const runRoot=resolve(confined(root,'worktrees',worktreeRunKey(runId)))
  const listed=(await git(repo,['worktree','list','--porcelain','-z'])).stdout.toString('utf8').split('\0')
  for(const rec of listed){
    const line=rec.split('\n').find(x=>x.startsWith('worktree '))
    if(!line)continue
    const path=resolve(line.slice(9))
    if(path!==runRoot&&!path.startsWith(runRoot+sep))continue
    await git(repo,['worktree','remove','--force',path]).catch(()=>{})
    await rm(path,{recursive:true,force:true}).catch(()=>{})
  }
  await rm(runRoot,{recursive:true,force:true}).catch(()=>{})
}
