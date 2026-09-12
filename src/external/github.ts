import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { changedPaths, fullHead, git, repoRoot } from '../git/repository.ts'
const exec=promisify(execFile)
export async function ghRaw(cwd:string,args:string[]){const r=await exec('gh',args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});return String(r.stdout??'')}
export async function gh(cwd:string,args:string[]){const raw=await ghRaw(cwd,args);return JSON.parse(raw||'null')}
export async function ghRepository(cwd:string){await exec('gh',['auth','status'],{cwd,encoding:'utf8',windowsHide:true});return gh(cwd,['repo','view','--json','nameWithOwner,defaultBranchRef'])}
export async function ghPreflight(cwd:string,repository:string){const actual=await ghRepository(cwd);if(actual?.nameWithOwner!==repository)throw new Error(`repository mismatch: ${actual?.nameWithOwner} != ${repository}`);return actual}
export async function fetchIssue(cwd:string,issue:number){return gh(cwd,['issue','view',String(issue),'--json','number,state,url,body,author,comments'])}

export async function ghRepositoryPermission(cwd:string,repository:string,login:string):Promise<'admin'|'maintain'|'write'|'triage'|'read'|undefined>{
 if(!/^[A-Za-z0-9-]{1,100}$/.test(login))return undefined
 if(!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository))return undefined
 try{
  const permission=(await ghRaw(cwd,['api',`repos/${repository}/collaborators/${login}/permission`,'--jq','.permission'])).trim()
  return ['admin','maintain','write','triage','read'].includes(permission)?permission as any:undefined
 }catch{return undefined}
}
export function canAuthorExternalControl(permission:string|undefined):boolean{return permission==='admin'||permission==='maintain'||permission==='write'}

export async function trustedIssueTexts(cwd:string,repository:string,issue:any):Promise<string[]>{
 const sources=[
  {body:String(issue?.body??''),login:String(issue?.author?.login??'')},
  ...(issue?.comments??[]).map((comment:any)=>({body:String(comment?.body??''),login:String(comment?.author?.login??'')})),
 ]
 const cache=new Map<string,boolean>()
 const trusted:string[]=[]
 for(const source of sources){
  if(!source.login||!source.body)continue
  let allowed=cache.get(source.login)
  if(allowed===undefined){allowed=canAuthorExternalControl(await ghRepositoryPermission(cwd,repository,source.login));cache.set(source.login,allowed)}
  if(allowed)trusted.push(source.body)
 }
 return trusted
}

export async function ensureBaseCommit(cwd:string,sha:string){await git(cwd,['cat-file','-e',`${sha}^{commit}`]);return sha}
export async function branchExists(cwd:string,branch:string){try{await git(cwd,['show-ref','--verify','--quiet',`refs/heads/${branch}`]);return true}catch{return false}}
export async function prepareIssueBranch(cwd:string,branch:string,baseCommit:string){const root=await repoRoot(cwd),dirty=await changedPaths(root);if(dirty.length)throw new Error(`external issue mode requires a clean working tree; dirty: ${dirty.join(', ')}`);await ensureBaseCommit(root,baseCommit);if(await branchExists(root,branch)){await git(root,['switch',branch]);const head=await fullHead(root);if(head!==baseCommit)throw new Error(`existing ${branch} is not at trusted baseCommit; continuation requires remote completion/recovery evidence`)}else await git(root,['switch','-c',branch,baseCommit]);return root}
export async function remotePr(cwd:string,pr:number){return gh(cwd,['pr','view',String(pr),'--json','number,state,url,headRefOid,headRefName'])}
export async function openPrForBranch(cwd:string,branch:string){const rows=await gh(cwd,['pr','list','--head',branch,'--state','open','--json','number,state,url,headRefOid,headRefName']);return Array.isArray(rows)?rows[0]:undefined}
