import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings-service.ts'
import { NativePlanBridge, consumeApprovedPlanResult, installExitPlanValidator } from './planning/native-plan-bridge.ts'
import { plannerPolicyText } from './planning/policy.ts'
import { PlannerReadOnlyGuard } from './planning/read-only-guard.ts'
import { installPlannerRoute, validateFixedRoute } from './planning/planner-route.ts'
import { OrchestrationService } from './orchestration/service.ts'
import { installEnabledParentFence } from './orchestration/enabled-parent-fence.ts'
import { createOrchestratorRunner } from './orchestration/engine.ts'
import { planOrchestratorProjectionDefinition } from './orchestration/projection.ts'
import { RunStore } from './recovery/store.ts'
import { installIssueCommand } from './external/issue-command.ts'
import { ghPreflight } from './external/github.ts'
import { repoRoot } from './git/repository.ts'
import { execFileCaptured } from './platform/captured-exec.ts'
import { configureValidationShell } from './validation/runner.ts'
import { configureRoleTimeoutResolver } from './runtime-policy.ts'
import type { RoleRoute } from './contract/settings.ts'

export const name = 'plan-orchestrator'
export const inject = ['settings', 'tools', 'llm', 'sessions', 'subagents', 'systemPrompt', 'sandboxPolicy', 'sessionProjections', 'shell']

const require = createRequire(import.meta.url)

function packageVersion(id: string): string | undefined {
  try { return require(`${id}/package.json`).version }
  catch { return undefined }
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try { await execFileCaptured(command, args, { timeoutMs: 5_000, maxBuffer: 1024 * 1024 }); return true }
  catch { return false }
}

function hasService(ctx: any, name: string): boolean {
  try { return ctx.get?.(name) !== undefined }
  catch { return false }
}

/** The exact DSH release this runtime resolved for the core packages it uses. */
const CORE_DSH_PACKAGES = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-tools'] as const

/**
 * Report a runtime the plugin was never verified against.
 *
 * The live Web profile that failed run 4429470e ran rc.2 host packages beside an
 * rc.1 SDK client, and nothing in the plugin noticed: the failure surfaced much
 * later as an opaque worker error. The mismatch is logged loudly at mount and
 * exposed through `diagnostics` so the situation is visible before a run starts,
 * without refusing to load a composition a user may still want to drive.
 */
function dshRuntimeReport(): { versions: string[]; supported: boolean; detail: string } {
  const versions = [...new Set(CORE_DSH_PACKAGES.map(id => packageVersion(id)).filter((value): value is string => Boolean(value)))]
  const compatibility = compatibilityManifest()
  const unsupported = versions.filter(version => !compatibility.supported.includes(version) && !compatibility.preview.includes(version))
  return {
    versions,
    supported: versions.length > 0 && unsupported.length === 0,
    detail: versions.length === 0
      ? 'no DSH core package version could be resolved'
      : unsupported.length > 0
        ? `unsupported DSH runtime: ${unsupported.join(', ')} (declared supported: ${compatibility.supported.join(', ') || 'none'})`
        : `DSH ${versions.join(', ')}`,
  }
}

function compatibilityManifest(): { supported: string[]; preview: string[] } {
  try {
    const value = require('@gilbertgt/dsh-plan-orchestrator/compatibility.json') as { supported?: unknown; preview?: unknown }
    return {
      supported: Array.isArray(value.supported) ? value.supported.filter((item): item is string => typeof item === 'string') : [],
      preview: Array.isArray(value.preview) ? value.preview.filter((item): item is string => typeof item === 'string') : [],
    }
  } catch {
    // A published tarball always ships the manifest next to the entry point; a
    // source checkout resolves it through the package name above. Failing to
    // read it must not invent a supported version.
    return { supported: [], preview: [] }
  }
}

