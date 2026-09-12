import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'
import type { RouteChoice } from '../contract/settings.ts'
import { validateRoleResult, type RoleResult } from '../contract/role-result.ts'
import { usageFromSdkEvents, type UsageSample } from '../telemetry/usage.ts'

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

export class SdkWorkspaceBackend {
  async run(req: SdkRunRequest): Promise<SdkRoleExecutionResult> {
    req.signal.throwIfAborted()
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const harness = new DeepSeekHarness(sdkHarnessOptions(req))
    const started = Date.now()
    let abortClose: (() => void) | undefined
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        void harness.close().catch(() => {})
        reject(new DOMException('SDK worker aborted', 'AbortError'))
      }
      req.signal.addEventListener('abort', onAbort, { once: true })
      abortClose = () => req.signal.removeEventListener('abort', onAbort)
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
