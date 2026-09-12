import type { OrchestrationService } from './service.ts'

/**
 * Runtime-gated parent fence. Enabled OFF is a hard execution boundary: every
 * event re-checks settings, pending and active plugin-owned runs are cancelled,
 * then the native DSH flow is allowed through unchanged.
 */
export function installEnabledParentFence(
  ctx: any,
  service: OrchestrationService,
  isEnabled: (agent: any) => boolean,
) {
  const cancelOwnedRun = async (agent: any) => {
    const sessionId = String(agent?.session?.id ?? '')
    if (!sessionId) return
    await service.cancelSession(sessionId, 'Plan Orchestrator disabled')
  }

  const preStep = ctx.on('agent/pre-step', async ({ agent }: any, next: any) => {
    if (!isEnabled(agent)) {
      await cancelOwnedRun(agent)
      return next()
    }
    const sessionId = String(agent.session.id)
    if (!service.shouldFence(sessionId)) return next()
    await next()
    return { kind: 'reject' as const }
  }, { prepend: true })

  const status = ctx.on('agent/status', ({ agent, status }: any) => {
    if (!isEnabled(agent)) {
      void cancelOwnedRun(agent).catch((error: any) => {
        ctx.logger?.warn?.('plan-orchestrator run cleanup after disable failed: %o', error)
      })
      return
    }
    if (status === 'idle') void service.onParentIdle(String(agent.session.id)).catch((error: any) => {
      ctx.logger?.error?.('plan-orchestrator maintenance launch failed: %o', error)
    })
  })

  return () => { preStep?.(); status?.() }
}
