import type { RoleRoute, RouteChoice } from '../contract/settings.ts'
import { eligibleTransportFailure } from '../orchestration/failover.ts'

export interface ResolvedRoute {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

export async function validateFixedRoute(llm: any, route: RoleRoute): Promise<ResolvedRoute> {
  if (route.mode === 'current') return {}
  if (!route.provider || !route.model) throw new Error('fixed route needs provider and model')
  const requested = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
  }
  if (typeof llm?.resolveCallConfig !== 'function') throw new Error('DSH llm.resolveCallConfig is unavailable')
  await llm.resolveCallConfig(requested)
  for (const fallback of route.fallbacks) await llm.resolveCallConfig(fallback)
  return requested
}

function routeAt(route: RoleRoute, current: any, index: number): RouteChoice | undefined {
  if (index === 0) {
    if (route.mode === 'current') {
      if (!current?.provider || !current?.model) return undefined
      return {
        provider: current.provider,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        maxTokens: current.maxTokens,
      }
    }
    return {
      provider: route.provider!,
      model: route.model!,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
    }
  }
  return route.fallbacks[index - 1]
}

export function installPlannerRoute(ctx: any, getRoute: (agent: any) => RoleRoute, isPlanActive: (agent: any) => boolean) {
  const fallbackIndex = new WeakMap<object, number>()

  const request = ctx.on('agent/request', async ({ agent }: any, next: any) => {
    const current = await next()
    if (!isPlanActive(agent)) {
      fallbackIndex.delete(agent)
      return current
    }
    const route = getRoute(agent)
    const selected = routeAt(route, current, fallbackIndex.get(agent) ?? 0)
    if (!selected) return current
    await ctx.llm.resolveCallConfig(selected)
    return {
      ...current,
      provider: selected.provider,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort,
      maxTokens: selected.maxTokens ?? current.maxTokens,
    }
  })

  const assembly = ctx.on('system-prompt/assemble', async (assembled: any, context: any, next: any) => {
    const result = await next()
    const agent = context?.agent
    if (!agent || !isPlanActive(agent)) return result
    const route = getRoute(agent)
    const current = { ...agent.options }
    const selected = routeAt(route, current, fallbackIndex.get(agent) ?? 0)
    if (!selected) return result
    return {
      ...result,
      variables: {
        ...result.variables,
        model: selected.model,
        provider: selected.provider,
      },
    }
  })

  const requestError = ctx.on('agent/request-error', async (payload: any, next: any) => {
    const downstream = await next()
    if (downstream !== undefined) return downstream
    const { agent, failure, signal } = payload
    if (signal?.aborted || !isPlanActive(agent) || !eligibleTransportFailure(failure)) return undefined
    const route = getRoute(agent)
    const currentIndex = fallbackIndex.get(agent) ?? 0
    const nextIndex = currentIndex + 1
    if (nextIndex > route.fallbacks.length) return undefined
    fallbackIndex.set(agent, nextIndex)
    return { kind: 'retry' as const }
  })

  const reset = ctx.on('agent/pre-step', async ({ agent }: any, next: any) => {
    const decision = await next()
    if (!isPlanActive(agent)) fallbackIndex.delete(agent)
    return decision
  })

  return () => { request?.(); assembly?.(); requestError?.(); reset?.() }
}
