import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import type { PatchArtifact } from '../git/patches.ts'
import { assertOwnedPaths } from '../git/ownership.ts'
import { assertRepoPathsConfined } from '../git/repository.ts'
import { fingerprintPath, type PathFingerprint } from '../git/fingerprints.ts'
export function needsIntegrator(taskCount:number,hasWorktreePatch:boolean,crossTaskWiring:boolean,conflict:boolean){return !(taskCount===1&&!hasWorktreePatch&&!crossTaskWiring&&!conflict)}
function verifyPatch(patch:PatchArtifact){const {sha256,...raw}=patch;const actual=createHash('sha256').update(JSON.stringify(raw)).digest('hex');if(actual!==sha256)throw new Error(`patch artifact hash mismatch for ${patch.taskId}`);for(const f of patch.files)if(f.kind==='file'){const bytes=Buffer.from(f.contentBase64??'','base64'),hash=createHash('sha256').update(bytes).digest('hex');if(hash!==f.sha256)throw new Error(`patch file hash mismatch: ${f.path}`)}}
function assertSymlinkTarget(root:string,path:string,target:string){if(!target)throw new Error(`empty symlink target: ${path}`);const b=resolve(root),resolved=resolve(dirname(join(b,path)),target);if(resolved!==b&&!resolved.startsWith(b+sep))throw new Error(`symlink target escapes repository: ${path} -> ${target}`)}
function sameFingerprint(left:PathFingerprint,right:PathFingerprint){return JSON.stringify(left)===JSON.stringify(right)}
export interface PatchApplyOptions{
  /** Expected state of every patched path before the write, from `pathFingerprints`. */
  expected?:Record<string,PathFingerprint>
}
/**
 * Apply one captured patch.
 *
 * A patch is captured from an isolated lease and applied to the main tree much
 * later, so the two are separated by an unbounded window in which the user can
 * edit the very files the patch is about to overwrite. Writing unconditionally
 * silently discarded that edit. Every file is therefore checked against the
 * fingerprint captured when the tree was read: a mismatch is a blocked safety
 * boundary, never a silent overwrite.
 */
export async function applyPatchArtifact(root:string,patch:PatchArtifact,unionOwnership:string[],options:PatchApplyOptions={}){
  verifyPatch(patch);const paths=patch.files.map(f=>f.path);assertOwnedPaths(paths,unionOwnership);await assertRepoPathsConfined(root,paths)
  const expected=options.expected
  if(expected){
    const drifted:string[]=[]
    for(const path of paths){
      const want=expected[path]
      if(!want)continue
      if(!sameFingerprint(want,await fingerprintPath(root,path)))drifted.push(path)
    }
    if(drifted.length>0)throw new Error(`working tree changed after the host read it; refusing to overwrite: ${drifted.join(', ')}`)
  }
  for(const f of patch.files){const target=join(root,f.path);if(f.kind==='delete'){await rm(target,{force:true});continue}await mkdir(dirname(target),{recursive:true});if(f.kind==='symlink'){assertSymlinkTarget(root,f.path,f.target!);await rm(target,{force:true});await symlink(f.target!,target);continue}await writeFile(target,Buffer.from(f.contentBase64!,'base64'))}}
export function integratorPrompt(planJson:string,handoffs:string[],patchLocators:string[]){return `Role: Integrator\nDo not redesign or expand scope. You may modify only union ownership. Account for every accepted Worker patch; missing/ambiguous artifacts are BLOCKED. Never commit/push/reset/clean.\n\nAuthoritative PlanArtifact:\n${planJson}\n\nBounded handoff:\n${handoffs.join('\n')}\n\nPatch locators:\n${patchLocators.join('\n')}`}
