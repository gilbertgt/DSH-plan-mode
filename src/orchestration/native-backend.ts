import type { RouteChoice } from '../contract/settings.ts'
import { ROLE_RESULT_SCHEMA, validateRoleResult, type RoleResult } from '../contract/role-result.ts'
import { usageFromSession, type UsageSample } from '../telemetry/usage.ts'
import { withRoleTimeout } from '../runtime-policy.ts'
import { installChildOwnershipGuard } from './ownership-guard.ts'
export type RoleExecutionResult=RoleResult&{__usage?:UsageSample}
export interface NativeRunRequest{parent:any;role:'worker'|'integrator'|'reviewer';taskId:string;prompt:string;route:RouteChoice;signal:AbortSignal;persona?:string;toolFilter?:unknown;ownership?:{root:string;paths:string[]}}

const OWNERSHIP_SAFE_MUTATION_TOOLS = [
  'read','glob','grep','lsp','web_search','web_fetch',
  'write','write_file','edit','edit_file','delete','delete_file',
  'move','move_file','rename','rename_file','apply_patch','patch',
] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the conservative ownership-safe policy against the host's actual
 * global tool catalog. DSH rejects unknown names in tools.restrict(), so aliases
 * that are not registered in the active profile must never reach toolFilter.
 */
export function resolveOwnershipSafeToolAllow(ctx: any): string[] {
  const schemas = ctx?.tools?.schemas
  if (typeof schemas !== 'function') throw new Error('tools.schemas unavailable for ownership-safe tool filtering')

  let catalog: unknown
  try {
    // Omitted scope intentionally asks DSH for the global view, matching the
    // namespace that ToolRestriction allow-lists are permitted to name.
    catalog = schemas.call(ctx.tools)
  } catch (error) {
    throw new Error(`tools.schemas failed for ownership-safe tool filtering: ${errorMessage(error)}`)
  }
  if (!Array.isArray(catalog)) throw new Error('tools.schemas returned an invalid catalog for ownership-safe tool filtering')

  const registered = new Set<string>()
  for (const schema of catalog) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue
    const name = (schema as Record<string, unknown>).name
    if (typeof name === 'string' && name.length > 0) registered.add(name)
  }

  const allow = OWNERSHIP_SAFE_MUTATION_TOOLS.filter(name => registered.has(name))
  if (allow.length === 0) throw new Error('no ownership-safe global tools are registered in the active DSH profile')
  return [...allow]
}

export class NativeSpawnBackend{
  readonly ctx:any
  constructor(ctx:any){this.ctx=ctx}
  async run(req:NativeRunRequest):Promise<RoleExecutionResult>{
    const started=Date.now()
    const release=req.ownership?installChildOwnershipGuard(this.ctx,req.parent,req.ownership.root,req.ownership.paths):()=>{}
    let run:any
    try{
      const cwd=req.parent?.session?.header?.cwd
      const signal=req.ownership?withRoleTimeout(cwd,req.signal):req.signal
      // A mutating native role never receives shell/pwsh/run-code. Every exposed
      // mutation surface is one the ownership guard understands before execute.
      const toolFilter=req.ownership?{allow:resolveOwnershipSafeToolAllow(this.ctx)}:req.toolFilter
      run=await this.ctx.subagents.start('spawn',{
        label:`${req.role}:${req.taskId}`,
        prompt:[{type:'text',text:req.prompt}],
        parent:req.parent,
        signal,
        agentOptions:req.route,
        outputSchema:ROLE_RESULT_SCHEMA,
        maxDepth:1,
        toolFilter,
        persona:req.persona,
      })
      const result=await run.result
      if(result.stopReason!=='completed')throw new Error(`subagent ${req.taskId} stopped: ${result.stopReason}${result.diagnostic?`: ${result.diagnostic}`:''}`)
      const valid=validateRoleResult(result.structured,req.taskId)
      const usage=run.localAgent?usageFromSession(this.ctx,req.role,run.localAgent,req.route):{role:req.role,provider:req.route.provider,model:req.route.model,source:'unavailable' as const}
      usage.durationMs=Date.now()-started
      return{...valid,__usage:usage}
    }finally{
      try{if(run)await run.dispose()}finally{release()}
    }
  }
}
