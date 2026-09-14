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

/** One delegated child turn, as this backend needs to observe it. */
export interface NativeChildResult { stopReason?: unknown; structured?: unknown; diagnostic?: unknown; output?: unknown }
export interface NativeSpawnRequest { label: string; prompt: string; parent: any; signal: AbortSignal; route: RouteChoice; outputSchema: unknown; toolFilter: unknown; persona?: string }
export interface NativeSpawnHandle { result: Promise<NativeChildResult>; localAgent?: any; dispose(): Promise<void> }
/** How a native role obtains a delegated child; the default is `ctx.subagents.start('spawn')`. */
export type NativeSpawnFn = (request: NativeSpawnRequest) => Promise<NativeSpawnHandle>

let nativeSpawn: NativeSpawnFn | undefined

/**
 * Replace how native roles delegate their child.
 *
 * The default is DSH's in-process `spawn` provider, which requires a live model
 * provider. The production E2E lane must exercise the real ownership guard,
 * sandbox policy, mutation detection and contract retry, and a model provider is
 * the one input CI cannot legitimately supply; this seam keeps every other stage
 * real instead of stubbing the backend. The returned disposer restores the
 * default, and production callers never consult it.
 */
export function configureNativeSpawn(fn: NativeSpawnFn | undefined): () => void {
  const previous = nativeSpawn
  nativeSpawn = fn
  return () => { nativeSpawn = previous }
}

function defaultNativeSpawn(ctx: any): NativeSpawnFn {
  return async request => ctx.subagents.start('spawn', {
    label: request.label,
    prompt: [{ type: 'text', text: request.prompt }],
    parent: request.parent,
    signal: request.signal,
    agentOptions: request.route,
    outputSchema: request.outputSchema,
    maxDepth: 1,
    toolFilter: request.toolFilter,
    persona: request.persona,
  }) as Promise<NativeSpawnHandle>
}

const OWNERSHIP_SAFE_MUTATION_TOOLS = [
  'read','glob','grep','lsp','web_search','web_fetch',
  'write','write_file','edit','edit_file','delete','delete_file',
  'move','move_file','rename','rename_file','apply_patch','patch',
] as const

/**
 * Capabilities an independent read-only Reviewer may hold: file and web
 * *reading* only. `lsp` is a read-only capability and is listed here, but
 * membership in this list never means the tool exists — every candidate is
 * resolved against the live catalog before it is named to `tools.restrict()`.
 */
const READ_ONLY_REVIEW_TOOLS = ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch'] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMaxTokensStop(reason: unknown): boolean {
  return String(reason ?? '').trim().toLowerCase().replaceAll('_', '-') === 'max-tokens'
}

/** The child's final assistant text, bounded, for embedding in a diagnostic. */
function finalMessageExcerpt(result: any, limit = 400): string | undefined {
  const text = (Array.isArray(result?.output) ? result.output : [])
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => String(block.text ?? ''))
    .join('')
    .trim()
  if (!text) return undefined
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * A stop that is not `completed`.
 *
 * The reason alone is what DSH reports, and a bare `subagent X stopped: error`
 * names neither cause nor fix. DSH also flattens a post-turn failure to
 * `stopReason: 'error'` with no diagnostic, so this message additionally carries
 * whatever the child actually said; without it the run's failure account is
 * empty and the run cannot be diagnosed after the fact.
 */
function stopError(taskId: string, result: any): Error {
  const excerpt = finalMessageExcerpt(result)
  const error = new Error(
    `subagent ${taskId} stopped: ${result.stopReason}`
    + `${result.diagnostic ? `: ${result.diagnostic}` : ''}`
    + `${!result.diagnostic && excerpt ? `; final message: ${excerpt}` : ''}`,
  )
  ;(error as any).code = result.stopReason
  return error
}

/**
 * Whether an attempt ended without the requested structured capture in a shape
 * the one-shot retry may correct.
 *
 * DSH documents that `outputSchema` does not guarantee a capture, and it also
 * reports a post-turn failure that lost the capture as `stopReason: 'error'`
 * with an empty diagnostic — the exact shape the failed run 4429470e produced,
 * where the child completed its turn after a successful `write` and never
 * called the contract tool. Treating that as a transport stop surfaced the bare
 * `subagent X stopped: error` and skipped the corrective retry that exists for
 * this case, so both halves are accepted here. The retry gate still proves
 * ownership before any corrective child starts.
 */
