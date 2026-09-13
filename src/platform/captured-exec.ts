import { execFile, spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface CapturedExecOptions {
  cwd?: string
  maxBuffer?: number
  timeoutMs?: number
}

export interface CapturedExecResult {
  stdout: Buffer
  stderr: Buffer
}

export function needsFileBackedWindowsStdio(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === 'win32' && env.PLANX_SANDBOX_VALIDATION === '1'
}

function commandFailure(
  command: string,
  args: readonly string[],
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: Buffer,
  stderr: Buffer,
): Error {
  const error = new Error(`Command failed: ${[command, ...args].join(' ')}${stderr.length ? `\n${stderr.toString('utf8')}` : ''}`)
  Object.assign(error, { code, signal, stdout, stderr })
  return error
}

/**
 * Capture a subprocess without libuv pipe stdio when running inside DSH's
 * Windows WRITE_RESTRICTED sandbox. That backend intentionally cannot grant
 * arbitrary named-pipe client handles to confined grandchildren, so ordinary
 * execFile()/spawn({stdio:'pipe'}) fails with EPERM. Regular file handles in
 * the sandbox-private TEMP directory preserve exact stdout/stderr capture
 * without widening the file sandbox or falling back to unconfined execution.
 */
export async function execFileCaptured(
  command: string,
  args: readonly string[] = [],
  options: CapturedExecOptions = {},
): Promise<CapturedExecResult> {
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024
  if (!needsFileBackedWindowsStdio()) {
    const result = await execFileP(command, [...args], {
      cwd: options.cwd,
      encoding: 'buffer',
      maxBuffer,
      windowsHide: true,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    })
    return { stdout: result.stdout as Buffer, stderr: result.stderr as Buffer }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'planx-exec-'))
  const stdoutPath = join(scratch, 'stdout.bin')
  const stderrPath = join(scratch, 'stderr.bin')
  let stdoutFile: Awaited<ReturnType<typeof open>> | undefined
  let stderrFile: Awaited<ReturnType<typeof open>> | undefined
  try {
    stdoutFile = await open(stdoutPath, 'w')
    stderrFile = await open(stderrPath, 'w')
    let timedOut = false
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
      // CREATE_NO_WINDOW is not compatible with DSH's restricted token.
      windowsHide: false,
    })
    const settled = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill()
          }, options.timeoutMs)
      child.once('error', error => {
        if (timer) clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (timer) clearTimeout(timer)
        resolve({ code, signal })
      })
    })
    await stdoutFile.close(); stdoutFile = undefined
    await stderrFile.close(); stderrFile = undefined
    const [stdout, stderr] = await Promise.all([readFile(stdoutPath), readFile(stderrPath)])
    if (stdout.length > maxBuffer || stderr.length > maxBuffer) {
      const error = new Error(`subprocess output exceeded maxBuffer (${maxBuffer} bytes)`)
      Object.assign(error, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout, stderr })
      throw error
    }
    if (timedOut) {
      const error = new Error(`subprocess timed out after ${options.timeoutMs}ms`)
      Object.assign(error, { code: 'ETIMEDOUT', killed: true, stdout, stderr })
      throw error
    }
    if (settled.code !== 0) throw commandFailure(command, args, settled.code, settled.signal, stdout, stderr)
    return { stdout, stderr }
  } finally {
    await stdoutFile?.close().catch(() => {})
    await stderrFile?.close().catch(() => {})
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {})
  }
}
