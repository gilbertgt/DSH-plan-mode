import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseValidationCommand } from '../contract/plan-artifact.ts'
import { snapshotDirty, snapshotHash } from '../git/fingerprints.ts'
import { fullHead } from '../git/repository.ts'
import { hashBytes, type ValidationReceipt } from './receipts.ts'

let configuredShell: any

/** Bind validation to the current DSH shell seam. There is deliberately no
 * child_process fallback: missing sandboxed shell execution is release-blocking. */
export function configureValidationShell(shell: any): () => void {
  const previous = configuredShell
  configuredShell = shell
  return () => { if (configuredShell === shell) configuredShell = previous }
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160)
}

async function assertExistingPackageScript(cwd: string, command: string): Promise<void> {
  const parsed = parseValidationCommand(command)
  let pkg: any
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) }
  catch (error) { throw new Error(`validation requires readable package.json: ${(error as Error).message}`) }
  if (!pkg?.scripts || typeof pkg.scripts[parsed.script] !== 'string' || !pkg.scripts[parsed.script].trim()) {
    throw new Error(`validation package script does not exist: ${parsed.script}`)
  }
}

export interface RunValidationOptions {
  cwd: string
  runDir: string
  runId: string
  phase: string
  commandId: string
  command: string
  timeoutMs: number
  capBytes: number
  ownershipFingerprint?: string
  shell?: any
  sessionId?: string
}

export async function runValidation(opts: RunValidationOptions): Promise<ValidationReceipt> {
  const shell = opts.shell ?? configuredShell
  if (!shell?.resolve || !shell?.run) throw new Error('sandboxed DSH shell executor unavailable for host validation')
  await assertExistingPackageScript(opts.cwd, opts.command)

  const before = await snapshotDirty(opts.cwd)
  const head = await fullHead(opts.cwd)
  const start = new Date().toISOString()
  const sandboxPolicy = {
    mode: 'workspace-write' as const,
    workspaceRoot: opts.cwd,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  }
  const spec = shell.resolve({
    command: opts.command,
    workdir: opts.cwd,
    timeoutMs: opts.timeoutMs,
    stdoutMaxBytes: opts.capBytes,
    sandboxPolicy,
  })
  const result = await shell.run(spec)
  const stdout = Buffer.from(String(result?.stdout?.text ?? ''), 'utf8')
  const stderr = Buffer.from(String(result?.stderr?.text ?? ''), 'utf8')
  const stdoutTruncated = Boolean(result?.stdout?.truncated)
  const stderrTruncated = Boolean(result?.stderr?.truncated)
  const timedOut = Boolean(result?.timedOut)
  const aborted = Boolean(result?.aborted)
  const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : null
  const sandbox = result?.sandbox
  const sandboxIncomplete = !sandbox || sandbox.runnerFailed === true || sandbox.enforcement !== 'full'
  const sandboxDenied = Boolean(sandbox?.denied)

  const validationDir = join(opts.runDir, 'validation')
  await mkdir(validationDir, { recursive: true })
  const prefix = `${safe(opts.phase)}-${safe(opts.runId)}-${safe(opts.commandId)}`
  const stdoutPath = join(validationDir, `${prefix}.stdout.log`)
  const stderrPath = join(validationDir, `${prefix}.stderr.log`)
  await Promise.all([
    writeFile(stdoutPath, stdout),
    writeFile(stderrPath, stderr),
  ])

  const after = await snapshotDirty(opts.cwd)
  const mutated = snapshotHash(before) !== snapshotHash(after)
  const status = sandboxDenied || mutated
    ? 'UNSAFE_MUTATION'
    : sandboxIncomplete || stdoutTruncated || stderrTruncated || timedOut || aborted
      ? 'INCONCLUSIVE'
      : exitCode === 0
        ? 'PASS'
        : 'FAIL'

  return {
    schemaVersion: 1,
    runId: opts.runId,
    phase: opts.phase,
    commandId: opts.commandId,
    command: opts.command,
    start,
    end: new Date().toISOString(),
    timeoutMs: opts.timeoutMs,
    exitCode: timedOut || aborted ? null : exitCode,
    status,
    stdout: {
      path: stdoutPath,
      sha256: hashBytes(stdout),
      bytes: stdout.length,
      truncated: stdoutTruncated,
    },
    stderr: {
      path: stderrPath,
      sha256: hashBytes(stderr),
      bytes: stderr.length,
      truncated: stderrTruncated,
    },
    boundHead: head,
    ownershipFingerprint: opts.ownershipFingerprint ?? snapshotHash(after),
    complete: !sandboxIncomplete && !sandboxDenied && !timedOut && !aborted && !stdoutTruncated && !stderrTruncated,
  }
}
