import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
import { configureValidationShell } from './validation/runner.ts'
import { configureRoleTimeoutResolver } from './runtime-policy.ts'
import type { RoleRoute } from './contract/settings.ts'

export const name = 'plan-orchestrator'
export const inject = ['settings', 'tools', 'llm', 'sessions', 'subagents', 'systemPrompt', 'sandboxPolicy', 'sessionProjections', 'shell']

const execFileP = promisify(execFile)
const require = createRequire(import.meta.url)

function packageVersion(id: string): string | undefined {
  try { return require(`${id}/package.json`).version }
  catch { return undefined }
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try { await execFileP(command, args, { windowsHide: true, timeout: 5_000 }); return true }
  catch { return false }
}

function hasService(ctx: any, name: string): boolean {
  try { return ctx.get?.(name) !== undefined }
  catch { return false }
}

export function apply(ctx: Context) {
  const c = ctx as any
  const settings = registerSettings(c)
  const bridge = new NativePlanBridge()
  const readOnly = new PlannerReadOnlyGuard()
  const store = new RunStore()
  c.sessionProjections.register(planOrchestratorProjectionDefinition)

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

  // Runtime seams are bound explicitly and fail closed. Validation has no
  // child_process fallback; mutating child roles receive the live timeout.
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

  // Wrap native plan-mode's pre-step handling: downstream first commits the
  // selected plan state, then we enforce/restore the file sandbox before the request.
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
    // Do NOT restore read-only here. Native plan-mode commits plan/mode=off at
    // the next pre-step; the parent fence lets that commit happen then rejects.
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
      // Cleanup only: remove state previously owned by the plugin, then leave
      // native Plan Mode untouched while Plan Orchestrator is disabled.
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

  // Human command plane; absent command service is an allowed non-interactive composition.
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
        runList: ({ sessionId }: any) => orchestration.list(sessionId),
        runDetail: ({ runId }: any) => orchestration.detail(runId),
        runCancel: ({ runId }: any) => orchestration.cancel(runId),
        runResume: ({ runId }: any) => settings.get().recovery.allowSafeResume
          ? orchestration.resume(runId)
          : Promise.resolve({ ok: false, reason: 'Safe resume is disabled in Settings → Plan Mode.' }),
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
            pluginVersion: '1.0.0',
            dshVersion: packageVersion('@deepseek-ai/dsh-plan-mode'),
            compatibility: { supported: ['0.1.5-rc.1'], preview: ['0.1.5-rc.2'] },
            nativePlanMode: hasService(scope, 'planMode'),
            sdkAvailable: packageVersion('@deepseek-ai/dsh-sdk-client') !== undefined,
            gitAvailable,
            gitRepository: repo,
            lspAvailable: hasService(scope, 'lsp'),
            ghAvailable: await commandAvailable('gh', ['--version']),
            settingsWritable: settings.writable(),
            storage: store.root,
            readOnlyDegraded: typeof body.sessionId === 'string' ? readOnly.degraded(body.sessionId) : undefined,
          }
        },
      })
    }).catch((error: any) => scope.logger?.error?.('plan-orchestrator RPC registration failed: %o', error))
    return () => { disposed = true; disposeTransport?.() }
  }, 'plan-orchestrator: rpc'))

  // Validate persisted routes when enabled. Disabling is also a hard runtime
  // cancellation boundary, independent of the next agent event.
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
