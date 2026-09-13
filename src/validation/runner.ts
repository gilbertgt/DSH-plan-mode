import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ParsedValidationCommand } from '../contract/plan-artifact.ts'
import { snapshotDirty, snapshotHash } from '../git/fingerprints.ts'
import { fullHead } from '../git/repository.ts'
import { materializeValidationDependencies } from './dependencies.ts'
import { resolveValidationExecutable, type LauncherOptions } from './launcher.ts'
import { hashBytes, type ValidationDiagnostic, type ValidationReceipt, type ValidationSandboxFacts } from './receipts.ts'

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

function gitConfigQuotedPath(value: string): string {
  // Git config accepts forward-slash Windows paths. Quoting keeps whitespace,
  // '#' and ';' literal without depending on shell escaping rules.
  return `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`
}

export interface PreparedValidationEnvironment {
  env: Record<string, string>
  cleanup: () => Promise<void>
  gitConfigPath?: string
}

/**
 * Prepare environment inherited by an authoritative validation subprocess.
 *
 * Git ownership is evaluated as the restricted Windows token, not as the Host
 * user that created the detached validation worktree. Older Git releases only
 * honor safe.directory from protected system/global config, so do not rely on
 * `git -c safe.directory=...`. Instead point this subprocess at a short-lived,
 * isolated global config containing exactly the canonical validation worktree.
 * The user's real global Git config is never mutated and no wildcard is used.
 */
