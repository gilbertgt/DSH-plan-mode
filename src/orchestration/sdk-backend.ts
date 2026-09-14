import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'
import type { RouteChoice } from '../contract/settings.ts'
import { validateRoleResult, type RoleResult } from '../contract/role-result.ts'
import { usageFromSdkEvents, type UsageSample } from '../telemetry/usage.ts'
import { withRoleTimeout } from '../runtime-policy.ts'

export type SdkRoleExecutionResult = RoleResult & { __usage?: UsageSample }
export interface SdkRunRequest {
  cwd: string
  profile: string
  patches?: string[]
  role?: 'worker'|'reviewer'
  taskId: string
  prompt: string
  route: RouteChoice
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
}

function extractEnvelope(text: string): unknown {
  const value = text.trim()
  if (!value.startsWith('{') || !value.endsWith('}')) throw new Error('SDK worker must return one strict JSON envelope')
  const parsed = JSON.parse(value)
  if (JSON.stringify(parsed).length > 128 * 1024) throw new Error('SDK worker JSON envelope exceeds 128KiB')
  return parsed
}

/**
 * Keep only process/runtime facts plus provider credentials likely required by
 * the selected route. This intentionally does not serialize or persist the env.
 */
export function minimalSdkEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const exact = new Set([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'HTTPS_PROXY',
    'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'DSH_HOME',
  ])
  const prefix = /^(DSH_|OPENAI_|DEEPSEEK_|ANTHROPIC_|GOOGLE_|GEMINI_|COMMANDCODE_|CODEX_|AZURE_)/i
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || prefix.test(key))) env[key] = value
  }
  return env
}

function packagedProfilePath(role: 'worker'|'reviewer'): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = basename(here) === 'lib' ? resolve(here, '..') : resolve(here, '../..')
  return join(root, 'profiles', `${role}.cordis.yml`)
}

/**
 * Whether a failure means the SDK lane itself is unusable, rather than the task
 * having gone wrong.
 *
 * An incomplete or missing DSH profile, a client module that cannot be
 * imported, and a harness that dies before reporting are environment facts this
 * run cannot repair — the documented failure being `dsh profile "sdk": JSON-RPC
 * input closed` with an `ERR_MODULE_NOT_FOUND` cause. A Worker that returns
 * BLOCKED, escapes ownership, or fails validation is a task fact and must never
 * be excused by this classification.
 */
export function sdkLaneUnavailable(error: unknown): boolean {
  const text = `${(error as any)?.code ?? ''} ${(error as any)?.message ?? error ?? ''}`
  return /ERR_MODULE_NOT_FOUND|Cannot find package ['"]@deepseek-ai\/dsh-|dsh profile .*JSON-RPC input closed|failed to import loader entry|dsh profile .* not found|dsh profile .* unavailable/i.test(text)
}

export function sdkHarnessOptions(req: SdkRunRequest) {
  const patches = req.patches ?? [packagedProfilePath(req.role ?? 'worker')]
  return {
    profile: req.profile,
    patches,
    cwd: req.cwd,
    processCwd: req.cwd,
    provider: req.route.provider,
    model: req.route.model,
    reasoningEffort: req.route.reasoningEffort as any,
    maxTokens: req.route.maxTokens,
    env: req.env ?? minimalSdkEnv(),
  }
}

/** The one operation {@link SdkWorkspaceBackend} needs from a DSH harness. */
export interface SdkHarness {
  run(prompt: string): Promise<{ finalResponse: string; events: readonly unknown[] }>
  close(): Promise<void>
}

/** Builds the harness for one run; the default is the real SDK client. */
export type SdkHarnessFactory = (options: ReturnType<typeof sdkHarnessOptions>) => Promise<SdkHarness>

let harnessFactory: SdkHarnessFactory | undefined

/**
 * Replace how the SDK lane obtains its harness.
 *
 * The default constructs the real `@deepseek-ai/dsh-sdk-client`, which needs a
 * live model provider. The production E2E lane must exercise the real isolated
 * worktree, patch capture, host validation, review and terminal report, and a
 * model provider is the one input CI cannot legitimately supply; this seam lets
 * that lane keep every other stage real instead of stubbing the whole backend.
 * Same shape as {@link configureValidationShell} and the role-timeout resolver:
 * an explicit module-level override, restorable by the returned disposer, never
 * consulted by production callers.
 */
export function configureSdkHarnessFactory(factory: SdkHarnessFactory | undefined): () => void {
  const previous = harnessFactory
  harnessFactory = factory
  return () => { harnessFactory = previous }
}

async function resolveHarness(options: ReturnType<typeof sdkHarnessOptions>): Promise<SdkHarness> {
  if (harnessFactory) return harnessFactory(options)
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
  return new DeepSeekHarness(options) as unknown as SdkHarness
}

export class SdkWorkspaceBackend {
  async run(req: SdkRunRequest): Promise<SdkRoleExecutionResult> {
    const signal = withRoleTimeout(req.cwd, req.signal)
    signal.throwIfAborted()
    const harness = await resolveHarness(sdkHarnessOptions(req))
    const started = Date.now()
    let abortClose: (() => void) | undefined
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        void harness.close().catch(() => {})
        reject(new DOMException('SDK worker aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      abortClose = () => signal.removeEventListener('abort', onAbort)
    })
    try {
      const result = await Promise.race([harness.run(req.prompt), abortPromise])
      const valid = validateRoleResult(extractEnvelope(result.finalResponse), req.taskId)
      const usage = usageFromSdkEvents('worker', result.events, req.route)
      usage.durationMs = Date.now() - started
      return { ...valid, __usage: usage }
    } finally {
      abortClose?.()
      await harness.close().catch(() => {})
    }
  }
}
