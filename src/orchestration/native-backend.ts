import type { RouteChoice } from '../contract/settings.ts'
import { ROLE_RESULT_SCHEMA, validateRoleResult, type RoleResult } from '../contract/role-result.ts'
import { usageFromSession, type UsageSample } from '../telemetry/usage.ts'
import { withRoleTimeout } from '../runtime-policy.ts'
import { snapshotDirty, deltaPaths } from '../git/fingerprints.ts'
import { assertOwnedPaths } from '../git/ownership.ts'
import { installChildOwnershipGuard } from './ownership-guard.ts'
import { installNativeChildRuntimeGuard } from './native-child-runtime.ts'
import { installNativeMutatingChildSandbox } from './native-child-policy.ts'
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

function isMaxTokensStop(reason: unknown): boolean {
  return String(reason ?? '').trim().toLowerCase().replaceAll('_', '-') === 'max-tokens'
}

function stopError(taskId: string, result: any): Error {
  const error = new Error(`subagent ${taskId} stopped: ${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''}`)
  ;(error as any).code = result.stopReason
  return error
}

function maxTokensContinuationPrompt(base: string): string {
  return `${base}\n\nMAX-TOKENS CONTINUATION (one retry only):\nThe previous Worker exhausted its output budget before returning the completion contract. The current owned working tree is authoritative and may already contain valid partial edits. Preserve those edits and finish only the remaining Plan-required work. Do not repeat planning, repository-baseline discovery, .git inspection, branch/HEAD/status checks, or already-completed reads. Inspect only assigned read/modify files needed to determine what remains, then return only the configured structured completion contract.`
}

function mergeNativeUsage(samples: UsageSample[], role: string, route: RouteChoice): UsageSample {
  if (samples.length === 0 || samples.some(sample => sample.source !== 'dsh-token-projection')) {
    return { role, provider: route.provider, model: route.model, source: 'unavailable' }
  }
  const total = (key: 'input'|'uncachedInput'|'cacheRead'|'cacheWrite'|'output'|'turns') => {
    const values = samples.map(sample => sample[key]).filter((value): value is number => typeof value === 'number')
    return values.length === samples.length ? values.reduce((sum, value) => sum + value, 0) : undefined
  }
  const pressures = samples.map(sample => sample.pressureTokens).filter((value): value is number => typeof value === 'number')
  return {
    role,
    input: total('input'),
    uncachedInput: total('uncachedInput'),
    cacheRead: total('cacheRead'),
    cacheWrite: total('cacheWrite'),
    output: total('output'),
    turns: total('turns'),
    provider: route.provider,
    model: route.model,
    pressureTokens: pressures.length > 0 ? Math.max(...pressures) : undefined,
    source: 'dsh-token-projection',
  }
}

/**
 * Resolve the conservative ownership-safe policy against the delegating
 * parent's effective DSH capability catalog. Preset deployments may keep every
 * model-facing tool on the parent agent's scope chain while the global catalog
 * is empty, and the spawned child joins that parent composition before DSH
 * applies its per-child toolFilter.
 */
export function resolveOwnershipSafeToolAllow(ctx: any, parent: any): string[] {
  const schemas = ctx?.tools?.schemas
  if (typeof schemas !== 'function') throw new Error('tools.schemas unavailable for ownership-safe tool filtering')
  if (!parent) throw new Error('parent agent unavailable for ownership-safe tool filtering')

  let catalog: unknown
  try {
    // DSH's agent-scoped schema view is the authoritative capability catalog
    // for tools the delegated child can inherit from this parent composition.
    catalog = schemas.call(ctx.tools, parent)
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
  if (allow.length === 0) throw new Error('no ownership-safe tools are available in the parent DSH profile')
  return [...allow]
}

export class NativeSpawnBackend{
  readonly ctx:any
  constructor(ctx:any){this.ctx=ctx}
  async run(req:NativeRunRequest):Promise<RoleExecutionResult>{
    const started=Date.now()
    let releaseRuntime=()=>{}
    let releaseOwnership=()=>{}
    const usageSamples:UsageSample[]=[]
    try{
      let logicalBaseline:Awaited<ReturnType<typeof snapshotDirty>>|undefined
      if(req.ownership){
        // Snapshot before the first attempt. A max-token continuation is only
        // permitted after the host proves every observed mutation is still
        // confined to the exact task ownership.
        logicalBaseline=await snapshotDirty(req.ownership.root)
        releaseRuntime=installNativeChildRuntimeGuard(this.ctx,req.parent,req.ownership.root)
        releaseOwnership=installChildOwnershipGuard(this.ctx,req.parent,req.ownership.root,req.ownership.paths)
      }
      const cwd=req.parent?.session?.header?.cwd
      const signal=req.ownership?withRoleTimeout(cwd,req.signal):req.signal
      // A mutating native role never receives shell/pwsh/run-code. Every exposed
      // mutation surface is one the ownership guard understands before execute.
      const toolFilter=req.ownership?{allow:resolveOwnershipSafeToolAllow(this.ctx,req.parent)}:req.toolFilter

      for(let attempt=0;attempt<2;attempt++){
        const sandboxScope=req.ownership?installNativeMutatingChildSandbox(this.ctx):undefined
        let run:any
        try{
          const prompt=attempt===0?req.prompt:maxTokensContinuationPrompt(req.prompt)
          run=await this.ctx.subagents.start('spawn',{
            label:`${req.role}:${req.taskId}${attempt===0?'':':continue'}`,
            prompt:[{type:'text',text:prompt}],
            parent:req.parent,
            signal,
            // Each retry gets its own call-scoped marker; the first marker was
            // consumed by the first child and must never be reused.
            agentOptions:sandboxScope?sandboxScope.mark(req.route):req.route,
            outputSchema:ROLE_RESULT_SCHEMA,
            maxDepth:1,
            toolFilter,
            persona:req.persona,
          })
          // Creation has completed and the exact child consumed the marker; no
          // later agent/created event needs this call-scoped listener.
          sandboxScope?.dispose()
          const result=await run.result
          if(run.localAgent)usageSamples.push(usageFromSession(this.ctx,req.role,run.localAgent,req.route))

          if(isMaxTokensStop(result.stopReason)&&attempt===0&&req.ownership&&logicalBaseline){
            const current=await snapshotDirty(req.ownership.root)
            const changed=deltaPaths(logicalBaseline,current)
            assertOwnedPaths(changed,req.ownership.paths)
            // The first child is disposed by finally before the fresh continuation
            // child starts. No background parent/child lifetime can leak across.
            continue
          }
          if(result.stopReason!=='completed')throw stopError(req.taskId,result)
          const valid=validateRoleResult(result.structured,req.taskId)
          const usage=mergeNativeUsage(usageSamples,req.role,req.route)
          usage.durationMs=Date.now()-started
          return{...valid,__usage:usage}
        }finally{
          try{if(run)await run.dispose()}finally{sandboxScope?.dispose()}
        }
      }
      throw new Error(`subagent ${req.taskId} exhausted max-token continuation budget`)
    }finally{
      try{releaseOwnership()}finally{releaseRuntime()}
    }
  }
}
