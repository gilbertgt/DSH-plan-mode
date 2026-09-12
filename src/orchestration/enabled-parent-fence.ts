import type { OrchestrationService } from './service.ts'

/**
 * Runtime-gated parent fence. The plugin may stay installed while Enabled is
 * toggled live, so every event must re-check the current effective setting.
 * A pending approved handoff is cancelled when disabled to prevent a stale
 * plan from launching if the user later turns the plugin back on.
 */
export function installEnabledParentFence(
  ctx: any,
  service: OrchestrationService,
  isEnabled: (agent: any) => boolean,
) {
  const cancelPending = async (agent: any) => {
    const sessionId = String(agent?.session?.id ?? '')
    if (!sessionId || !service.shouldFence(sessionId)) return
    const runId = service.activeRun(sessionId)
    if (runId) await service.cancel(runId)
  }

  const preStep = ctx.on('agent/pre-step', async ({ agent }: any, next: any) => {
    if (!isEnabled(agent)) {
      await cancelPending(agent)
      return next()
    }
    const sessionId = String(agent.session.id)
    if (!service.shouldFence(sessionId)) return next()
    await next()
    return { kind: 'reject' as const }
  }, { prepend: true })

  const status = ctx.on('agent/status', ({ agent, status }: any) => {
    if (!isEnabled(agent)) {
      void cancelPending(agent).catch((error: any) => {
        ctx.logger?.warn?.('plan-orchestrator pending handoff cleanup failed: %o', error)
      })
      return
    }
    if (status === 'idle') void service.onParentIdle(String(agent.session.id)).catch((error: any) => {
      ctx.logger?.error?.('plan-orchestrator maintenance launch failed: %o', error)
    })
  })

  return () => { preStep?.(); status?.() }
}