function contractlessStop(result: any): boolean {
  if (result?.structured !== undefined) return false
  const reason = String(result?.stopReason ?? '').trim().toLowerCase()
  return reason === 'completed' || reason === 'error'
}

/**
 * A child that finished its turn without producing the requested structured
 * contract.
 *
 * DSH documents that requesting `outputSchema` does not guarantee a capture: a
 * child can end `stopReason: 'completed'` while `structured` is absent. Without
 * this check the run failed with the bare `subagent X stopped: error`, which
 * names neither the cause nor the fix. The message states the actual condition
 * and what the Worker must do, and carries a code the failover layer can
 * classify.
 */
function missingContractError(taskId: string, result: any): Error {
  const text = (Array.isArray(result?.output) ? result.output : [])
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => String(block.text ?? ''))
    .join('')
    .trim()
  const excerpt = text.length > 400 ? `${text.slice(0, 400)}…` : text
  const error = new Error(
    `subagent ${taskId} finished without returning the required structured completion contract`
    + `${result?.diagnostic ? ` (${result.diagnostic})` : ''}`
    + `${excerpt ? `; final message: ${excerpt}` : '; it produced no final message either'}`,
  )
  ;(error as any).code = 'missing-contract'
  return error
}

/**
 * The final shape of a contractless `error` stop: the retry already ran, so the
 * message must name both facts a reader needs — the contract was never captured
 * and the turn ended in `error` — instead of the bare stop reason.
 */
function contractlessStopError(taskId: string, result: any): Error {
  const excerpt = finalMessageExcerpt(result)
  const error = new Error(
    `subagent ${taskId} finished without returning the required structured completion contract`
    + ` (stop reason: ${String(result?.stopReason ?? 'unknown')}; the turn ended abnormally before the contract was captured)`
    + `${excerpt ? `; final message: ${excerpt}` : '; it produced no final message either'}`,
  )
  ;(error as any).code = 'missing-contract'
  return error
}

function maxTokensContinuationPrompt(base: string): string {
  return `${base}\n\nMAX-TOKENS CONTINUATION (one retry only):\nThe previous Worker exhausted its output budget before returning the completion contract. The current owned working tree is authoritative and may already contain valid partial edits. Preserve those edits and finish only the remaining Plan-required work. Do not repeat planning, repository-baseline discovery, .git inspection, branch/HEAD/status checks, or already-completed reads. Inspect only assigned read/modify files needed to determine what remains, then return only the configured structured completion contract.`
}

/**
 * Corrective prompt for a child that ended its turn without the structured
 * contract. It must not look like ordinary new work: the edits may already be
 * correct, and re-implementing them would risk duplicate or conflicting writes.
 */
function missingContractContinuationPrompt(base: string): string {
  return `${base}\n\nMISSING COMPLETION CONTRACT (one retry only):\nYour previous turn ended without calling the structured completion tool, so this run cannot tell what you did. The current owned working tree is authoritative and may already contain your valid edits.\nDo not redo completed work and do not redesign anything. Inspect only the assigned modify files to establish what is already correct, finish only what is genuinely missing, then return the configured structured completion contract as the single required tool call. If you are blocked, return that same contract with status BLOCKED and put the concrete blocker in remaining[].`
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
 * Resolve one candidate capability list against the delegating parent's
 * effective DSH capability catalog. Preset deployments may keep every
 * model-facing tool on the parent agent's scope chain while the global catalog
 * is empty, and the spawned child joins that parent composition before DSH
 * applies its per-child toolFilter.
 *
 * DSH's `tools.restrict()` FAILS CLOSED on a name it cannot find in the
 * inheriting scope's catalog: it throws
 * `tools.restrict() names unknown global tool "lsp"; known global tools: …`,
 * and the child is never created. A static allow-list therefore cannot be
 * copied into a filter verbatim — every name must be proven present first, and
 * the caller must drop the absent ones instead of asking DSH to bless them.
 * An empty *resolved* result stays fatal: a role that may hold nothing is a
 * configuration defect, not a silent read-only child.
 */
function resolveRegisteredToolAllow(ctx: any, parent: any, candidates: readonly string[], label: string): string[] {
  const schemas = ctx?.tools?.schemas
  if (typeof schemas !== 'function') throw new Error(`tools.schemas unavailable for ${label}`)
  if (!parent) throw new Error(`parent agent unavailable for ${label}`)

  let catalog: unknown
  try {
    // DSH's agent-scoped schema view is the authoritative capability catalog
    // for tools the delegated child can inherit from this parent composition.
    catalog = schemas.call(ctx.tools, parent)
  } catch (error) {
    throw new Error(`tools.schemas failed for ${label}: ${errorMessage(error)}`)
  }
  if (!Array.isArray(catalog)) throw new Error(`tools.schemas returned an invalid catalog for ${label}`)

  const registered = new Set<string>()
  for (const schema of catalog) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue
    const name = (schema as Record<string, unknown>).name
    if (typeof name === 'string' && name.length > 0) registered.add(name)
  }

  return candidates.filter(name => registered.has(name))
}

