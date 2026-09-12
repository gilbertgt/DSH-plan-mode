import { extractPlanArtifact, type PlanArtifact } from '../contract/plan-artifact.ts'
import { fullHead, repoRoot } from '../git/repository.ts'

export type RuntimeEnabled = (agent: any) => boolean
export interface StagedPlan { sessionId:string; toolCallId:string; plan:string; artifact:PlanArtifact; hash:string; baselineHead:string; stagedAt:string }
export class NativePlanBridge {
  #staged=new Map<string,StagedPlan>()
  key(sessionId:string, toolCallId:string){return `${sessionId}\0${toolCallId}`}
  stage(sessionId:string, toolCallId:string, plan:string, baselineHead:string, requireOwnership=true):StagedPlan {
    const {artifact,hash}=extractPlanArtifact(plan,requireOwnership); const staged={sessionId,toolCallId,plan,artifact,hash,baselineHead,stagedAt:new Date().toISOString()}
    this.#staged.set(this.key(sessionId,toolCallId),staged); return staged
  }
  get(sessionId:string,toolCallId:string){return this.#staged.get(this.key(sessionId,toolCallId))}
  consume(sessionId:string,toolCallId:string){const key=this.key(sessionId,toolCallId), value=this.#staged.get(key); if(value)this.#staged.delete(key); return value}
  clearSession(sessionId:string){for(const [k,v] of this.#staged)if(v.sessionId===sessionId)this.#staged.delete(k)}
}
export function installExitPlanValidator(ctx:any, bridge:NativePlanBridge, requireOwnership:()=>boolean, isEnabled:RuntimeEnabled=()=>true) {
  return ctx.on('tools/pre-execute', async (exec:any,next:any)=>{
    if(exec.name!=='exit_plan_mode') return next()
    if(!isEnabled(exec.agent)) return next()
    const agent=exec.agent; const sessionId=String(agent?.session?.id ?? '')
    if(!sessionId) return {kind:'deny',reason:'Plan Orchestrator: exit_plan_mode has no calling session.'}
    try { const root=await repoRoot(agent.session.header?.cwd??process.cwd()),head=await fullHead(root);bridge.stage(sessionId,String(exec.callId??''),String(exec.arguments?.plan ?? ''),head,requireOwnership()) }
    catch(error){ return {kind:'deny',reason:`Plan Orchestrator: invalid executable PlanArtifact/preflight: ${(error as Error).message}`} }
    return next()
  })
}

/** rc.1 exit_plan_mode succeeds only with the structured { approved: true } output. */
export function isNativePlanApproved(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const value = result as { isError?: boolean; value?: unknown }
  if (value.isError) return false
  return typeof value.value === 'object' && value.value !== null
    && (value.value as Record<string, unknown>).approved === true
}

/**
 * Every settled native exit consumes its staged candidate. Runtime disable is
 * checked before returning an approved artifact so toggling Enabled OFF while
 * the native approval UI is open can never produce a delayed handoff.
 */
export function consumeApprovedPlanResult(
  bridge: NativePlanBridge,
  exec: any,
  result: unknown,
  isEnabled: RuntimeEnabled = () => true,
): StagedPlan | undefined {
  if (exec?.name !== 'exit_plan_mode') return undefined
  const sessionId = String(exec.agent?.session?.id ?? '')
  const callId = String(exec.callId ?? '')
  const staged = bridge.consume(sessionId, callId)
  if (!isEnabled(exec.agent) || !staged || !isNativePlanApproved(result)) return undefined
  return staged
}
