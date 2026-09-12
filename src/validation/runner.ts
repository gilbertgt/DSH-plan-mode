import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { snapshotDirty, snapshotHash } from '../git/fingerprints.ts'
import { fullHead } from '../git/repository.ts'
import { hashBytes, type ValidationReceipt } from './receipts.ts'

const execFileP = promisify(execFile)

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160)
}

async function terminateTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await execFileP('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 1_000))
  if (child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
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
}

export async function runValidation(opts: RunValidationOptions): Promise<ValidationReceipt> {
  const before = await snapshotDirty(opts.cwd)
  const head = await fullHead(opts.cwd)
  const start = new Date().toISOString()
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutTruncated = false
  let stderrTruncated = false
  let timedOut = false

  const child = spawn(opts.command, {
    cwd: opts.cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  const collect = (chunks: Buffer[], kind: 'stdout' | 'stderr') => (data: Buffer): void => {
    const used = kind === 'stdout' ? stdoutBytes : stderrBytes
    if (used >= opts.capBytes) {
      if (kind === 'stdout') stdoutTruncated = true
      else stderrTruncated = true
      return
    }
    const take = data.subarray(0, Math.max(0, opts.capBytes - used))
    chunks.push(take)
    if (take.length < data.length) {
      if (kind === 'stdout') stdoutTruncated = true
      else stderrTruncated = true
    }
    if (kind === 'stdout') stdoutBytes += take.length
    else stderrBytes += take.length
  }

  child.stdout.on('data', collect(stdoutChunks, 'stdout'))
  child.stderr.on('data', collect(stderrChunks, 'stderr'))

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<number | null>(resolve => {
    timer = setTimeout(() => {
      timedOut = true
      void terminateTree(child).finally(() => resolve(null))
    }, opts.timeoutMs)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })

  const exitCode = await Promise.race([exited, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  if (timedOut) await exited.catch(() => null)

  const stdout = Buffer.concat(stdoutChunks)
  const stderr = Buffer.concat(stderrChunks)
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
  const status = stdoutTruncated || stderrTruncated || timedOut
    ? 'INCONCLUSIVE'
    : mutated
      ? 'UNSAFE_MUTATION'
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
    exitCode,
    status,
    stdout: { path: stdoutPath, sha256: hashBytes(stdout), bytes: stdout.length, truncated: stdoutTruncated },
    stderr: { path: stderrPath, sha256: hashBytes(stderr), bytes: stderr.length, truncated: stderrTruncated },
    boundHead: head,
    ownershipFingerprint: opts.ownershipFingerprint ?? snapshotHash(after),
    complete: !timedOut && !stdoutTruncated && !stderrTruncated,
  }
}
