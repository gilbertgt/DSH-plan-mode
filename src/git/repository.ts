import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
const execFileP=promisify(execFile)
export interface GitResult{stdout:Buffer;stderr:Buffer}
export async function git(cwd:string,args:string[],opts:{maxBuffer?:number}={}):Promise<GitResult>{const r=await execFileP('git',args,{cwd,encoding:'buffer',maxBuffer:opts.maxBuffer??32*1024*1024,windowsHide:true});return {stdout:r.stdout as Buffer,stderr:r.stderr as Buffer}}
export function decodeUtf8Strict(buf:Buffer){return new TextDecoder('utf-8',{fatal:true}).decode(buf)}
export function splitNul(buf:Buffer){const text=decodeUtf8Strict(buf);if(!text)return[];const parts=text.split('\0');if(parts.at(-1)==='')parts.pop();return parts}
export async function repoRoot(cwd:string){return decodeUtf8Strict((await git(cwd,['rev-parse','--show-toplevel'])).stdout).trim()}
export async function fullHead(cwd:string){const h=decodeUtf8Strict((await git(cwd,['rev-parse','--verify','HEAD'])).stdout).trim();if(!/^[0-9a-f]{40}$/.test(h))throw new Error('HEAD is not a full SHA');return h}
export function assertRepoPath(root:string,path:string){const b=resolve(root),t=resolve(b,path);if(t!==b&&!t.startsWith(b+sep))throw new Error(`path escapes repository: ${path}`);return t}
function inside(root:string,target:string){return target===root||target.startsWith(root+sep)}
async function nearestExisting(path:string):Promise<string>{let current=path;while(true){try{await lstat(current);return current}catch(e:any){if(e?.code!=='ENOENT')throw e;const parent=dirname(current);if(parent===current)throw new Error(`no existing ancestor for ${path}`);current=parent}}}
/** Resolve existing symlink-bearing ancestors so an apparently in-repo target cannot escape through a junction/symlink. */
export async function assertRepoPathConfined(root:string,path:string){const lexical=assertRepoPath(root,path),realRoot=await realpath(resolve(root));const existing=await nearestExisting(lexical);const realExisting=await realpath(existing);if(!inside(realRoot,realExisting))throw new Error(`path escapes repository through symlink/junction: ${path}`);return lexical}
export async function assertRepoPathsConfined(root:string,paths:string[]){for(const path of paths)await assertRepoPathConfined(root,path)}
export async function changedPaths(cwd:string){
 const tracked=splitNul((await git(cwd,['diff','--name-only','-z','HEAD','--'])).stdout)
 const staged=splitNul((await git(cwd,['diff','--cached','--name-only','-z','HEAD','--'])).stdout)
 const untracked=splitNul((await git(cwd,['ls-files','--others','--exclude-standard','-z'])).stdout)
 return [...new Set([...tracked,...staged,...untracked])]
}
