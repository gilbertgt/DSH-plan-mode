import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseValidationCommand, type ParsedValidationCommand } from '../contract/plan-artifact.ts'

export type ValidationPackageManager = ParsedValidationCommand['manager']

/** Whether one exact executable name is resolvable on the host PATH. */
export type LauncherProbe = (executable: string) => boolean

export interface LauncherOptions {
  /** Platform to resolve for; defaults to the running process platform. */
  platform?: NodeJS.Platform
  /** Environment whose PATH is probed on Windows; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
  /**
   * Injectable candidate probe, so launcher selection is a pure function of its
   * inputs in tests. The default mirrors the DSH pwsh executor's own resolution:
   * PATH entries scanned in order, each candidate opened with `lstat` so an App
   * Execution Alias reparse point counts while a directory never does.
   */
  probe?: LauncherProbe
  /** Node executable whose sibling npm CLI may serve as the npm launcher; defaults to `process.execPath`. */
  nodeExecPath?: string
  /** Injectable exact-path existence check for the npm CLI launcher; defaults to `lstat`. */
  exists?: (candidate: string) => boolean
}

/**
 * Windows launcher for each package-script manager, most authoritative first.
 *
 * PowerShell resolves a bare command name as `Alias` > `Function` > `Cmdlet` >
 * `ExternalScript` (`.ps1`) > `Application` (`.exe`/`.cmd`), so an unsuffixed
 * `npm` finds `npm.ps1` before `npm.cmd` even though the `cmd` shim sits in the
 * same directory. A host whose Execution Policy forbids script files then fails
 * with `PSSecurityException` before npm ever starts. Naming the executable form
 * explicitly removes PowerShell's script-file branch from the resolution.
 *
 * `npm`/`yarn` ship exactly one Windows executable form. `pnpm` also publishes
 * a native `pnpm.exe` in its installed package (`pnpm@12` declares `"pnpm":
 * "pnpm.exe"` and ships `pnpm.exe` beside the `.cmd`/`.ps1` shims), and `bun`
 * is a bare `bun.exe` from the official Windows installer but a `bun.cmd` shim
 * when installed through npm, so those two carry a probed fallback.
 *
 * These `.cmd` entries are only npm's fallback now, and remain the primary form
 * for the other managers. `npm.cmd` locates its own CLI through
 * `FOR /F ... IN ('CALL "<node>" "<npm-prefix.js>"')`; that nested command
 * interpreter invocation is not reliably available to a confined grandchild
 * under DSH's Windows WRITE_RESTRICTED token, so the shim dies with
 * `'CALL "..." "..."' is not recognized as an internal or external command`
 * before npm ever starts. Invoking the documented `node <npm-cli.js>` form
 * directly removes that nested-shell dependency entirely.
 */
const WINDOWS_LAUNCHERS: Record<ValidationPackageManager, readonly string[]> = {
  npm: ['npm.cmd'],
  pnpm: ['pnpm.cmd', 'pnpm.exe'],
  yarn: ['yarn.cmd'],
  bun: ['bun.exe', 'bun.cmd'],
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  // Windows environment variable names are case-insensitive and arrive as
  // `PATH`, `Path`, or `path` depending on the parent process, so the lookup
  // cannot rely on one spelling. An empty value never shadows a populated one.
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH' && String(env[name] ?? '').length > 0)
  return (key ? String(env[key]) : '')
    .split(';')
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(entry => entry.length > 0)
}

