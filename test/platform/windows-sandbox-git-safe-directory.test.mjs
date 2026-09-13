import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { prepareValidationSubprocessEnvironment } from '../../src/validation/runner.ts'
import { needsFileBackedWindowsStdio } from '../../src/platform/captured-exec.ts'

const execFileP = promisify(execFile)
const liveSkip = process.platform !== 'win32'
  ? 'Windows-only host behavior'
  : needsFileBackedWindowsStdio()
    ? 'authoritative validation already runs inside the DSH Windows ACL sandbox'
    : false

test('Windows ACL sandbox can snapshot the exact Host-trusted validation worktree with Git', { skip: liveSkip }, async () => {
  const { AclSandbox, tempWriteSid, workspaceWriteSid } = await import('@deepseek-ai/dsh-sandbox-windows-acl')
  const workspace = await mkdtemp(join(tmpdir(), 'planx-acl-git-workspace-'))
  const privateTemp = await mkdtemp(join(tmpdir(), 'planx-acl-git-temp-'))
  const validationDir = await mkdtemp(join(tmpdir(), 'planx-acl-git-config-'))
  let prepared
  let sandbox

  try {
    await execFileP('git', ['init'], { cwd: workspace, windowsHide: true })
    await writeFile(join(workspace, 'tracked.txt'), 'baseline\n', 'utf8')
    await execFileP('git', ['add', 'tracked.txt'], { cwd: workspace, windowsHide: true })
    await execFileP('git', [
      '-c', 'user.name=Plan Orchestrator Test',
      '-c', 'user.email=plan-orchestrator@example.invalid',
      'commit', '-m', 'baseline',
    ], { cwd: workspace, windowsHide: true })

    prepared = await prepareValidationSubprocessEnvironment(
      workspace,
      validationDir,
      'VALIDATING-platform-git',
      'win32',
    )

    const probe = join(workspace, 'probe.mjs')
    const fingerprintsUrl = pathToFileURL(resolve('src/git/fingerprints.ts')).href
    await writeFile(probe, `
process.env.PLANX_SANDBOX_VALIDATION = '1'
process.env.GIT_CONFIG_GLOBAL = ${JSON.stringify(prepared.env.GIT_CONFIG_GLOBAL)}
process.env.TMP = ${JSON.stringify(privateTemp)}
process.env.TEMP = ${JSON.stringify(privateTemp)}
const { snapshotDirty } = await import(${JSON.stringify(fingerprintsUrl)})
const snapshot = await snapshotDirty(${JSON.stringify(workspace)})
if (!/^[0-9a-f]{40}$/.test(snapshot.head)) {
  process.stderr.write('unexpected HEAD: ' + snapshot.head)
  process.exitCode = 2
}
if (Object.keys(snapshot.paths).some(path => path !== 'probe.mjs')) {
  process.stderr.write('unexpected dirty paths: ' + JSON.stringify(Object.keys(snapshot.paths)))
  process.exitCode = 3
}
`, 'utf8')

    sandbox = new AclSandbox({
      writableDirs: [workspace],
      tempDir: privateTemp,
      writeSid: workspaceWriteSid(workspace),
      tempWriteSid: tempWriteSid(privateTemp),
      mode: 'workspace-write',
    })

    await sandbox.init()
    const child = sandbox.spawn({
      command: process.execPath,
      args: ['--experimental-strip-types', probe],
      cwd: workspace,
    })
    const result = await child.wait()
    assert.equal(result.exitCode, 0, result.stderr.toString('utf8'))
    assert.equal(result.stdout.toString('utf8'), '')
  } finally {
    sandbox?.dispose()
    await prepared?.cleanup()
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {})
    await rm(privateTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {})
    await rm(validationDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {})
  }
})
