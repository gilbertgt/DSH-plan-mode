import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileCaptured, needsFileBackedWindowsStdio } from '../../src/platform/captured-exec.ts'
import { prepareValidationSubprocessEnvironment } from '../../src/validation/runner.ts'

/**
 * This test builds a nested ACL sandbox, which requires writing a DACL on the
 * nested writable root through `SetNamedSecurityInfoW`. DSH's outer sandbox
 * deliberately grants only GRANT_MASK (0x110156), which excludes WRITE_DAC and
 * WRITE_OWNER so a confined child can never rewrite a DACL to escape the
 * allowlist, and a restricted token's pass-2 check does not honour the owner's
 * implicit WRITE_DAC. A nested init() therefore fails with Win32 5 by design.
 * Hosts without the sandbox (including the CI Windows lane) still run this test
 * for real, which is what keeps the Git trust regression covered.
 */
const inHostSandbox = needsFileBackedWindowsStdio()
const skip = process.platform !== 'win32'
  ? 'Windows-only platform requirement'
  : inHostSandbox
    ? 'nested ACL sandbox needs WRITE_DAC, which the host sandbox GRANT_MASK deliberately excludes'
    : false

test('Windows ACL sandbox can snapshot the exact Host-trusted validation worktree with Git', { skip }, async () => {
  const { AclSandbox, tempWriteSid, workspaceWriteSid } = await import('@deepseek-ai/dsh-sandbox-windows-acl')
  const workspace = await mkdtemp(join(tmpdir(), 'planx-acl-git-workspace-'))
  const privateTemp = await mkdtemp(join(tmpdir(), 'planx-acl-git-temp-'))
  const validationDir = await mkdtemp(join(tmpdir(), 'planx-acl-git-config-'))
  let prepared
  let sandbox

  try {
    // Git calls go through the file-backed seam: `windowsHide: true` is not
    // compatible with DSH's restricted token (CREATE_NO_WINDOW risks
    // STATUS_DLL_INIT_FAILED) and piped stdio is unavailable to a confined
    // grandchild. These assertions also hold on a plain Windows host.
    await execFileCaptured('git', ['init'], { cwd: workspace })
    await writeFile(join(workspace, 'tracked.txt'), 'baseline\n', 'utf8')
    await execFileCaptured('git', ['add', 'tracked.txt'], { cwd: workspace })
    await execFileCaptured('git', [
      '-c', 'user.name=Plan Orchestrator Test',
      '-c', 'user.email=plan-orchestrator@example.invalid',
      'commit', '-m', 'baseline',
    ], { cwd: workspace })

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
