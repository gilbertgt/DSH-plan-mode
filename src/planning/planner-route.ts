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
  const requested: ResolvedRoute = { provider: route.provider, model: route.model }
  if (route.reasoningEffort !== undefined) requested.reasoningEffort = route.reasoningEffort
  if (route.maxTokens !== undefined) requested.maxTokens = route.maxTokens
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
        ...(current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {}),
        ...(current.maxTokens !== undefined ? { maxTokens: current.maxTokens } : {}),
      }
    }
    return {
      provider: route.provider!,
      model: route.model!,
      ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(route.maxTokens !== undefined ? { maxTokens: route.maxTokens } : {}),
    }
  }
  return route.fallbacks[index - 1]
}

export function installPlannerRoute(
  ctx: any,
  getRoute: (agent: any) => RoleRoute,
  isPlanActive: (agent: any) => boolean,
  isEnabled: (agent: any) => boolean = () => true,
) {
  const fallbackIndex = new WeakMap<object, number>()

  const request = ctx.on('agent/request', async ({ agent }: any, next: any) => {
    const current = await next()
    if (!isEnabled(agent) || !isPlanActive(agent)) {
      fallbackIndex.delete(agent)
      return current
    }
    const route = getRoute(agent)
    const selected = routeAt(route, current, fallbackIndex.get(agent) ?? 0)
    if (!selected) return current
    await ctx.llm.resolveCallConfig(selected)
    // The routed request must not inherit the previous model's optional controls.
    // `reasoningEffort` is replaced outright (omitted when the route declares
    // none) so a fixed route cannot carry a stale effort to a model that does
    // not support it; `maxTokens` keeps its original fallback to the native
    // value when the route does not specify one. Neither may ever be written as
    // an explicit `undefined`, which the DSH lossless-JSON boundaries reject.
    const { reasoningEffort: _inheritedEffort, maxTokens: inheritedMaxTokens, ...rest } = current
    void _inheritedEffort
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort !== undefined ? { reasoningEffort: selected.reasoningEffort } : {}),
      ...(selected.maxTokens !== undefined
        ? { maxTokens: selected.maxTokens }
        : inheritedMaxTokens !== undefined
          ? { maxTokens: inheritedMaxTokens }
          : {}),
    }
  })

  const assembly = ctx.on('system-prompt/assemble', async (assembled: any, context: any, next: any) => {
    const result = await next()
    const agent = context?.agent
    if (!agent || !isEnabled(agent) || !isPlanActive(agent)) return result
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
    if (signal?.aborted || !isEnabled(agent) || !isPlanActive(agent) || !eligibleTransportFailure(failure)) return undefined
    const route = getRoute(agent)
    const currentIndex = fallbackIndex.get(agent) ?? 0
    const nextIndex = currentIndex + 1
    if (nextIndex > route.fallbacks.length) return undefined
    fallbackIndex.set(agent, nextIndex)
    return { kind: 'retry' as const }
  })

  const reset = ctx.on('agent/pre-step', async ({ agent }: any, next: any) => {
    const decision = await next()
    if (!isEnabled(agent) || !isPlanActive(agent)) fallbackIndex.delete(agent)
    return decision
  })

  return () => { request?.(); assembly?.(); requestError?.(); reset?.() }
}
