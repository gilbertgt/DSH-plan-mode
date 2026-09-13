import type { RoleRoute } from './contract/settings.ts'
import { validateFixedRoute } from './planning/planner-route.ts'

/** Capability lookup budget; a slow adapter must not wedge the settings page. */
const CAPABILITY_TIMEOUT_MS = 10_000

export async function modelCatalog(ctx:any){const providers=ctx.llm.listProviders();return Promise.all(providers.map(async(p:any)=>{let models:any[]=[];let error:string|undefined;try{models=await ctx.llm.listModels(p.id)}catch(e){error=(e as Error).message}return{provider:{...p},models,error}}))}
export async function routeValidate(ctx:any,route:RoleRoute){return validateFixedRoute(ctx.llm,route)}

/**
 * Authoritative capability for one exact provider/model route.
 *
 * `listModels()` advertises a catalog entry, not a capability, so the only
 * trustworthy source is the owning adapter's `resolveModelInfo()` — it validates
 * and detaches the reasoning levels, the per-request output default and the
 * context window for that exact route.
 *
 * A capability that cannot be read is *reported*, never guessed: the caller
 * receives `unavailable` with no options, so the UI can offer only "Auto"
 * instead of inventing a model capability. This is why the failure path still
 * answers `ok: true` — it is a result, not a transport error.
 */
export async function modelCapability(ctx:any, input:{provider:string; model:string}) {
  const { provider, model } = input
  if (typeof ctx?.llm?.resolveModelInfo !== 'function') {
    return { provider, model, unavailable: 'DSH llm.resolveModelInfo is unavailable' }
  }
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, AbortSignal.timeout(CAPABILITY_TIMEOUT_MS))
    return {
      provider,
      model,
      // Only the capability fields cross the boundary; adapter-owned objects,
      // error details and anything else stay on the host side.
      ...(info?.reasoning === undefined ? {} : { reasoning: info.reasoning }),
      ...(info?.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
      ...(info?.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
    }
  } catch (error) {
    return { provider, model, unavailable: (error as Error)?.message ?? 'model capability lookup failed' }
  }
}