/** The exact ownership-safe tool set the parent composition actually exposes. */
export function resolveOwnershipSafeToolAllow(ctx: any, parent: any): string[] {
  const allow = resolveRegisteredToolAllow(ctx, parent, OWNERSHIP_SAFE_MUTATION_TOOLS, 'ownership-safe tool filtering')
  if (allow.length === 0) throw new Error('no ownership-safe tools are available in the parent DSH profile')
  return allow
}

/**
 * The exact read-only tool set an independent Reviewer child may hold.
 *
 * The Reviewer is a strictly read-only role, so its filter is an allow-list of
 * reading capabilities rather than a deny-list of mutators. Only capabilities
 * the parent composition really registers are named: a profile without an LSP
 * service has no `lsp` tool, and naming it would abort the whole review stage
 * with a `tools.restrict()` error instead of reviewing anything.
 */
export function resolveReviewerToolAllow(ctx: any, parent: any): string[] {
  const allow = resolveRegisteredToolAllow(ctx, parent, READ_ONLY_REVIEW_TOOLS, 'reviewer read-only tool filtering')
  if (allow.length === 0) throw new Error('no read-only tools are available in the parent DSH profile for the Reviewer role')
  return allow
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

      // Why the previous attempt is being retried, so the corrective prompt
      // addresses the actual failure instead of always assuming max-tokens.
      let retryReason: 'max-tokens' | 'missing-contract' | undefined
      for(let attempt=0;attempt<2;attempt++){
        const sandboxScope=req.ownership?installNativeMutatingChildSandbox(this.ctx):undefined
        let run:any
        try{
          const prompt=attempt===0
            ? req.prompt
            : retryReason==='missing-contract'
              ? missingContractContinuationPrompt(req.prompt)
              : maxTokensContinuationPrompt(req.prompt)
          run=await (nativeSpawn ?? defaultNativeSpawn(this.ctx))({
            label:`${req.role}:${req.taskId}${attempt===0?'':':continue'}`,
            prompt,
            parent:req.parent,
            signal,
            // Each retry gets its own call-scoped marker; the first marker was
            // consumed by the first child and must never be reused.
            route:sandboxScope?sandboxScope.mark(req.route):req.route,
            outputSchema:ROLE_RESULT_SCHEMA,
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
            retryReason='max-tokens'
            continue
          }
          if(result.stopReason!=='completed'&&!contractlessStop(result))throw stopError(req.taskId,result)
          // A turn that ended without a structured capture is not a provider
          // fault: the child never called the contract tool (or DSH lost the
          // capture and flattened the turn to `error`). One corrective retry is
          // safe under the same ownership proof the max-token lane uses, and it
          // converts an opaque run failure into either success or a real
          // diagnosis.
          if(result.structured===undefined&&attempt===0&&req.ownership&&logicalBaseline){
            const current=await snapshotDirty(req.ownership.root)
            const changed=deltaPaths(logicalBaseline,current)
            assertOwnedPaths(changed,req.ownership.paths)
            retryReason='missing-contract'
            continue
          }
          if(result.structured===undefined)throw result.stopReason==='completed'
            ? missingContractError(req.taskId,result)
            : contractlessStopError(req.taskId,result)
          const valid=validateRoleResult(result.structured,req.taskId)
          const usage=mergeNativeUsage(usageSamples,req.role,req.route)
          usage.durationMs=Date.now()-started
          return{...valid,__usage:usage}
        }finally{
          try{if(run)await run.dispose()}finally{sandboxScope?.dispose()}
        }
      }
      throw new Error(`subagent ${req.taskId} exhausted its one-retry continuation budget (${retryReason ?? 'unknown'})`)
    }finally{
      try{releaseOwnership()}finally{releaseRuntime()}
    }
  }
}