export async function prepareValidationSubprocessEnvironment(
  cwd: string,
  validationDir: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PreparedValidationEnvironment> {
  const env: Record<string, string> = { PLANX_SANDBOX_VALIDATION: '1' }
  if (platform !== 'win32') return { env, cleanup: async () => {} }

  const canonicalCwd = await realpath(cwd)
  const configDir = await mkdtemp(join(validationDir, `${prefix}-git-`))
  const gitConfigPath = join(configDir, 'config')
  await writeFile(
    gitConfigPath,
    `[safe]\n\tdirectory = ${gitConfigQuotedPath(canonicalCwd)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  return {
    env: { ...env, GIT_CONFIG_GLOBAL: gitConfigPath },
    gitConfigPath,
    cleanup: async () => { await rm(configDir, { recursive: true, force: true }).catch(() => {}) },
  }
}

async function assertExistingPackageScript(cwd: string, parsed: ParsedValidationCommand): Promise<void> {
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
  /** Platform/environment/probe overrides for launcher resolution; a test seam only. */
  launcher?: LauncherOptions
  /** Override dependency materialization. Configured host validation enables it; injected-shell tests disable it by default. */
  provisionDependencies?: boolean
}

function sandboxFacts(value: any): ValidationSandboxFacts | undefined {
  if (!value || typeof value !== 'object') return undefined
  return {
    ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
    denied: Boolean(value.denied),
    ...(typeof value.enforcement === 'string' ? { enforcement: value.enforcement } : {}),
    ...(typeof value.runnerFailed === 'boolean' ? { runnerFailed: value.runnerFailed } : {}),
  }
}

function sandboxEnforcementAccepted(sandbox: ValidationSandboxFacts | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!sandbox || sandbox.runnerFailed === true) return false
  if (sandbox.enforcement === 'full') return true
  return platform === 'win32' && sandbox.enforcement === 'partial'
}

/**
 * DSH's Windows WRITE_RESTRICTED backend documents that confined
 * grandchildren using libuv piped stdio can fail with EPERM. That is a
 * validation-infrastructure failure, not evidence that a test assertion
 * failed. Keep it fail-closed and machine-readable so callers never mistake it
 * for a genuine FAIL or silently retry unconfined.
 */
export function validationInfrastructureDiagnostic(
  platform: NodeJS.Platform,
  sandbox: ValidationSandboxFacts | undefined,
  exitCode: number | null,
  stdout: Buffer | string,
  stderr: Buffer | string,
): ValidationDiagnostic | undefined {
  if (platform !== 'win32' || sandbox?.enforcement !== 'partial' || exitCode === 0) return undefined
  const text = `${String(stdout)}\n${String(stderr)}`
  if (/\bspawn\s+EPERM\b/i.test(text) && /\bsyscall:\s*['"]spawn['"]/i.test(text)) {
    return 'WINDOWS_SANDBOX_NESTED_PIPE_EPERM'
  }
  return undefined
}

export async function runValidation(opts: RunValidationOptions): Promise<ValidationReceipt> {
  const shell = opts.shell ?? configuredShell
  if (!shell?.resolve || !shell?.run) throw new Error('sandboxed DSH shell executor unavailable for host validation')
  // Parsing happens inside the resolver before shell.resolve: unsafe commands
  // fail closed before launcher probing or executable shell resolution.
  const { parsed, executableCommand } = resolveValidationExecutable(opts.command, opts.launcher)
  await assertExistingPackageScript(opts.cwd, parsed)

  // Production host validation uses the configured DSH shell and always runs in
  // a fresh detached worktree. Materialize a private dependency snapshot before
  // taking the mutation baseline. Tests that inject a shell keep their existing
  // lightweight fixture behavior unless they explicitly request provisioning.
  const provisionDependencies = opts.provisionDependencies ?? opts.shell === undefined
  if (provisionDependencies) {
    await materializeValidationDependencies({ cwd: opts.cwd, runDir: opts.runDir, manager: parsed.manager })
  }

  const before = await snapshotDirty(opts.cwd)
  const head = await fullHead(opts.cwd)
  const start = new Date().toISOString()
  const sandboxPolicy = {
    mode: 'workspace-write' as const,
    workspaceRoot: opts.cwd,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  }
  const validationDir = join(opts.runDir, 'validation')
  await mkdir(validationDir, { recursive: true })
  const prefix = `${safe(opts.phase)}-${safe(opts.runId)}-${safe(opts.commandId)}`
  const preparedEnvironment = await prepareValidationSubprocessEnvironment(opts.cwd, validationDir, prefix)
  const spec = shell.resolve({
    command: executableCommand,
    workdir: opts.cwd,
    timeoutMs: opts.timeoutMs,
    stdoutMaxBytes: opts.capBytes,
    // DSH_* variables are stripped by the subprocess seam. The marker selects
    // file-backed nested stdio; GIT_CONFIG_GLOBAL scopes exact safe.directory
    // trust to this validation subprocess without modifying ~/.gitconfig.
    env: preparedEnvironment.env,
    sandboxPolicy,
  })
  let result: any
  try {
    result = await shell.run(spec)
  } finally {
    await preparedEnvironment.cleanup()
  }
  const stdout = Buffer.from(String(result?.stdout?.text ?? ''), 'utf8')
  const stderr = Buffer.from(String(result?.stderr?.text ?? ''), 'utf8')
  const stdoutTruncated = Boolean(result?.stdout?.truncated)
  const stderrTruncated = Boolean(result?.stderr?.truncated)
  const timedOut = Boolean(result?.timedOut)
  const aborted = Boolean(result?.aborted)
  const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : null
  const sandbox = sandboxFacts(result?.sandbox)
  const sandboxIncomplete = !sandboxEnforcementAccepted(sandbox)
  const sandboxDenied = Boolean(sandbox?.denied)
  const diagnostic = validationInfrastructureDiagnostic(process.platform, sandbox, exitCode, stdout, stderr)

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
    : sandboxIncomplete || diagnostic !== undefined || stdoutTruncated || stderrTruncated || timedOut || aborted
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
    ...(diagnostic ? { diagnostic } : {}),
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
    ...(sandbox ? { sandbox } : {}),
    boundHead: head,
    ownershipFingerprint: opts.ownershipFingerprint ?? snapshotHash(after),
    complete: !sandboxIncomplete && !sandboxDenied && diagnostic === undefined && !timedOut && !aborted && !stdoutTruncated && !stderrTruncated,
  }
}
