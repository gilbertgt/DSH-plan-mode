import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileCaptured } from '../../src/platform/captured-exec.ts'
import { assertRepoPathConfined } from '../../src/git/repository.ts'
import { minimalSdkEnv, sdkHarnessOptions } from '../../src/orchestration/sdk-backend.ts'

/**
 * Run one Git command whose output is not needed.
 *
 * `execFileCaptured` is the project's single subprocess seam: it selects
 * file-backed stdio under the DSH sandbox marker and ordinary `execFile`
 * everywhere else. Calling `execFileSync`/`spawnSync` directly here would
 * reintroduce libuv named-pipe stdio, which a confined Windows grandchild
 * cannot open, so the whole platform lane would fail with `spawn EPERM`
 * instead of reporting a real regression.
 */
async function git(cwd, args, options = {}) {
  return execFileCaptured('git', args, { cwd, ...options })
}

test('platform supports CJK and spaces through Git machine output', async()=>{
  const root=await mkdtemp(join(tmpdir(),'planx 平台 '))
  try{
    await git(root,['init'])
    await git(root,['config','user.email','test@example.com'])
    await git(root,['config','user.name','test'])
    await writeFile(join(root,'初始.txt'),'base')
    await git(root,['add','.']);await git(root,['commit','-m','base'])
    await writeFile(join(root,'韓文 이름.txt'),'x')
    const out=(await execFileCaptured('git',['ls-files','--others','--exclude-standard','-z'],{cwd:root})).stdout
    assert.match(out.toString('utf8'),/韓文 이름\.txt/)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('SDK child launch options preserve worktree cwd and exact role route',()=>{
  const req={cwd:process.platform==='win32'?'C:\\工作 樹\\task-1':'/tmp/工作 樹/task-1',profile:'worker',taskId:'task-1',prompt:'x',route:{provider:'p',model:'m',reasoningEffort:'high',maxTokens:1234}}
  const out=sdkHarnessOptions(req)
  assert.equal(out.cwd,req.cwd);assert.equal(out.profile,'worker');assert.equal(out.provider,'p');assert.equal(out.model,'m');assert.equal(out.maxTokens,1234);assert.equal(out.patches.length,1);assert.match(out.patches[0],/profiles[\\/]worker\.cordis\.yml$/)
})

test('symlink/junction escape is rejected (where platform permits symlinks)', async(t)=>{
  const base=await mkdtemp(join(tmpdir(),'planx-boundary-')),root=join(base,'repo'),outside=join(base,'outside')
  try{
    await mkdir(root);await mkdir(outside);await git(root,['init'])
    try{await symlink(outside,join(root,'escape'),process.platform==='win32'?'junction':'dir')}catch(e){t.skip(`symlink unavailable: ${e.code??e}`);return}
    await assert.rejects(()=>assertRepoPathConfined(root,'escape/file.txt'),/escapes repository/)
  }finally{await rm(base,{recursive:true,force:true})}
})

test('SDK environment scrubs unrelated secrets while retaining runtime and provider credentials',()=>{
  const env=minimalSdkEnv({PATH:'/bin',OPENAI_API_KEY:'ok',COMMANDCODE_API_KEY:'goat',UNRELATED_SECRET:'nope',AWS_SECRET_ACCESS_KEY:'nope'})
  assert.equal(env.OPENAI_API_KEY,'ok');assert.equal(env.COMMANDCODE_API_KEY,'goat');assert.equal(env.UNRELATED_SECRET,undefined);assert.equal(env.AWS_SECRET_ACCESS_KEY,undefined)
})