function existsOnPath(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

function onPathProbe(env: NodeJS.ProcessEnv): LauncherProbe {
  const directories = pathDirectories(env)
  return executable => directories.some(directory => existsOnPath(join(directory, executable)))
}

/** The npm CLI entry point shipped beside a Node installation's executable. */
export function npmCliScript(nodeExecPath: string): string {
  return join(dirname(nodeExecPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/**
 * Quote one argument for a PowerShell command line.
 *
 * The launcher prefix is embedded in the `-Command` payload of the configured
 * shell (pwsh on Windows), so a path containing spaces must be double-quoted
 * and its embedded quotes doubled. Every value reaching this function is a host
 * filesystem path or a fixed literal, never model-supplied text.
 */
function powerShellQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * The PowerShell-form launcher for the npm CLI, or `undefined` when this host
 * does not expose a usable Node-installed npm CLI.
 *
 * `&` is required because PowerShell parses a leading double-quoted string as
 * an expression rather than as a command name. Only the manager token at the
 * head of the command is replaced, so the conservative package-script grammar
 * the parser already accepted after it is passed through untouched.
 */
function windowsNpmCliLauncher(options: LauncherOptions): string | undefined {
  const nodeExecPath = options.nodeExecPath ?? process.execPath
  if (!nodeExecPath) return undefined
  const script = npmCliScript(nodeExecPath)
  const exists = options.exists ?? existsOnPath
  // Both halves must exist, otherwise the `.cmd` shim stays authoritative: a
  // half-present Node installation must not become a fabricated launcher.
  if (!exists(nodeExecPath) || !exists(script)) return undefined
  return `& ${powerShellQuote(nodeExecPath)} ${powerShellQuote(script)}`
}

/**
 * The executable launcher for one package-script manager on one platform.
 *
 * Non-Windows platforms keep the unsuffixed manager name: those hosts resolve
 * the launcher themselves and a `.cmd` suffix would simply not exist.
 *
 * @param manager - the parsed package-script manager.
 * @param options - platform, environment, probe, and Node-path overrides.
 * @returns the launcher to place at the head of the shell command.
 */
export function packageManagerLauncher(manager: ValidationPackageManager, options: LauncherOptions = {}): string {
  if ((options.platform ?? process.platform) !== 'win32') return manager
  // npm prefers the explicit CLI invocation: it never enters a `.cmd` shim, so
  // the confined-grandchild nested-shell failure cannot occur before npm runs.
  if (manager === 'npm') {
    const direct = windowsNpmCliLauncher(options)
    if (direct !== undefined) return direct
  }
  const candidates = WINDOWS_LAUNCHERS[manager]
  const probe = options.probe ?? onPathProbe(options.env ?? process.env)
  for (const candidate of candidates) if (probe(candidate)) return candidate
  // Nothing probed: keep the primary documented form so the shell reports an
  // ordinary command-not-found instead of this layer inventing a launcher.
  return candidates[0]!
}

export interface ValidationExecutable {
  /** The structured semantics `parseValidationCommand` accepted. */
  parsed: ParsedValidationCommand
  /** The Planner's logical command, unchanged. */
  command: string
  /** The platform-specific command handed to the sandboxed DSH shell. */
  executableCommand: string
}

/**
 * Swap the command's leading executable token for the platform launcher.
 *
 * `parseValidationCommand` has already proved every token matches the
 * conservative package-script grammar, so the remainder carries no shell
 * metacharacter, no redirection, and no quoting, and is passed through
 * byte-for-byte. Only the head token — the one the parse identified as the
 * manager — is replaced; nothing else in the string is scanned or rewritten.
 */
function replaceLauncherToken(command: string, launcher: string): string {
  const trimmed = command.trim()
  const boundary = trimmed.search(/\s/)
  return boundary === -1 ? launcher : `${launcher}${trimmed.slice(boundary)}`
}

/**
 * Resolve one accepted validation command into its executable form.
 *
 * The Planner keeps emitting portable package-script commands (`npm test`,
 * `npm run typecheck`); the platform decision lives here, in trusted runtime
 * code, never in the PlanArtifact or the Planner. Parsing happens first and
 * unchanged, so an unsafe command still fails closed before any launcher exists.
 *
 * @param command - the Planner's logical validation command.
 * @param options - platform, environment, probe, and Node-path overrides.
 * @returns the parsed semantics, the logical command, and the shell command.
 */
export function resolveValidationExecutable(command: string, options: LauncherOptions = {}): ValidationExecutable {
  const parsed = parseValidationCommand(command)
  const launcher = packageManagerLauncher(parsed.manager, options)
  return { parsed, command, executableCommand: replaceLauncherToken(command, launcher) }
}
