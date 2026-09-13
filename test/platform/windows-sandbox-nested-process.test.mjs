import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { needsFileBackedWindowsStdio } from '../../src/platform/captured-exec.ts'

/**
 * This test builds a nested ACL sandbox, which requires writing a DACL on the
 * nested writable root through `SetNamedSecurityInfoW`. DSH's outer sandbox
 * deliberately grants only GRANT_MASK (0x110156), which excludes WRITE_DAC and
 * WRITE_OWNER so a confined child can never rewrite a DACL to escape the
 * allowlist, and a restricted token's pass-2 check does not honour the owner's
 * implicit WRITE_DAC. A nested init() therefore fails with Win32 5 by design,
 * independently of stdio. Hosts without the sandbox (including the CI Windows
 * lane) still run this test for real.
 */
const inHostSandbox = needsFileBackedWindowsStdio()
const skip = process.platform !== 'win32'
  ? 'Windows-only host behavior'
  : inHostSandbox
    ? 'nested ACL sandbox needs WRITE_DAC, which the host sandbox GRANT_MASK deliberately excludes'
    : false

test('Windows ACL sandbox can capture a nested child through file-backed stdio', { skip }, async () => {
  const { AclSandbox, tempWriteSid, workspaceWriteSid } = await import('@deepseek-ai/dsh-sandbox-windows-acl')
  const workspace = await mkdtemp(join(tmpdir(), 'planx-acl-workspace-'))
  const privateTemp = await mkdtemp(join(tmpdir(), 'planx-acl-temp-'))
  const probe = join(workspace, 'probe.mjs')
  const helperUrl = pathToFileURL(resolve('src/platform/captured-exec.ts')).href
  await writeFile(probe, `
process.env.PLANX_SANDBOX_VALIDATION = '1'
process.env.TMP = ${JSON.stringify(privateTemp)}
process.env.TEMP = ${JSON.stringify(privateTemp)}
const { execFileCaptured } = await import(${JSON.stringify(helperUrl)})
const result = await execFileCaptured(process.execPath, ['-e', 'process.stdout.write("nested-ok")'])
if (result.stdout.toString('utf8') !== 'nested-ok') {
  process.stderr.write('unexpected nested stdout: ' + result.stdout.toString('utf8'))
  process.exitCode = 2
}
`, 'utf8')

  const sandbox = new AclSandbox({
    writableDirs: [workspace],
    tempDir: privateTemp,
    writeSid: workspaceWriteSid(workspace),
    tempWriteSid: tempWriteSid(privateTemp),
    mode: 'workspace-write',
  })

  let initialized = false
  try {
    await sandbox.init()
    initialized = true
    const child = sandbox.spawn({
      command: process.execPath,
      args: ['--experimental-strip-types', probe],
      cwd: workspace,
    })
    const result = await child.wait()
    assert.equal(result.exitCode, 0, result.stderr.toString('utf8'))
    assert.equal(result.stdout.toString('utf8'), '')
  } finally {
    if (initialized) sandbox.dispose()
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {})
    await rm(privateTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {})
  }
})
