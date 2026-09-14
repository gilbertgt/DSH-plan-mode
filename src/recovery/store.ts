import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
export const stateRoot = () => resolve(process.env.DSH_HOME ? join(process.env.DSH_HOME,'state','plan-orchestrator') : join(homedir(),'.dsh','state','plan-orchestrator'))
export function confined(root:string, ...parts:string[]){const base=resolve(root), target=resolve(base,...parts); if(target!==base&&!target.startsWith(base+sep))throw new Error('artifact path escapes plugin root'); return target}
/** Injectable publish step, so the rename retry is provable without an OS fault. */
export interface AtomicJsonOptions { rename?: (from: string, to: string) => Promise<void> }

/**
 * Publish one JSON artifact by writing a private temp file and renaming it over
 * the target, so a reader never observes a partial file.
 *
 * The rename is retried: on Windows a concurrent reader holding the destination
 * open makes `rename` fail with EPERM, and this file is read by polling clients
 * (the run view, `run-detail`) while a run is writing it. A single failure here
 * would abort the write that records the run's own state, so the transient
 * sharing violation must not be fatal. Retries still surface a real fault: the
 * last attempt's error is thrown.
 */
export async function atomicJson(path:string,value:unknown,options:AtomicJsonOptions={}){
  const publish=options.rename??rename
  await mkdir(dirname(path),{recursive:true})
  const tmp=`${path}.${randomUUID()}.tmp`
  const body=JSON.stringify(value,null,2)+'\n'
  await writeFile(tmp,body,{encoding:'utf8',mode:0o600})
  try{
    for(let attempt=0;;attempt++){
      try{await publish(tmp,path);break}
      catch(error:any){
        const retryable=error?.code==='EPERM'||error?.code==='EACCES'||error?.code==='EBUSY'
        if(!retryable||attempt>=5)throw error
        await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)))
      }
    }
  }catch(error){
    await rm(tmp,{force:true}).catch(()=>{})
    throw error
  }
  return createHash('sha256').update(body).digest('hex')
}
export async function readJson<T>(path:string):Promise<T>{return JSON.parse(await readFile(path,'utf8')) as T}
export interface RunManifest {schemaVersion:1;runId:string;sessionId:string;planHash:string;phase:string;terminal:boolean;createdAt:string;updatedAt:string;baselineHead?:string;repoRoot?:string;ownership?:string[];externalIssue?:{issueNumber:number;repository:string;revision:number;branch:string;publishAfterPass?:boolean};completedTaskIds?:string[];failureArtifact?:{sha256:string;bytes:number};artifacts:Record<string,{sha256:string;bytes:number}>}
export class RunStore {
  readonly root:string
  constructor(root=stateRoot()){this.root=root}
  sessionDir(sessionId:string){return confined(this.root,'sessions',safe(sessionId))}
  runDir(sessionId:string,runId:string){return confined(this.root,'sessions',safe(sessionId),safe(runId))}
  manifestPath(sessionId:string,runId:string){return join(this.runDir(sessionId,runId),'manifest.json')}
  async writeManifest(m:RunManifest){m.updatedAt=new Date().toISOString();return atomicJson(this.manifestPath(m.sessionId,m.runId),m)}
  async readManifest(sessionId:string,runId:string){return readJson<RunManifest>(this.manifestPath(sessionId,runId))}
  async listSessionManifests(sessionId:string){const dir=this.sessionDir(sessionId);let names:string[]=[];try{names=await readdir(dir)}catch(e:any){if(e?.code==='ENOENT')return[];throw e}const out:RunManifest[]=[];for(const name of names){try{const p=join(dir,name,'manifest.json');if((await stat(p)).isFile())out.push(await readJson<RunManifest>(p))}catch{}}return out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}
  async removeRun(sessionId:string,runId:string){return rm(this.runDir(sessionId,runId),{recursive:true,force:true})}
}
function safe(v:string){if(!/^[A-Za-z0-9._-]{1,200}$/.test(v))return createHash('sha256').update(v).digest('hex');return v}