export function apply(ctx: Context) {
  const c = ctx as any
  const settings = registerSettings(c)
  const bridge = new NativePlanBridge()
  const readOnly = new PlannerReadOnlyGuard()
  const store = new RunStore()
  c.sessionProjections.register(planOrchestratorProjectionDefinition)

  const runtime = dshRuntimeReport()
  if (!runtime.supported) c.logger?.error?.('plan-orchestrator: %s', runtime.detail)

  let orchestration: OrchestrationService
  orchestration = new OrchestrationService(store, createOrchestratorRunner({
    ctx: c,
    settings: (cwd?: string) => settings.effective(cwd),
    store,
    emit: (kind, data) => orchestration?.recordEvent(kind, data),
  }))

  const isPlanActive = (agent: any): boolean => {
    try { return Boolean(c.sessionProjections.stateOf(agent.session, 'plan')?.active) }
    catch { return false }
  }
  const isEnabled = (agent: any): boolean => Boolean(agent && settings.effective(agent.session?.header?.cwd).enabled)
  const firstPolicySeen = new WeakSet<object>()

  c.effect(() => configureValidationShell(c.shell), 'plan-orchestrator: sandbox validation runtime')
  c.effect(() => configureRoleTimeoutResolver((cwd?: string) => settings.effective(cwd).execution.roleTimeoutMs), 'plan-orchestrator: role timeout runtime')

  c.systemPrompt.section({
    name: 'plan-orchestrator:policy',
    order: (c.systemPrompt.getSectionOrder?.('PLAN_POLICY') ?? 500) + 1,
    text: ({ agent }: any) => {
      if (!agent) return ''
      const effective = settings.effective(agent.session.header?.cwd)
      const session = agent.session as object
      if (!effective.enabled) {
        firstPolicySeen.delete(session)
        return ''
      }
      const active = isPlanActive(agent)
      const first = !firstPolicySeen.has(session)
      const text = plannerPolicyText(true, active, first, effective.planning)
      if (text && first) firstPolicySeen.add(session)
      return text
    },
  })

  c.effect(() => installExitPlanValidator(c, bridge, () => settings.get().execution.requireExplicitOwnership, isEnabled), 'plan-orchestrator: validate native plan')
  c.effect(() => readOnly.install(c, isEnabled), 'plan-orchestrator: strict read-only tool guard')
  c.effect(() => installPlannerRoute(c, (agent: any) => settings.effective(agent.session.header?.cwd).roles.planner, isPlanActive, isEnabled), 'plan-orchestrator: planner route')
  c.effect(() => installEnabledParentFence(c, orchestration, isEnabled), 'plan-orchestrator: parent fence')

  c.on('agent/pre-step', async ({ agent }: any, next: any) => {
    const decision = await next()
    const effective = settings.effective(agent.session.header?.cwd)
    if (!effective.enabled) {
      bridge.clearSession(String(agent.session.id))
      readOnly.deactivate(agent.session, c.sandboxPolicy)
      return decision
    }
    if (decision.kind !== 'reject' && effective.planning.strictReadOnly && isPlanActive(agent)) {
      readOnly.activate(agent.session, c.sandboxPolicy)
    } else if (!isPlanActive(agent)) {
      readOnly.deactivate(agent.session, c.sandboxPolicy)
    }
    return decision
  }, { prepend: true })

  c.on('tools/result', (exec: any, result: any) => {
    const staged = consumeApprovedPlanResult(bridge, exec, result, isEnabled)
    if (!staged) return
    const sessionId = String(exec.agent?.session?.id ?? '')
    orchestration.approve({
      sessionId,
      agent: exec.agent,
      artifact: staged.artifact,
      planHash: staged.hash,
      baselineHead: staged.baselineHead,
    })
  })

  c.on('session/event', (session: any, event: any) => {
    if (event.type !== 'plan/mode') return
    firstPolicySeen.delete(session)
    const enabled = settings.effective(session.header?.cwd).enabled
    if (!enabled) {
      bridge.clearSession(String(session.id))
      readOnly.deactivate(session, c.sandboxPolicy)
      return
    }
    if (!event.data.active) {
      bridge.clearSession(String(session.id))
      readOnly.deactivate(session, c.sandboxPolicy)
    }
  })

  c.on('agent/session-start', ({ agent }: any) => {
    if (!isEnabled(agent)) return
    void orchestration.reconcileSession(agent).catch((error: any) => c.logger?.warn?.('plan-orchestrator recovery reconcile failed: %o', error))
  })

  c.inject(['commands'], (scope: any) => scope.effect(() => installIssueCommand(scope, {
    settings: (cwd?: string) => settings.effective(cwd),
    orchestration,
  }), 'plan-orchestrator: external issue command'))

  c.inject(['connection'], (scope: any) => scope.effect(() => {
    let disposed = false
    let disposeTransport: (() => void) | undefined
    void import('./rpc-server.ts').then(({ registerRpc }) => {
      if (disposed) return
      disposeTransport = registerRpc(scope.connection, {
        ctx: scope,
        isEnabled: () => settings.get().enabled,
        canResume: () => settings.get().recovery.allowSafeResume,
        runList: ({ sessionId }: any) => orchestration.list(sessionId),
        runDetail: ({ runId }: any) => orchestration.detail(runId),
        runCancel: ({ runId }: any) => orchestration.cancel(runId),
        runResume: ({ runId }: any) => orchestration.resume(runId),
        runCleanup: ({ runId }: any) => orchestration.cleanup(runId),
        externalPreflight: async (body: any) => {
          const cwd = typeof body.cwd === 'string' ? await repoRoot(body.cwd) : undefined
          if (!cwd || typeof body.repository !== 'string') throw new Error('cwd and repository required')
          return ghPreflight(cwd, body.repository)
        },
        diagnostics: async (body: any) => {
          const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
          let gitAvailable = await commandAvailable('git', ['--version'])
          let repo = false
          if (gitAvailable && cwd) {
            try { await repoRoot(cwd); repo = true } catch {}
          }
          return {
            pluginVersion: packageVersion('@gilbertgt/dsh-plan-orchestrator') ?? 'unknown',
            dshVersion: packageVersion('@deepseek-ai/dsh-plan-mode'),
            dshRuntime: runtime.versions.join(', '),
            compatibility: compatibilityManifest(),
            nativePlanMode: hasService(scope, 'planMode'),
            sdkAvailable: packageVersion('@deepseek-ai/dsh-sdk-client') !== undefined,
            gitAvailable,
            gitRepository: repo,
            lspAvailable: hasService(scope, 'lsp'),
            ghAvailable: await commandAvailable('gh', ['--version']),
            settingsWritable: settings.writable(),
            storage: store.root,
            compatibilitySupported: runtime.supported,
            compatibilityDetail: runtime.detail,
            readOnlyDegraded: typeof body.sessionId === 'string' ? readOnly.degraded(body.sessionId) : undefined,
          }
        },
      })
    }).catch((error: any) => scope.logger?.error?.('plan-orchestrator RPC registration failed: %o', error))
    return () => { disposed = true; disposeTransport?.() }
  }, 'plan-orchestrator: rpc'))

  settings.watch(value => {
    if (!value.enabled) {
      void orchestration.cancelAll('Plan Orchestrator disabled in settings').catch((error: any) => c.logger?.warn?.('plan-orchestrator disable cancellation failed: %o', error))
      return
    }
    for (const role of Object.values(value.roles) as RoleRoute[]) {
      if (role.mode === 'fixed') void validateFixedRoute(c.llm, role).catch((error: any) => c.logger?.warn?.('plan-orchestrator fixed route unavailable: %s', error.message))
    }
  })
}
